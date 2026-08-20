#!/usr/bin/env node
// roadmap — a tiny helper for authoring pucks without touching YAML.
//
// It runs inside a project repo and operates on its `roadmap/` directory.
// Every mutating command bumps `updated` for you, so you never hand-maintain it.
//
//   roadmap new "Multi-buffer i nano" --tags editor      create a puck (in inbox)
//   roadmap start nano-multibuffer                        → status: now  (+ bump)
//   roadmap next  nano-multibuffer                        → status: next
//   roadmap later nano-multibuffer                        → status: later
//   roadmap done  nano-multibuffer                        → status: done
//   roadmap status nano-multibuffer inbox                 → any status
//   roadmap tag   nano-multibuffer +editor -ui           add/remove tags
//   roadmap issue nano-multibuffer 42                     link a working issue
//   roadmap owner nano-multibuffer torvalds               set owner (--clear to remove)
//   roadmap priority nano-multibuffer high                set priority (--clear to remove)
//   roadmap agent nano-multibuffer backend                route to a discipline (--clear to remove)
//   roadmap touch nano-multibuffer                        just bump `updated`
//   roadmap list [--status now]                           quick overview
//   roadmap install-hook                                  auto-bump `updated` on commit
//
// Options: --dir <roadmap dir> (default "roadmap"). Dependency-free.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { STATUSES, PRIORITIES, slugify, normalizeDate } from "./lib/adapters.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const argv = process.argv.slice(2);

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

// ── argument parsing: pull out --flags, leave positionals ──
function parseArgs(args) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { opts[key] = next; i++; }
      else opts[key] = true;
    } else pos.push(a);
  }
  return { opts, pos };
}

const { opts, pos } = parseArgs(argv);
const DIR = path.resolve(opts.dir || "roadmap");
const cmd = pos.shift();

// ── frontmatter-aware, format-preserving field edits ──
// We edit the raw text line-by-line inside the first `---` block so the body and
// any other fields stay byte-identical.
function frontmatterRange(lines) {
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---") return [1, i];
  return null;
}

function formatValue(key, value) {
  if (key === "tags") {
    const arr = Array.isArray(value) ? value : [];
    return `[${arr.join(", ")}]`;
  }
  const s = String(value);
  if (key === "title" && /[:#]/.test(s)) return JSON.stringify(s);
  return s;
}

function setField(text, key, value) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const range = frontmatterRange(lines);
  if (!range) fail("no YAML frontmatter found — is this a puck?");
  const [start, end] = range;
  const line = `${key}: ${formatValue(key, value)}`;
  let replaced = false;
  for (let i = start; i < end; i++) {
    if (new RegExp(`^${key}:`).test(lines[i])) { lines[i] = line; replaced = true; break; }
  }
  if (!replaced) lines.splice(end, 0, line); // insert before closing fence
  return lines.join(nl);
}

function getField(text, key) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const range = frontmatterRange(lines);
  if (!range) return null;
  for (let i = range[0]; i < range[1]; i++) {
    const m = new RegExp(`^${key}:\\s*(.*)$`).exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

// Delete a frontmatter field line (no-op if absent). Keeps everything else
// byte-identical, same as setField.
function removeField(text, key) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const range = frontmatterRange(lines);
  if (!range) fail("no YAML frontmatter found — is this a puck?");
  for (let i = range[0]; i < range[1]; i++) {
    if (new RegExp(`^${key}:`).test(lines[i])) { lines.splice(i, 1); break; }
  }
  return lines.join(nl);
}

// ── locate a puck file by slug: roadmap/<slug>.md | roadmap/<slug>/README.md ──
function puckPath(slug) {
  const flat = path.join(DIR, `${slug}.md`);
  if (existsSync(flat)) return flat;
  const folder = path.join(DIR, slug, "README.md");
  if (existsSync(folder)) return folder;
  return null;
}

async function readPuckOrFail(slug) {
  const p = puckPath(slug);
  if (!p) fail(`no puck "${slug}" under ${path.relative(process.cwd(), DIR) || "roadmap"}/`);
  return { path: p, text: await readFile(p, "utf8") };
}

// ── commands ──
async function cmdNew() {
  const title = pos.join(" ").trim();
  if (!title) fail('usage: roadmap new "Title" [--status inbox] [--tags a,b]');
  const status = String(opts.status || "inbox");
  if (!STATUSES.includes(status)) fail(`status must be one of: ${STATUSES.join(", ")}`);
  const tags = opts.tags ? String(opts.tags).split(",").map((t) => slugify(t)).filter(Boolean) : [];
  const slug = slugify(title);

  await mkdir(DIR, { recursive: true });
  if (puckPath(slug)) fail(`a puck "${slug}" already exists`);

  const fm = [
    "---",
    `title: ${/[:#]/.test(title) ? JSON.stringify(title) : title}`,
    `status: ${status}`,
    ...(tags.length ? [`tags: [${tags.join(", ")}]`] : []),
    `updated: ${TODAY}`,
    `created: ${TODAY}`,
    "---",
    "",
    "## Goal",
    "",
    "",
    "## Research",
    "",
    "",
    "## Open questions",
    "",
    "",
  ].join("\n");

  const file = path.join(DIR, `${slug}.md`);
  await writeFile(file, fm);
  console.log(`✓ created ${path.relative(process.cwd(), file)}  [${status}]`);
  console.log(`  edit it, then: roadmap start ${slug}   (when you begin work)`);
}

async function setStatus(slug, status) {
  if (!STATUSES.includes(status)) fail(`status must be one of: ${STATUSES.join(", ")}`);
  const { path: p, text } = await readPuckOrFail(slug);
  let out = setField(text, "status", status);
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(`✓ ${slug} → ${status}  (updated ${TODAY})`);
}

async function cmdTag() {
  const slug = pos.shift();
  if (!slug || pos.length === 0) fail("usage: roadmap tag <slug> +add -remove …");
  const { path: p, text } = await readPuckOrFail(slug);
  const cur = getField(text, "tags");
  const set = new Set(
    (cur ? cur.replace(/^\[|\]$/g, "").split(",") : []).map((s) => s.trim()).filter(Boolean),
  );
  for (const op of pos) {
    if (op.startsWith("-")) set.delete(slugify(op.slice(1)));
    else set.add(slugify(op.replace(/^\+/, "")));
  }
  let out = setField(text, "tags", [...set]);
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(`✓ ${slug} tags: [${[...set].join(", ")}]  (updated ${TODAY})`);
}

async function cmdIssue() {
  const slug = pos.shift();
  const num = pos.shift();
  if (!slug || !num) fail("usage: roadmap issue <slug> <number>");
  const { path: p, text } = await readPuckOrFail(slug);
  let out = setField(text, "issue", Number(num));
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(`✓ ${slug} issue #${num}  (updated ${TODAY})`);
}

// The horizon. A calendar date so it sorts and compares without a period parser;
// the board renders it coarsely ("nov 2026") so it reads as a horizon, not a
// deadline. Accepts a bare month (2026-11) and takes that month's last day.
async function cmdTarget() {
  const slug = pos.shift();
  const when = pos.shift();
  if (!slug) fail("usage: roadmap target <slug> <YYYY-MM-DD|YYYY-MM>   (--clear to remove)");
  const { path: p, text } = await readPuckOrFail(slug);
  const clearing = opts.clear || when === "none" || when === "-";
  let out, shown = "";
  if (clearing) {
    out = removeField(text, "target");
  } else {
    const v = String(when || "").trim();
    const month = /^(\d{4})-(\d{2})$/.exec(v);
    if (month) {
      // A month means "by the end of it" — the last day, so `target:<=` questions
      // about that month include everything in it. Guard the month itself: Date.UTC
      // rolls `2026-13` over into 2027 instead of complaining.
      if (+month[2] < 1 || +month[2] > 12) fail(`"${v}" is not a real month`);
      shown = new Date(Date.UTC(+month[1], +month[2], 0)).toISOString().slice(0, 10);
    } else {
      shown = v;
    }
    // normalizeDate round-trips, so `2026-02-31` is rejected instead of silently
    // becoming March — the harvester applies the same rule to hand-written values.
    if (!normalizeDate(shown)) fail(`target must be a real date: YYYY-MM-DD or YYYY-MM  (or --clear)`);
    out = setField(text, "target", shown);
  }
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(
    clearing
      ? `✓ ${slug} target cleared  (updated ${TODAY})`
      : `✓ ${slug} target ${shown}  (updated ${TODAY})`,
  );
}

// The level above a puck. A bare slug means a puck in this repo; a full
// `owner/repo#slug` names one anywhere on the board. A puck with children *is*
// the etapp — there is no separate epic file to create.
async function cmdParent() {
  const slug = pos.shift();
  const ref = pos.shift();
  if (!slug) fail("usage: roadmap parent <slug> <parent-slug|owner/repo#slug>   (--clear to remove)");
  const { path: p, text } = await readPuckOrFail(slug);
  const clearing = opts.clear || ref === "none" || ref === "-";
  let out;
  if (clearing) {
    out = removeField(text, "parent");
  } else {
    const v = String(ref || "").trim();
    if (!v) fail("usage: roadmap parent <slug> <parent-slug|owner/repo#slug>   (--clear to remove)");
    if (v === slug) fail("a puck can't be its own etapp");
    // Same-repo references are checked here; a cross-repo one can only be verified
    // at harvest, where the whole board is in hand (it flags an unresolved parent).
    const local = !v.includes("#");
    if (local && !puckPath(v)) fail(`no puck "${v}" to be the etapp — create it first, or use owner/repo#slug`);
    if (local) {
      // Walk up locally to refuse the obvious cycle before it reaches the board.
      const seen = new Set([slug]);
      let cur = v;
      while (cur && !cur.includes("#")) {
        if (seen.has(cur)) fail(`that would make a cycle (${[...seen].join(" → ")} → ${cur})`);
        seen.add(cur);
        const path2 = puckPath(cur);
        if (!path2) break;
        cur = getField(await readFile(path2, "utf8"), "parent");
      }
    }
    out = setField(text, "parent", v);
  }
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(
    clearing
      ? `✓ ${slug} parent cleared  (updated ${TODAY})`
      : `✓ ${slug} parent ${ref}  (updated ${TODAY})`,
  );
}

async function cmdOwner() {
  const slug = pos.shift();
  const handle = pos.shift();
  if (!slug) fail("usage: roadmap owner <slug> <handle>   (--clear to remove)");
  const { path: p, text } = await readPuckOrFail(slug);
  const clearing = opts.clear || handle === "none" || handle === "-";
  let out;
  if (clearing) {
    out = removeField(text, "owner");
  } else {
    if (!handle) fail("usage: roadmap owner <slug> <handle>   (--clear to remove)");
    const h = handle.replace(/^@/, "").trim();
    // GitHub handle: alphanumerics + single (non-leading/trailing) hyphens, ≤39.
    if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(h))
      fail(`"${h}" doesn't look like a GitHub handle`);
    out = setField(text, "owner", h);
  }
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(
    clearing
      ? `✓ ${slug} owner cleared  (updated ${TODAY})`
      : `✓ ${slug} owner @${handle.replace(/^@/, "")}  (updated ${TODAY})`,
  );
}

async function cmdPriority() {
  const slug = pos.shift();
  const level = pos.shift();
  if (!slug) fail(`usage: roadmap priority <slug> <${PRIORITIES.join("|")}>   (--clear to remove)`);
  const { path: p, text } = await readPuckOrFail(slug);
  const clearing = opts.clear || level === "none" || level === "-";
  let out;
  if (clearing) {
    out = removeField(text, "priority");
  } else {
    const v = String(level || "").trim().toLowerCase();
    if (!PRIORITIES.includes(v)) fail(`priority must be one of: ${PRIORITIES.join(", ")}  (or --clear)`);
    out = setField(text, "priority", v);
  }
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(
    clearing
      ? `✓ ${slug} priority cleared  (updated ${TODAY})`
      : `✓ ${slug} priority ${String(level).toLowerCase()}  (updated ${TODAY})`,
  );
}

async function cmdAgent() {
  const slug = pos.shift();
  const name = pos.shift();
  if (!slug) fail("usage: roadmap agent <slug> <discipline>   (--clear to remove)");
  const { path: p, text } = await readPuckOrFail(slug);
  const clearing = opts.clear || name === "none" || name === "-";
  let out;
  if (clearing) {
    out = removeField(text, "agent");
  } else {
    if (!name) fail("usage: roadmap agent <slug> <discipline>   (--clear to remove)");
    const a = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!a) fail(`"${name}" isn't a valid agent handle`);
    out = setField(text, "agent", a);
  }
  out = setField(out, "updated", TODAY);
  await writeFile(p, out);
  console.log(
    clearing
      ? `✓ ${slug} agent cleared  (updated ${TODAY})`
      : `✓ ${slug} routed to ${name.trim().toLowerCase()}  (updated ${TODAY})`,
  );
}

async function cmdTouch() {
  const slug = pos.shift();
  if (!slug) fail("usage: roadmap touch <slug>");
  const { path: p, text } = await readPuckOrFail(slug);
  await writeFile(p, setField(text, "updated", TODAY));
  console.log(`✓ ${slug} updated ${TODAY}`);
}

async function listPucks() {
  let entries;
  try {
    entries = await readdir(DIR, { withFileTypes: true });
  } catch {
    fail(`no ${path.relative(process.cwd(), DIR) || "roadmap"}/ directory here`);
  }
  const pucks = [];
  for (const e of entries) {
    let file = null;
    let slug = null;
    if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md") {
      slug = e.name.replace(/\.md$/, "");
      file = path.join(DIR, e.name);
    } else if (e.isDirectory() && existsSync(path.join(DIR, e.name, "README.md"))) {
      slug = e.name;
      file = path.join(DIR, e.name, "README.md");
    }
    if (!file) continue;
    const text = await readFile(file, "utf8");
    pucks.push({
      slug,
      title: (getField(text, "title") || slug).replace(/^["']|["']$/g, ""),
      status: getField(text, "status") || "inbox",
      updated: getField(text, "updated") || "",
    });
  }
  const filter = opts.status ? String(opts.status) : null;
  const order = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
  pucks.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.updated.localeCompare(a.updated));
  let shown = 0;
  for (const s of STATUSES) {
    if (filter && s !== filter) continue;
    const group = pucks.filter((p) => p.status === s);
    if (!group.length) continue;
    console.log(`\n${s.toUpperCase()} (${group.length})`);
    for (const p of group) {
      console.log(`  ${p.slug.padEnd(28)} ${p.updated.padEnd(11)} ${p.title}`);
      shown++;
    }
  }
  if (!shown) console.log("(no pucks)");
}

// ── manual rank (`order`) ───────────────────────────────────────────────────
// `order` is the puck's place inside its status column (lower = higher up); pucks
// without one fall to the bottom, sorted by `updated`. You rarely want to pick a
// number by hand — say where it goes relative to another puck instead.
async function allPucks() {
  let entries;
  try {
    entries = await readdir(DIR, { withFileTypes: true });
  } catch {
    fail(`no ${path.relative(process.cwd(), DIR) || "roadmap"}/ directory here`);
  }
  const out = [];
  for (const e of entries) {
    let file = null, slug = null;
    if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md") {
      slug = e.name.replace(/\.md$/, "");
      file = path.join(DIR, e.name);
    } else if (e.isDirectory() && existsSync(path.join(DIR, e.name, "README.md"))) {
      slug = e.name;
      file = path.join(DIR, e.name, "README.md");
    }
    if (!file) continue;
    const text = await readFile(file, "utf8");
    const raw = getField(text, "order");
    out.push({
      slug,
      path: file,
      text,
      status: getField(text, "status") || "inbox",
      updated: getField(text, "updated") || "",
      order: raw == null || raw === "" ? null : Number(raw),
    });
  }
  return out;
}
// The board's own ordering: `order` first, then freshest, then slug.
function rankSort(a, b) {
  const ao = a.order == null ? Infinity : a.order;
  const bo = b.order == null ? Infinity : b.order;
  return ao - bo || b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug);
}

// Give a column round numbers in its current on-screen order. `all` decides
// whether unranked pucks are drawn in too: `renumber` leaves them alone (freezing
// every puck into a rank nobody asked for would be worse), while `move` needs them
// ranked to be able to express the position you asked for.
async function rankColumn(pucks, status, all) {
  const column = pucks
    .filter((p) => p.status === status && (all || p.order != null))
    .sort(rankSort);
  const changed = [];
  for (let i = 0; i < column.length; i++) {
    const want = (i + 1) * 10;
    if (column[i].order === want) continue;
    let out = setField(column[i].text, "order", String(want));
    out = setField(out, "updated", TODAY);
    await writeFile(column[i].path, out);
    changed.push(`${column[i].slug} ${column[i].order == null ? "—" : column[i].order} → ${want}`);
  }
  return changed;
}

async function cmdMove() {
  const slug = pos.shift();
  const anchor = opts.before || opts.after;
  if (!slug || !anchor || (opts.before && opts.after)) {
    fail("usage: roadmap move <slug> --before <slug> | --after <slug>");
  }
  const pucks = await allPucks();
  const me = pucks.find((p) => p.slug === slug);
  if (!me) fail(`no puck "${slug}" under ${path.relative(process.cwd(), DIR) || "roadmap"}/`);
  const to = pucks.find((p) => p.slug === anchor);
  if (!to) fail(`no puck "${anchor}" to move ${opts.before ? "before" : "after"}`);
  if (to.slug === me.slug) fail("a puck can't move relative to itself");
  if (to.status !== me.status) {
    fail(`"${anchor}" is in ${to.status} but "${slug}" is in ${me.status} — order only ranks within a column`);
  }
  // Neighbours in the anchor's column, with the moving puck taken out first.
  const neighbours = (list) => {
    const column = list.filter((p) => p.status === me.status && p.slug !== me.slug).sort(rankSort);
    const at = column.findIndex((p) => p.slug === anchor);
    const idx = opts.before ? at : at + 1;
    return { prev: column[idx - 1] || null, next: column[idx] || null };
  };
  let { prev, next } = neighbours(pucks);
  // A column renders as [ranked][unranked], so a single `order` can only express a
  // position whose upper neighbour is ranked. The board refuses here and points at
  // `renumber`; this command *is* the local bulk tool, so it ranks the column and
  // says so rather than failing on the common "nothing is ranked yet" case.
  if (prev && prev.order == null) {
    const changed = await rankColumn(pucks, me.status, true);
    if (changed.length) console.log(`  ranked ${me.status} first: ${changed.join(", ")}`);
    const fresh = await allPucks();
    Object.assign(me, fresh.find((p) => p.slug === me.slug));
    ({ prev, next } = neighbours(fresh));
  }
  const a = prev && prev.order != null ? prev.order : null;
  const b = next && next.order != null ? next.order : null;
  let value;
  if (prev == null) value = b == null ? 10 : b - 10;
  else if (b == null) value = a + 10;
  else {
    value = (a + b) / 2;
    if (value === a || value === b) fail(`no room between ${a} and ${b} — run: roadmap renumber --status ${me.status}`);
  }
  // Keep it an integer when the gap allows; decimals are legal but ugly in git.
  if (Number.isInteger(a) && Number.isInteger(b) && Math.abs(b - a) >= 2) value = Math.round(value);
  let out = setField(me.text, "order", String(value));
  out = setField(out, "updated", TODAY);
  await writeFile(me.path, out);
  console.log(`✓ ${slug} order ${value} (${opts.before ? "before" : "after"} ${anchor})  (updated ${TODAY})`);
}

// Renumber a column back to 10, 20, 30 … — the local, bulk counterpart to the
// board's single-file drops, for when midpoints have gone decimal.
async function cmdRenumber() {
  const pucks = await allPucks();
  const statuses = opts.status ? [String(opts.status)] : STATUSES;
  for (const s of statuses) {
    if (!STATUSES.includes(s)) fail(`status must be one of: ${STATUSES.join(", ")}`);
  }
  // `--all` also ranks the pucks that carry no `order` yet — needed before the
  // board can place a card below them by hand.
  let touched = 0;
  for (const s of statuses) {
    const changed = await rankColumn(pucks, s, !!opts.all);
    changed.forEach(function (line) { console.log("  " + line); });
    touched += changed.length;
  }
  console.log(touched ? `✓ renumbered ${touched} puck(s)  (updated ${TODAY})` : "✓ already tidy — nothing to renumber");
}

const HOOK_MARKER = "# roadmap-auto-updated";
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER} — bump \`updated:\` on any staged roadmap puck that changed.
today=$(date +%F)
files=$(git diff --cached --name-only --diff-filter=ACM | grep -E '(^|/)roadmap/.*\\.md$' || true)
[ -z "$files" ] && exit 0
for f in $files; do
  [ -f "$f" ] || continue
  awk -v d="$today" '
    /^---[ \\t]*$/ { fm++; print; next }
    fm==1 && !done && /^updated:/ { sub(/^updated:.*/, "updated: " d); done=1 }
    { print }
  ' "$f" > "$f.rmtmp" && mv "$f.rmtmp" "$f"
  git add "$f"
done
`;

function cmdInstallHook() {
  let gitDir;
  try {
    gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
  } catch {
    fail("not inside a git repository");
  }
  const hookPath = path.join(gitDir, "hooks", "pre-commit");
  if (existsSync(hookPath)) {
    if (readFileSync(hookPath, "utf8").includes(HOOK_MARKER)) {
      console.log("✓ hook already installed");
      return;
    }
    console.log("! a pre-commit hook already exists — not overwriting.");
    console.log("  Merge this into it to auto-bump 'updated', or move the existing hook aside:\n");
    console.log(HOOK_BODY);
    return;
  }
  writeFileSync(hookPath, HOOK_BODY);
  chmodSync(hookPath, 0o755);
  console.log(`✓ installed pre-commit hook → ${hookPath}`);
  console.log("  Editing any roadmap/*.md now bumps its 'updated' automatically on commit.");
}

async function main() {
  switch (cmd) {
    case "new": return cmdNew();
    case "start": return setStatus(pos.shift(), "now");
    case "next": return setStatus(pos.shift(), "next");
    case "later": return setStatus(pos.shift(), "later");
    case "done": return setStatus(pos.shift(), "done");
    case "cancel": case "cancelled": return setStatus(pos.shift(), "cancelled");
    case "inbox": return setStatus(pos.shift(), "inbox");
    case "status": { const s = pos.shift(); const st = pos.shift(); return setStatus(s, st); }
    case "tag": return cmdTag();
    case "issue": return cmdIssue();
    case "owner": return cmdOwner();
    case "priority": case "prio": return cmdPriority();
    case "target": return cmdTarget();
    case "parent": case "etapp": return cmdParent();
    case "move": return cmdMove();
    case "renumber": return cmdRenumber();
    case "agent": case "route": return cmdAgent();
    case "touch": return cmdTouch();
    case "list": case "ls": return listPucks();
    case "install-hook": return cmdInstallHook();
    case undefined:
    case "help": case "--help": case "-h":
      printHelp();
      return;
    default:
      fail(`unknown command "${cmd}" — try: roadmap help`);
  }
}

function printHelp() {
  console.log(`roadmap — author pucks without touching YAML (updated is bumped for you)

  roadmap new "Title" [--status inbox] [--tags a,b]   create a puck
  roadmap start|next|later|done|cancel|inbox <slug>   set status
  roadmap status <slug> <status>                      set any status
  roadmap tag <slug> +add -remove …                   edit tags
  roadmap issue <slug> <number>                       link a working issue
  roadmap owner <slug> <handle>                       set owner (--clear to remove)
  roadmap priority <slug> <level>                     set priority (--clear to remove)
  roadmap target <slug> <YYYY-MM-DD|YYYY-MM>          set the horizon (--clear to remove)
  roadmap parent <slug> <parent-slug>                 put it in an etapp (--clear to remove)
  roadmap move <slug> --before|--after <slug>         rank within the status column
  roadmap renumber [--status now]                     tidy order back to 10, 20, 30 …
  roadmap agent <slug> <discipline>                   route to an agent (--clear to remove)
  roadmap touch <slug>                                bump updated only
  roadmap list [--status now]                         overview
  roadmap install-hook                                auto-bump updated on commit

  --dir <path>   roadmap directory (default: roadmap)
  statuses: ${STATUSES.join(", ")}
  priorities: ${PRIORITIES.join(", ")}`);
}

main().catch((e) => fail(e.message));
