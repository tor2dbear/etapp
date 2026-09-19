#!/usr/bin/env node
// Can each gate fail?
//
// Five gates run on every pull request, and two of them have been caught claiming a
// property they were not holding. Both times it was luck — a side-finding while
// reviewing something else:
//
//   `export` added to format.js left all five green, the board rendering byte for
//   byte, and every write throwing. The file's whole argument is that it is a classic
//   script *and* an exportless module; only the module half was ever parsed.
//
//   check-query.mjs hand-wrote the names its fenced region reached for, and its
//   `isFlagged` read a field app.js never sets. `is:flagged` was checked against a
//   predicate that could not fire, and nothing called the predicates at all.
//
// A gate that cannot fail is worse than no gate: it spends the reviewer's attention
// and returns a tick. So each claim below is paired with a mutation that must break
// it, and this asserts the gate notices *and names* it. The claims are taken from the
// gates' own success lines — if a gate learns to say something new, it belongs here.
//
// The mutations are applied to a throwaway `git clone` of the working tree, never in
// place: a crash mid-run must not be able to leave a sabotaged repo behind.
//
// Node builtins only, like the rest of scripts/. Needs PyYAML for the two Python
// judges, the same as CI.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// [gate, argv] — how each one is run, so this file does not reimplement any of them.
const GATES = {
  syntax: ["node", "scripts/check-syntax.mjs"],
  bundle: ["node", "scripts/check-bundle.mjs"],
  query: ["node", "scripts/check-query.mjs"],
  format: ["python3", "scripts/check-format.py"],
  markdown: ["python3", "scripts/check-markdown.py"],
};

// Each entry: the claim in the gate's own words, the gate that makes it, and the edit
// that must break it. `expect` is a fragment the failure has to contain — a gate that
// fails for an unrelated reason has not demonstrated it holds this claim.
//
// `edit` is [file, find, replace]; `append` adds to a file; `write` creates one;
// `remove` deletes one.
const CASES = [
  // ── Syntax ────────────────────────────────────────────────────────────────
  { gate: "syntax", claim: "every tracked file parses (the biggest one)",
    edit: ["app.js", "  function lower(s) { return String(s).toLowerCase(); }", "  function lower(s) { return ((( }"],
    expect: "app.js" },
  { gate: "syntax", claim: "…including the served format.js",
    append: ["format.js", "\nfunction ((( {}\n"], expect: "format.js" },
  { gate: "syntax", claim: "…including generated, served data/roadmap.js",
    append: ["data/roadmap.js", "\nvar ((( ;\n"], expect: "data/roadmap.js" },
  { gate: "syntax", claim: "…including a file one directory deeper",
    append: ["scripts/lib/region.mjs", "\nconst ((( = 1;\n"], expect: "region.mjs" },

  // ── Bundle ────────────────────────────────────────────────────────────────
  { gate: "bundle", claim: "nothing tracked is published unintentionally",
    write: ["secrets.txt", "not for the web\n"], track: true, expect: "neither served nor excluded" },
  { gate: "bundle", claim: "nothing on disk is published unintentionally",
    write: ["scratch.bin", "x\n"], expect: "would be published" },
  { gate: "bundle", claim: "every gitignored pattern is also excluded from the bundle",
    append: [".gitignore", "\nnotes-*\n"], expect: "gitignored but not in .assetsignore" },
  { gate: "bundle", claim: "a served file dropped from SERVED is caught",
    edit: ["scripts/check-bundle.mjs", '"format.js": /^format\\.js$/,', ""], expect: "format.js" },

  // ── Query grammar ─────────────────────────────────────────────────────────
  { gate: "query", claim: "parseQuery never throws",
    edit: ["app.js", "/^(>=|<=|>|<|=)?([\\s\\S]+)$/.exec(rest)", "/^(>=|<=|>|<|=)?(.+)$/.exec(rest)"],
    expect: "threw" },
  { gate: "query", claim: "serialize∘parse is a fixed point",
    edit: ["app.js", "t.op + quoted(t.values[0]);", "t.op + t.values[0];"], expect: "fixed-point" },
  { gate: "query", claim: "no token vanishes",
    edit: ["app.js", "      terms.push({ field: \"text\", op: \"has\", values: [lower(tok)], neg: neg });", "      if (tok.length > 1) terms.push({ field: \"text\", op: \"has\", values: [lower(tok)], neg: neg });"],
    expect: "token" },
  { gate: "query", claim: "the documented grammar parses as AGENTS.md describes",
    edit: ["app.js", 'prio: "priority"', 'prioX: "priority"'], expect: "prio:high" },
  { gate: "query", claim: "`is:` states are predicates, not stubs",
    edit: ["app.js", "function isFlagged(item) { return (item.signals || []).length > 0; }", "function isFlagged(item) { return !!item.flagged; }"],
    expect: "is:flagged" },
  { gate: "query", claim: "an apostrophe finds the puck that carries one",
    edit: ["app.js", "      if (c === '\"') { quote = c; continue; }", "      if (c === '\"' || c === \"'\") { quote = c; continue; }"],
    expect: "don't" },
  { gate: "query", claim: "nothing decodes the URL bare",
    edit: ["app.js", 'var h = safeDecode(location.hash.replace(/^#/, ""));', 'var h = decodeURIComponent(location.hash.replace(/^#/, ""));'],
    expect: "safeDecode" },
  { gate: "query", claim: "the fenced region is really lifted from app.js",
    edit: ["app.js", "  // q:begin", "  // (marker removed)"], expect: "fence" },

  // ── Format judge ──────────────────────────────────────────────────────────
  { gate: "format", claim: "format.js stays loadable as a classic script",
    append: ["format.js", "\nexport const sabotage = 1;\n"], expect: "classic script" },
  { gate: "format", claim: "index.html still loads it as one",
    edit: ["index.html", '<script src="format.js"></script>', '<script type="module" src="format.js"></script>'],
    expect: "module" },
  { gate: "format", claim: "strings round-trip as strings",
    edit: ["format.js", "return bareIsSafe(s, ITEM_PLAIN, false) ? s : JSON.stringify(s);", "return s;"],
    expect: "string" },
  { gate: "format", claim: "numbers are written as numbers",
    edit: ["format.js", "if (typeof value === \"number\" && Number.isFinite(value)) return encodeNumber(value);", "if (typeof value === \"number\" && Number.isFinite(value)) return String(value);"],
    expect: "num" },
  { gate: "format", claim: "typed fields write a date bare",
    edit: ["format.js", 'new Set(["order", "issue", "updated", "created", "target"])', "new Set([])"],
    expect: "date" },
  { gate: "format", claim: "this parser agrees with PyYAML on a frontmatter line",
    edit: ["format.js", "const COMMENT_OPENS = /\\s#/;", "const COMMENT_OPENS = /\\sZZZ#/;"], expect: "reads" },
  { gate: "format", claim: "the writer's fields come back as their own type",
    edit: ["format.js", "const line = formatLine(key, value);", "const line = `${key}: ${value}`;"],
    expect: "writer" },
  { gate: "format", claim: "a BOM is carried back out",
    edit: ["format.js", 'const bom = text.startsWith("\\uFEFF") ? "\\uFEFF" : "";', 'const bom = "";'],
    expect: "BOM" },
  { gate: "format", claim: "every puck the CLI writes parses",
    edit: ["format.js", "return bareIsSafe(s, SCALAR_PLAIN, typed) ? s : JSON.stringify(s);", "return s;"],
    expect: "cli" },

  // ── Markdown judge ────────────────────────────────────────────────────────
  { gate: "markdown", claim: "no body becomes markup the renderer does not write",
    edit: ["app.js", '.replace(/</g, "&lt;")', '.replace(/\\u0001/g, "")'], expect: "tag" },
  { gate: "markdown", claim: "…including through an attribute",
    edit: ["app.js", '.replace(/"/g, "&quot;");', ";"], expect: "attribute" },
  { gate: "markdown", claim: "the documented subset renders",
    edit: ["app.js", "out.push(\"<h\" + lvl + \">\" + mdInline(h[2]) + \"</h\" + lvl + \">\");", "out.push(\"<p>\" + mdInline(h[2]) + \"</p>\");"],
    expect: "subset" },
  { gate: "markdown", claim: "an unsupported line keeps its own line",
    edit: ["app.js", "|\\[\\^|#+\\s|-{3,}", "|-{3,}"], expect: "folded" },
  { gate: "markdown", claim: "a line ending is not a dialect",
    edit: ["app.js", "esc(src).split(/\\r\\n?|\\n/)", 'esc(src).split("\\n")'], expect: "endings" },
  { gate: "markdown", claim: "the fixture is what the contract points at",
    remove: ["tests/markdown.fixture.md"], expect: "failed" },
];

function clone(dir) {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", ROOT, dir], { stdio: "ignore" });
  // The clone has HEAD, not the working tree — copy over anything uncommitted so this
  // checks the code in front of you rather than the last commit.
  //
  // `-uall` and `-z`, both for the same reason: the plain porcelain format is a
  // summary, not a list of files. It collapses an untracked directory into one entry
  // (`?? new-fixtures/`), which `copyFileSync` then hit with EISDIR before a single
  // gate ran — so adding a fixtures directory silently disabled the working-tree half
  // of this check. And it *quotes* a path containing a space or a quote character
  // (`"odd \"name\".md"`), which would have been copied to a filename with the quotes
  // still in it. `-z` emits raw NUL-separated paths; a rename carries its old path as
  // the following field, which is consumed rather than mistaken for a file.
  const entries = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const dirty = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    dirty.push(entries[i].slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // the next field is the old path
  }
  for (const rel of dirty) {
    const from = path.join(ROOT, rel);
    const to = path.join(dir, rel);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      execFileSync("git", ["add", "-f", rel], { cwd: dir, stdio: "ignore" });
    } else if (fs.existsSync(to)) {
      fs.rmSync(to);
      execFileSync("git", ["rm", "--cached", "-q", rel], { cwd: dir, stdio: "ignore" });
    }
  }
  return dir;
}

function apply(dir, c) {
  if (c.edit) {
    const [rel, find, replace] = c.edit;
    const f = path.join(dir, rel);
    const src = fs.readFileSync(f, "utf8");
    const n = src.split(find).length - 1;
    if (n !== 1) return `the mutation's anchor appears ${n} times in ${rel}, not once`;
    fs.writeFileSync(f, src.replace(find, replace));
  }
  if (c.append) {
    const [rel, text] = c.append;
    fs.appendFileSync(path.join(dir, rel), text);
  }
  if (c.write) {
    const [rel, text] = c.write;
    fs.writeFileSync(path.join(dir, rel), text);
    if (c.track) execFileSync("git", ["add", "-f", rel], { cwd: dir, stdio: "ignore" });
  }
  if (c.remove) {
    fs.rmSync(path.join(dir, c.remove[0]), { force: true });
  }
  return null;
}

const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => !a.startsWith("-"));
const cases = only ? CASES.filter((c) => c.gate === only) : CASES;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "etapp-checkcheck-"));
const failures = [];
let ran = 0;

// The gates must all pass on the *unmutated* clone first. Otherwise a mutation that
// "fails" proves nothing — the gate was already red.
const base = clone(path.join(tmp, "base"));
for (const [name, argv] of Object.entries(GATES)) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: base, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`✗ ${name} does not pass on an unmutated tree — nothing below proves anything\n`);
    console.error((r.stdout + r.stderr).trim());
    process.exit(1);
  }
}

for (const [i, c] of cases.entries()) {
  const dir = clone(path.join(tmp, `m${i}`));
  const why = apply(dir, c);
  if (why) {
    failures.push([c, `the mutation could not be applied — ${why}`]);
    fs.rmSync(dir, { recursive: true, force: true });
    continue;
  }
  const argv = GATES[c.gate];
  const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, encoding: "utf8", timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");
  ran++;
  if (r.status === 0) {
    failures.push([c, "the gate passed — this claim is not held"]);
  } else if (!out.toLowerCase().includes(c.expect.toLowerCase())) {
    failures.push([c, `the gate failed but never mentioned ${JSON.stringify(c.expect)} — ` +
      `it may be failing for an unrelated reason: ${out.trim().split("\n").filter(Boolean).slice(0, 2).join(" / ").slice(0, 160)}`]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`✗ ${failures.length} of ${ran} claim(s) are not actually held\n`);
  for (const [c, why] of failures) console.error(`  [${c.gate}] ${c.claim}\n      ${why}\n`);
  process.exit(1);
}
const byGate = cases.reduce((a, c) => ({ ...a, [c.gate]: (a[c.gate] || 0) + 1 }), {});
console.log(
  `✓ every gate can fail — ${ran} claims, each broken on purpose and each named by the gate that makes it ` +
    `(${Object.entries(byGate).map(([g, n]) => `${g} ${n}`).join(", ")})`
);
