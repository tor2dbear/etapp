#!/usr/bin/env node
// Harvest every source repo's roadmap into one aggregate, and emit:
//   data/roadmap.json  — canonical machine-readable truth (for tools & agents)
//   data/roadmap.js    — the same payload as `window.__ROADMAP__`, so index.html
//                        renders straight off the filesystem (no server needed)
//   ROADMAP.md         — a flat, greppable digest grouped by status
//
// Backends (chosen per repo in lib/repo.mjs): a local checkout when
// ROADMAP_LOCAL_ROOT points at one, otherwise the GitHub API + raw endpoints.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRepo } from "./lib/repo.mjs";
import { harvestSource, STATUSES, slugify } from "./lib/adapters.mjs";
import { itemKey, refKey } from "./lib/frontmatter.mjs";

// Where the instance's own config and output live. Normally the repo this script
// sits in; ROADMAP_ROOT points it at a different tree, which is how the demo board
// is built — the fixture gets its own sources.json and board.config.json and is
// harvested by *this* code rather than by a second implementation of it.
const ROOT = process.env.ROADMAP_ROOT
  ? path.resolve(process.env.ROADMAP_ROOT)
  : path.resolve(fileURLToPath(import.meta.url), "../..");
const BUILT_AT = process.env.ROADMAP_BUILT_AT || new Date().toISOString();
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

// Real-world signal for auto-status: the open/closed state of a puck's linked
// issue (or PR — the issues endpoint covers both). Returns "open"/"closed", or
// null when there's no signal (unlinked, network down, deleted). Kept discrete
// on purpose: the payload changes only when an issue actually flips state, so it
// doesn't defeat the harvester's idempotency. The board derives the human-facing
// flags (including date-relative staleness) live from this + `updated`.
async function fetchIssueState(repo, issue) {
  try {
    const headers = { "User-Agent": "roadmap-aggregator", Accept: "application/vnd.github+json" };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return data.state === "closed" ? "closed" : "open";
  } catch {
    return null;
  }
}

const STATUS_LABEL = {
  now: "Now",
  next: "Next",
  later: "Later",
  inbox: "Inbox",
  done: "Done",
  cancelled: "Cancelled",
};

// Terminal statuses — a puck here is settled, so it's exempt from drift/staleness.
// term:begin
const TERMINAL = new Set(["done", "cancelled"]);
// term:end

// Auto-status thresholds (days). A now/next puck untouched past these is "quiet".
const STALE_DAYS = { now: 21, next: 60 };

// Priority glyphs for the flat digest (discrete, so ROADMAP.md stays idempotent).
const PRIORITY_MARK = { urgent: "‼ ", high: "↑ ", medium: "→ ", low: "↓ " };

function daysSince(dateStr, nowMs) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr + "T00:00:00Z");
  if (isNaN(t)) return null;
  return Math.floor((nowMs - t) / 86400000);
}

// Real-world drift signals, computed centrally so the JSON, the digest and the
// board all read the same thing (no client-side split-brain). Each signal is a
// DISCRETE type — never a day count — so the payload only changes when a flag
// actually flips, which keeps the harvest idempotent. The board turns a `stale`
// flag into a live "N days" string for display.
function computeSignals(item, nowMs, cycles, depCycles) {
  const out = [];
  const ds = daysSince(item.updated, nowMs);
  if ((item.status === "now" || item.status === "next") && ds != null && ds > STALE_DAYS[item.status]) {
    out.push({ type: "stale" });
  }
  // A named parent that didn't resolve is either a typo or a loop — two different
  // fixes, so two different flags rather than one that guesses wrong.
  if (item.parent && !item.parentRef) {
    out.push({ type: cycles.has(item) ? "parent-cycle" : "parent-missing" });
  }
  // A dependency that names nothing is a broken promise: the board would show the
  // puck as ready when its author thinks it's blocked. Same split as the etapp
  // links — a typo and a loop are two different fixes.
  if ((item.missingDepends || []).length) out.push({ type: "depends-missing" });
  if (depCycles.has(item)) out.push({ type: "dependency-cycle" });
  if (item.issueState === "closed" && !TERMINAL.has(item.status)) out.push({ type: "issue-closed" });
  if (item.issueState === "open" && item.status === "done") out.push({ type: "issue-open" });
  // An etapp's own status and its parts can disagree, exactly the way a puck and
  // its linked issue can — so the same pair of flags, for the same reason. Found by
  // dog-fooding: `productize` sat at done with 2 of 3 parts landed and the board
  // said nothing, because nothing was ever asked to compare the two.
  // Computed after resolveHierarchy(), which is where `progress` is derived.
  if (item.progress && item.progress.total) {
    const closed = item.progress.done === item.progress.total;
    if (TERMINAL.has(item.status) && !closed) out.push({ type: "rollup-open" });
    if (!TERMINAL.has(item.status) && closed) out.push({ type: "rollup-done" });
  }
  // The horizon has passed and the puck hasn't landed. Same shape as the others —
  // a flag for a human to resolve, never a rewrite of the source.
  if (item.target && !TERMINAL.has(item.status)) {
    const dt = daysSince(item.target, nowMs);
    if (dt != null && dt > 0) out.push({ type: "target-passed" });
  }
  return out;
}

// One reference form for every puck-to-puck link, and it is `format.js` that says what
// it is — the same file that owns every other question about how a puck's values are
// spelled, reached from Node through `lib/frontmatter.mjs` and from the browser as a
// classic script. It used to be written out here, again in app.js, and twice more in the
// CLI, with an argument order that did not even match between the first two.
//
// dep:begin
// First wins, because the board's `resolveRef()` returns the first match and two pucks
// with one (repo, slug) would otherwise resolve to different pucks on the two sides —
// reachable with `roadmap/foo.md` beside `roadmap/foo/README.md`. Neither answer is
// right; agreeing is, and the pair shows up as a duplicate slug either way.
function indexByRef(items) {
  const byKey = new Map();
  for (const it of items) if (!byKey.has(itemKey(it.repo, it.slug))) byKey.set(itemKey(it.repo, it.slug), it);
  return byKey;
}

// Resolve each puck's `depends` into `blockedBy` — everything it declared that
// isn't settled yet, so **empty means ready** and one field answers "what can I
// start?". Resolved blockers appear as ids; a reference that names nothing stays
// as written, because an unknown blocker is not a settled one: dropping it would
// advertise the puck as ready while its author believes it's blocked.
//
// `blocks` is the exact mirror — x.blocks contains y iff y.blockedBy contains x —
// derived rather than authored so no `blocks:` field can ever disagree with a
// `depends:` one. A settled puck waits for nothing, so its edges count in neither
// direction.
//
// Cycles are found over the *authored* graph (status-independent, so a loop is a
// loop whatever the pucks' states) and flagged, never cut: unlike an etapp parent
// no single link is the wrong one, so a human picks. A puck that depends on itself
// is that same error with one node — kept, so it blocks itself and shows up.
function resolveBlockedBy(items) {
  const byKey = indexByRef(items);
  const edges = new Map();   // puck → the pucks it depends on, resolved
  const unknown = new Map(); // puck → the references that named nothing

  for (const it of items) {
    it.blocks = [];
    it.missingDepends = [];
    // Two spellings of one reference are one edge. `auth` and `me/repo#auth` name the
    // same puck from inside `me/repo`, and counting both put its id in `blockedBy`
    // twice and this puck's id in its `blocks` twice — the blocker drawn twice, and
    // every count of them off by one. The board's editor already refuses to write the
    // second spelling; pucks are plain markdown that anything may write, so the reader
    // has to hold the rule too. Deduped by key, which is what "the same reference"
    // means here, so an unresolvable pair collapses the same way.
    const deps = [];
    const seen = new Set();
    for (const dep of it.depends || []) {
      const key = refKey(dep, it.repo);
      if (seen.has(key)) continue;
      seen.add(key);
      const d = byKey.get(key);
      if (!d) it.missingDepends.push(dep);
      else deps.push(d);
    }
    edges.set(it, deps);
    unknown.set(it, it.missingDepends);
  }
  for (const it of items) {
    if (TERMINAL.has(it.status)) { it.blockedBy = []; continue; } // landed: waits for nothing
    const live = edges.get(it).filter((d) => !TERMINAL.has(d.status));
    it.blockedBy = live.map((d) => d.id).concat(unknown.get(it));
    for (const d of live) d.blocks.push(it.id);
  }
  for (const it of items) it.blocks.sort();

  // Every puck that can reach itself. This was a back-edge walk, which flags only the
  // pucks on the path that happened to close the loop: with `r → a → u → r` and a second
  // way round, `r → v → u`, the puck `v` waits for itself just as much and was never
  // flagged. Measured, and the judge missed it too until it stopped being a
  // transliteration of this.
  //
  // A strongly connected component is that question asked properly: a component of more
  // than one puck is exactly a set of pucks that all wait for each other, whichever way
  // round you enter it. A lone puck is in a loop only if it names itself.
  //
  // Tarjan, iterative — a chain of pucks would otherwise be a chain of stack frames, and
  // a deep roadmap should not be able to end the harvest with an overflow.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const pending = [];
  const cycles = new Set();
  let counter = 0;
  for (const root of items) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const node = frame[0];
      if (frame[1] === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        pending.push(node);
        onStack.add(node);
      }
      const deps = edges.get(node);
      if (frame[1] < deps.length) {
        const d = deps[frame[1]++];
        if (!index.has(d)) work.push([d, 0]);
        else if (onStack.has(d)) low.set(node, Math.min(low.get(node), index.get(d)));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        let popped;
        do {
          popped = pending.pop();
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== node);
        if (component.length > 1) for (const c of component) cycles.add(c);
        else if (deps.includes(node)) cycles.add(node);
      }
    }
  }
  return cycles;
}
// dep:end

// Resolve `parent` into the derived half of the hierarchy: who my children are,
// and how far the etapp has come. Derived, never stored — a `children:` field
// could disagree with the `parent:` fields, and two truths is the one thing this
// product doesn't do.
//
// A cycle (a → b → a, or a puck naming itself) would make progress meaningless
// and could hang a renderer, so it's cut here and flagged for a human.
function resolveHierarchy(items) {
  const byKey = indexByRef(items);
  const keyOf = (it) => itemKey(it.repo, it.slug);
  const cycles = new Set(); // pucks whose link was cut, so the flag can say why

  for (const it of items) {
    it.parentRef = null; // resolved id of the parent, or null
    it.children = [];    // ids of the pucks that name me
    it.progress = null;  // { done, total } once a puck has children
  }
  const parentOf = new Map();
  for (const it of items) {
    if (!it.parent) continue;
    const key = refKey(it.parent, it.repo);
    if (key === keyOf(it)) { cycles.add(it); continue; } // no puck is its own etapp
    const p = byKey.get(key);
    if (p) parentOf.set(it, p);      // an unresolvable parent is flagged instead
  }
  // Walk up from each puck; a chain that revisits one is a cycle. Cut the link at
  // the puck that closes it, so the rest of the tree still resolves.
  for (const it of items) {
    const seen = new Set([keyOf(it)]);
    let cur = parentOf.get(it);
    while (cur) {
      const k = keyOf(cur);
      if (seen.has(k)) { parentOf.delete(it); cycles.add(it); break; }
      seen.add(k);
      cur = parentOf.get(cur);
    }
  }
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const [child, p] of parentOf) {
    child.parentRef = p.id;
    p.children.push(child.id);
  }
  for (const it of items) it.children.sort(); // stable output — the board sorts them for display
  // `progress` counts **direct** children, and the composition is the reason. A
  // sub-parent carries its own count and answers for its own subtree, so the numbers
  // stay readable at every depth: a reader who sees `3/5` can descend into the member
  // that says `1/3` and the arithmetic is visible.
  //
  // Counting the whole subtree was tried and reverted, because it broke three things at
  // once. The `Contains` list on a puck page shows direct members, so a badge counting
  // the subtree sat above a list it disagreed with — five rows under `3/8`. And the
  // drift signals got *less* precise, which was the opposite of the intent: measured on
  // `root done → mid done → grandchild next`, direct counting flags `mid` alone, which
  // is the puck whose own claim is false. The subtree count flags `root` as well, for a
  // lie it did not tell — it said its one part was done, and that part says so itself.
  //
  // The case that motivated the attempt — a root reporting `0/1` while three pucks sit
  // under its one child — is not a silence. It is the drift landing on the member that
  // owns it, one level down, where the fix belongs.
  for (const it of items) {
    if (!it.children.length) continue;
    const kids = it.children.map((id) => byId.get(id)).filter(Boolean);
    it.progress = {
      done: kids.filter((k) => TERMINAL.has(k.status)).length,
      total: kids.length,
    };
  }
  return cycles;
}

function sortItems(a, b) {
  // Manual `order` first (lower = higher), then freshest `updated`, then title.
  // `??` alone was not enough: it catches null and undefined but passes NaN straight
  // through, and a comparator that returns NaN is read as 0 — so one puck with a
  // junk `order` silently reordered *other* pucks, differently depending on the order
  // they arrived in. The adapters now normalize `order` to a finite number or null;
  // this keeps the comparator total whatever reaches it.
  const ao = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
  const bo = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  if (a.updated !== b.updated) return (b.updated || "").localeCompare(a.updated || "");
  return a.title.localeCompare(b.title);
}

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, "sources.json"), "utf8"));
  const defaultBranch = config.defaultBranch || "main";
  // Deploy-your-own config (title/description/repoUrl). Optional — the board and
  // digest fall back to sensible defaults so a fresh clone still renders.
  const boardCfg = (await readJsonIfExists(path.join(ROOT, "board.config.json"))) || {};

  const sources = [];
  const items = [];

  for (const source of config.sources) {
    const branch = source.branch || defaultBranch;
    const repo = await openRepo(source.repo, branch);
    let harvested = [];
    let error = null;
    try {
      harvested = await harvestSource(repo, branch, source);
    } catch (err) {
      error = err.message;
      console.error(`  ! ${source.repo}: ${error}`);
    }

    const short = source.repo.split("/").pop();
    for (const it of harvested) {
      items.push({
        id: `${short}/${it.slug}`,
        repo: source.repo,
        repoName: source.name || short,
        repoColor: source.color || "#888888",
        issueState: null,
        ...it,
      });
    }

    sources.push({
      repo: source.repo,
      name: source.name || short,
      blurb: source.blurb || "",
      color: source.color || "#888888",
      url: `https://github.com/${source.repo}`,
      adapter: source.adapter,
      backend: repo.backend,
      count: harvested.length,
      native: harvested.every((h) => h.native) && harvested.length > 0,
      error,
    });

    console.error(
      `  · ${source.repo} [${source.adapter}/${repo.backend}] → ${harvested.length} items`,
    );
  }

  // Safety: never overwrite a good board with an empty one. If every configured
  // source failed (network down, all backends errored), fail loudly instead of
  // deploying a blank roadmap.
  if (config.sources.length > 0 && items.length === 0) {
    throw new Error(
      "Harvest produced 0 items from " +
        config.sources.length +
        " configured sources — refusing to overwrite existing data. See errors above.",
    );
  }

  // The same safety one level down. The guard above only fires when *every* source
  // failed, which is the rare shape; one source going quiet is the common one, and it
  // republished the board without that repo's pucks. Everything pointing into it —
  // every cross-repo `parent` and `depends` — then resolved to nothing and committed
  // a false `parent-missing` / `depends-missing`, while the digest read an untroubled
  // "0 items".
  //
  // The test is the count, not whether anything threw. Keying on `error` looked
  // stricter and caught almost nothing: `repo.list()` answers a 404 with `[]` and a
  // missing local directory with `[]`, so a repo gone private, a renamed default
  // branch and a moved `roadmap/` — the ways this actually happens — all arrive as a
  // clean zero. A source that had pucks last run and has none now is the thing worth
  // refusing, however quietly it got there.
  //
  // A repo that has legitimately emptied its roadmap trips this too, which is the
  // right way round: that is a person's decision to confirm, not a silent one to
  // discover later, and the message says how.
  const prev = await readJsonIfExists(path.join(ROOT, "data", "roadmap.json"));
  const regressed = sources.filter((s) => {
    if (s.count > 0) return false;
    const before = prev && (prev.sources || []).find((p) => p.repo === s.repo);
    return Boolean(before && before.count > 0);
  });
  if (regressed.length) {
    throw new Error(
      "Refusing to overwrite existing data: " +
        regressed
          .map((s) => `${s.repo} (${s.error || "no error — the source returned no pucks"})`)
          .join("; ") +
        " — harvested 0 items but had items in the previous run.\n" +
        "If a source has genuinely emptied its roadmap, drop it from sources.json or " +
        "let the next run through once its data/roadmap.json entry is gone.",
    );
  }

  // Reconcile pucks that link an issue against its real GitHub state.
  // ROADMAP_ISSUE_STATES names a JSON file of {"owner/repo#123": "open"|"closed"} and
  // answers from it instead of the network. A seam for fixtures, not an authoring path:
  // issueState stays derived — it is only the *source* that is stubbed, the same shape
  // as ROADMAP_LOCAL_ROOT standing in for the GitHub API. Fictional repos have no
  // issues to ask about, and without this the demo silently loses both drift signals.
  const issueStub = process.env.ROADMAP_ISSUE_STATES
    ? JSON.parse(await readFile(path.resolve(process.env.ROADMAP_ISSUE_STATES), "utf8"))
    : null;
  const linked = items.filter((it) => it.issue != null);
  if (linked.length) {
    await Promise.all(
      linked.map(async (it) => {
        it.issueState = issueStub
          ? issueStub[`${it.repo}#${it.issue}`] ?? null
          : await fetchIssueState(it.repo, it.issue);
      }),
    );
    const known = linked.filter((it) => it.issueState).length;
    console.error(`  · reconciled ${known}/${linked.length} linked issue(s)`);
  }

  // Resolve the cross-item relations first, then derive drift signals once.
  const depCycles = resolveBlockedBy(items);
  const cycles = resolveHierarchy(items);
  const nowMs = Date.parse(BUILT_AT) || Date.now();
  for (const it of items) it.signals = computeSignals(it, nowMs, cycles, depCycles);
  const flaggedCount = items.filter((it) => it.signals.length).length;
  if (flaggedCount) console.error(`  · ${flaggedCount} item(s) need attention`);

  items.sort(sortItems);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;

  const payload = {
    generatedAt: BUILT_AT,
    config: boardCfg,
    statuses: STATUSES,
    counts,
    total: items.length,
    sources,
    items,
  };

  // Idempotency: if the harvested content is identical to what's already on
  // disk (everything except the timestamp), keep the previous generatedAt so the
  // output is byte-for-byte unchanged. Otherwise the hourly sync would commit a
  // new timestamp every run and spam history with no-op changes.
  if (prev && sameContent(prev, payload)) {
    payload.generatedAt = prev.generatedAt;
  }

  await mkdir(path.join(ROOT, "data"), { recursive: true });
  await writeFile(
    path.join(ROOT, "data", "roadmap.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  await writeFile(
    path.join(ROOT, "data", "roadmap.js"),
    "// Generated by scripts/harvest.mjs — do not edit by hand.\n" +
      "window.__ROADMAP__ = " +
      JSON.stringify(payload) +
      ";\n",
  );
  await writeFile(path.join(ROOT, "ROADMAP.md"), renderDigest(payload));

  console.error(
    `\n✓ ${items.length} items from ${sources.length} repos → data/roadmap.json, data/roadmap.js, ROADMAP.md`,
  );
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// Compare two payloads ignoring the generatedAt timestamp.
function sameContent(a, b) {
  const strip = (p) => JSON.stringify({ ...p, generatedAt: null });
  return strip(a) === strip(b);
}

function renderDigest(payload) {
  const date = payload.generatedAt.slice(0, 10);
  const lines = [
    `# ${(payload.config && payload.config.title) || "Roadmap"} — aggregated view`,
    "",
    "<!-- GENERATED by scripts/harvest.mjs from the source repos below. Do not edit by",
    "     hand: your changes will be overwritten on the next sync. Edit the roadmap in",
    "     the source repo instead. -->",
    "",
    `_Generated ${date} · ${payload.total} items across ${payload.sources.length} repos._`,
    "",
    "## Sources",
    "",
  ];
  for (const s of payload.sources) {
    const kind = s.native ? "native pucks" : `adapted (${s.adapter})`;
    lines.push(`- **[${s.name}](${s.url})** — ${s.count} items, ${kind}. ${s.blurb}`);
    // A failed source says so here. `error` was carried in the payload all along but
    // rendered nowhere, so the committed digest read "0 items, adapted (pucks)" for a
    // repo whose harvest had actually fallen over — the one reader most likely to
    // notice was the only one not told.
    if (s.error) lines.push(`  - ⚠ harvest failed: ${s.error}`);
  }
  lines.push("");

  // Discrete drift labels (no day counts, so the digest stays idempotent).
  const signalLabel = (s, it) =>
    s.type === "stale" ? `stale (${it.status})`
    : s.type === "issue-closed" ? `issue #${it.issue} closed`
    : s.type === "issue-open" ? `issue #${it.issue} still open`
    : s.type === "target-passed" ? `target ${it.target} passed`
    : s.type === "parent-missing" ? `parent "${it.parent}" not found`
    : s.type === "parent-cycle" ? `parent "${it.parent}" closes a loop`
    : s.type === "depends-missing" ? `depends on ${it.missingDepends.map((d) => `"${d}"`).join(", ")}, which doesn't exist`
    : s.type === "dependency-cycle" ? "in a dependency loop"
    : s.type === "rollup-open" ? `${it.progress.total - it.progress.done} of ${it.progress.total} parts still open`
    : s.type === "rollup-done" ? "every part is done"
    : s.type;
  const flagged = payload.items.filter((it) => (it.signals || []).length);
  if (flagged.length) {
    lines.push(`## ⚠ Needs attention (${flagged.length})`, "");
    for (const it of flagged) {
      const msgs = it.signals.map((s) => signalLabel(s, it)).join(", ");
      lines.push(`- **${it.title}** — ${it.repoName} · ${msgs}  `);
      lines.push(`  ${it.sourceUrl}`);
    }
    lines.push("");
  }

  for (const status of payload.statuses) {
    const group = payload.items.filter((it) => it.status === status);
    if (group.length === 0) continue;
    lines.push(`## ${STATUS_LABEL[status]} (${group.length})`, "");
    for (const it of group) {
      const meta = [it.repoName];
      if (it.agent) meta.push(`→ ${it.agent}`);
      if (it.priority) meta.push(`${PRIORITY_MARK[it.priority] || ""}${it.priority}`.trim());
      if (it.tags.length) meta.push(it.tags.map((t) => `#${t}`).join(" "));
      // Discrete like the rest of the digest: the date itself, plus a ⚠ only when
      // the signal already fired — never a live "N days late" count.
      if (it.parentRef) meta.push(`\u2282 ${it.parentRef}`);
      if (it.progress) meta.push(`${it.progress.done}/${it.progress.total} done`);
      if (it.target) meta.push(`◷ ${it.target}${(it.signals || []).some((s) => s.type === "target-passed") ? " ⚠" : ""}`);
      if (it.updated) meta.push(it.updated);
      if (it.issue) {
        // Flag issue/status drift (discrete, so the digest stays idempotent).
        if (it.issueState === "closed" && !TERMINAL.has(it.status)) meta.push(`⚠ issue #${it.issue} closed`);
        else if (it.issueState === "open" && it.status === "done") meta.push(`⚠ issue #${it.issue} still open`);
        else meta.push(`issue #${it.issue}`);
      }
      if ((it.blockedBy || []).length) meta.push(`⛔ blocked by ${it.blockedBy.join(", ")}`);
      if (!it.native) meta.push("_adapted_");
      lines.push(`- **${it.title}** — ${meta.join(" · ")}  `);
      lines.push(`  ${it.sourceUrl}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
