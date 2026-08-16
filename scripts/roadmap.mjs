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
//   roadmap touch nano-multibuffer                        just bump `updated`
//   roadmap list [--status now]                           quick overview
//   roadmap install-hook                                  auto-bump `updated` on commit
//
// Options: --dir <roadmap dir> (default "roadmap"). Dependency-free.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { STATUSES, slugify } from "./lib/adapters.mjs";

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
    "## Mål",
    "",
    "",
    "## Research",
    "",
    "",
    "## Öppna frågor",
    "- ",
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
    case "inbox": return setStatus(pos.shift(), "inbox");
    case "status": { const s = pos.shift(); const st = pos.shift(); return setStatus(s, st); }
    case "tag": return cmdTag();
    case "issue": return cmdIssue();
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
  roadmap start|next|later|done|inbox <slug>          set status
  roadmap status <slug> <status>                      set any status
  roadmap tag <slug> +add -remove …                   edit tags
  roadmap issue <slug> <number>                       link a working issue
  roadmap touch <slug>                                bump updated only
  roadmap list [--status now]                         overview
  roadmap install-hook                                auto-bump updated on commit

  --dir <path>   roadmap directory (default: roadmap)
  statuses: ${STATUSES.join(", ")}`);
}

main().catch((e) => fail(e.message));
