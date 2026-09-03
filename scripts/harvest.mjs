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
const TERMINAL = new Set(["done", "cancelled"]);

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

// One reference form for every puck-to-puck link. A bare slug means "in my own
// repo"; `owner/repo#slug` names one anywhere on the board. Both `parent` and
// `depends` resolve through here, so there is one thing to learn and one thing to
// get right.
//
// The separator is written escaped on purpose: a literal NUL in the source makes
// git and ripgrep treat the whole file as binary and hide its diff.
const SEP = "\u0000";
function refKey(ref, fromRepo) {
  const s = String(ref || "").trim();
  const at = s.indexOf("#");
  return at === -1 ? fromRepo + SEP + s : s.slice(0, at) + SEP + s.slice(at + 1);
}
function indexByRef(items) {
  const byKey = new Map();
  for (const it of items) byKey.set(it.repo + SEP + it.slug, it);
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
    const deps = [];
    for (const dep of it.depends || []) {
      const d = byKey.get(refKey(dep, it.repo));
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

  // Depth-first walk over the dependency edges; every puck on a back edge is in a
  // cycle. Colour: 1 = on the current path, 2 = finished.
  const colour = new Map();
  const cycles = new Set();
  const walk = (it, path) => {
    colour.set(it, 1);
    path.push(it);
    for (const d of edges.get(it)) {
      if (colour.get(d) === 1) {
        for (let i = path.length - 1; i >= 0; i--) {
          cycles.add(path[i]);
          if (path[i] === d) break;
        }
      } else if (!colour.has(d)) {
        walk(d, path);
      }
    }
    path.pop();
    colour.set(it, 2);
  };
  for (const it of items) if (!colour.has(it)) walk(it, []);
  return cycles;
}

// Resolve `parent` into the derived half of the hierarchy: who my children are,
// and how far the etapp has come. Derived, never stored — a `children:` field
// could disagree with the `parent:` fields, and two truths is the one thing this
// product doesn't do.
//
// A cycle (a → b → a, or a puck naming itself) would make progress meaningless
// and could hang a renderer, so it's cut here and flagged for a human.
function resolveHierarchy(items) {
  const byKey = indexByRef(items);
  const keyOf = (it) => it.repo + SEP + it.slug;
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
  // `progress` counts the whole **subtree**, not the pucks that happen to name me
  // directly. "How far has this come?" is a question about the tree: a root whose one
  // child holds three of its own reported 0/1 and said nothing at all about the three.
  // Depth is unlimited in the format — a grandchild is one `parent:` line away — so a
  // rollup that stops at the first level is a number that quietly means something else
  // the moment anyone uses the depth the convention allows.
  //
  // Every descendant counts, not only the leaves. A puck with children is still a puck,
  // with its own status and its own body; leaving it out of the count would make it a
  // container, and a container is the second record type this model does not have.
  //
  // Safe to recurse: cycles were cut above, so `children` describes a forest.
  const subtree = (it, out) => {
    for (const id of it.children) {
      const k = byId.get(id);
      if (!k) continue;
      out.push(k);
      subtree(k, out);
    }
    return out;
  };
  for (const it of items) {
    if (!it.children.length) continue;
    const kin = subtree(it, []);
    it.progress = {
      done: kin.filter((k) => TERMINAL.has(k.status)).length,
      total: kin.length,
    };
  }
  return cycles;
}

function sortItems(a, b) {
  // Manual `order` first (lower = higher), then freshest `updated`, then title.
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
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
  const prev = await readJsonIfExists(path.join(ROOT, "data", "roadmap.json"));
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
