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
    expect: "[throws]" },
  { gate: "query", claim: "serialize∘parse is a fixed point",
    edit: ["app.js", "t.op + quoted(t.values[0]);", "t.op + t.values[0];"], expect: "[fixed-point]" },
  { gate: "query", claim: "no token vanishes",
    edit: ["app.js", "      terms.push({ field: \"text\", op: \"has\", values: [lower(tok)], neg: neg });", "      if (tok.length > 1) terms.push({ field: \"text\", op: \"has\", values: [lower(tok)], neg: neg });"],
    expect: "[vanishing]" },
  { gate: "query", claim: "the documented grammar parses as AGENTS.md describes",
    edit: ["app.js", 'prio: "priority"', 'prioX: "priority"'], expect: "[grammar]" },
  { gate: "query", claim: "`is:` states are predicates, not stubs",
    edit: ["app.js", "function isFlagged(item) { return (item.signals || []).length > 0; }", "function isFlagged(item) { return !!item.flagged; }"],
    expect: "[is-states]" },
  { gate: "query", claim: "an apostrophe finds the puck that carries one",
    edit: ["app.js", "      if (c === '\"') { quote = c; continue; }", "      if (c === '\"' || c === \"'\") { quote = c; continue; }"],
    expect: "[search]" },
  { gate: "query", claim: "nothing decodes the URL bare",
    edit: ["app.js", 'var h = safeDecode(location.hash.replace(/^#/, ""));', 'var h = decodeURIComponent(location.hash.replace(/^#/, ""));'],
    expect: "[url-decode]" },
  { gate: "query", claim: "the fenced region is really lifted from app.js",
    edit: ["app.js", "  // q:begin", "  // (marker removed)"], expect: "fence" },

  // ── Format judge ──────────────────────────────────────────────────────────
  { gate: "format", claim: "format.js stays loadable as a classic script",
    append: ["format.js", "\nexport const sabotage = 1;\n"], expect: "classic script" },
  { gate: "format", claim: "index.html still loads it as one",
    edit: ["index.html", '<script src="format.js"></script>', '<script type="module" src="format.js"></script>'],
    expect: "module" },
  // "in both positions" is two claims, so it is two cases. The first version said
  // `strings round-trip as strings` and mutated the item encoder while expecting the
  // scalar tag — the gate failed, but for the other half of the sentence.
  { gate: "format", claim: "strings round-trip as strings, as a list item",
    edit: ["format.js", "return bareIsSafe(s, ITEM_PLAIN, false) ? s : JSON.stringify(s);", "return s;"],
    expect: "[string/item]" },
  { gate: "format", claim: "strings round-trip as strings, after `key:`",
    edit: ["format.js", "return bareIsSafe(s, SCALAR_PLAIN, typed) ? s : JSON.stringify(s);", "return s;"],
    expect: "[string/scalar]" },
  { gate: "format", claim: "numbers are written as numbers",
    // `encodeNumber`, not `formatValue`: the judge's number corpus is built from the
    // encoder directly, so mutating the caller only ever tripped `[writer]` — and the
    // loose expectation `"num"` matched that and called the claim held.
    edit: ["format.js", "return exp ? `${exp[1]}${exp[2]}.0${exp[3]}` : s;", "return s;"],
    expect: "[number]" },
  { gate: "format", claim: "typed fields write a date bare",
    // The typed path in `bareIsSafe`, which is what the judge's date corpus goes
    // through. Emptying TYPED_FIELDS tripped `[cli]` and `[writer]` and never `[date]`.
    edit: ["format.js", "if (typed && (PLAIN_NUMBER.test(s) || PLAIN_DATE.test(s))) return true;", "if (typed && PLAIN_NUMBER.test(s)) return true;"],
    expect: "[date]" },
  { gate: "format", claim: "this parser agrees with PyYAML on a frontmatter line",
    // `stripComment` is the read side. The old mutation hit `bareIsSafe`, which only
    // the write side uses, and `expect: "reads"` matched the judge's fixed epilogue
    // ("what this repo writes and reads against a real YAML parser") — printed on every
    // failure, so the expectation filtered nothing at all.
    edit: ["scripts/lib/frontmatter.mjs", "  const v = stripComment(raw);", "  const v = raw.trim();"],
    expect: "[reader]" },
  { gate: "format", claim: "the writer's fields come back as their own type",
    edit: ["format.js", "const line = formatLine(key, value);", "const line = `${key}: ${value}`;"],
    expect: "[writer]" },
  { gate: "format", claim: "a BOM is carried back out",
    edit: ["format.js", 'const bom = text.startsWith("\\uFEFF") ? "\\uFEFF" : "";', 'const bom = "";'],
    expect: "refuses a puck that starts with a BOM" },
  { gate: "format", claim: "every puck the CLI writes parses",
    edit: ["format.js", "return bareIsSafe(s, SCALAR_PLAIN, typed) ? s : JSON.stringify(s);", "return s;"],
    expect: "[cli]" },

  // ── Markdown judge ────────────────────────────────────────────────────────
  { gate: "markdown", claim: "no body becomes markup the renderer does not write",
    edit: ["app.js", '.replace(/</g, "&lt;")', '.replace(/\\u0001/g, "")'], expect: "[tag]" },
  { gate: "markdown", claim: "…including through an attribute",
    edit: ["app.js", '.replace(/"/g, "&quot;");', ";"], expect: "[attribute]" },
  { gate: "markdown", claim: "the documented subset renders",
    edit: ["app.js", "out.push(\"<h\" + lvl + \">\" + mdInline(h[2]) + \"</h\" + lvl + \">\");", "out.push(\"<p>\" + mdInline(h[2]) + \"</p>\");"],
    expect: "[subset]" },
  { gate: "markdown", claim: "an unsupported line keeps its own line",
    edit: ["app.js", "|\\[\\^|#+\\s|-{3,}", "|-{3,}"], expect: "[own-line]" },
  { gate: "markdown", claim: "a line ending is not a dialect",
    edit: ["app.js", "esc(src).split(/\\r\\n?|\\n/)", 'esc(src).split("\\n")'], expect: "[line-endings]" },
  // Not `remove: the fixture`. That killed the probe with an unhandled ENOENT, and the
  // expectation matched the absolute path in the *stack trace* while the `[fixture]`
  // check never ran at all — a claim certified by a crash. Editing one needled line
  // out of the fixture is the mutation that reaches the check the claim names.
  { gate: "markdown", claim: "the fixture is held to what CONVENTION promises",
    edit: ["tests/markdown.fixture.md", "##### A fifth-level heading is outside the subset", "A fifth-level heading"],
    expect: "[fixture]" },
  { gate: "markdown", claim: "…and a fixture that is gone is noticed at all",
    remove: "tests/markdown.fixture.md", expect: "md-probe.mjs failed" },
];

// A recursive copy of the whole directory, `.git` included. The copy *is* the working
// tree by construction — uncommitted edits, staged adds, renames, deletions, untracked
// files, symlinks and the index, exactly as they are — so there is nothing to
// enumerate and therefore nothing to enumerate wrongly.
//
// That matters more than the tidiness. This function used to `git clone` (which gets
// HEAD, the wrong tree) and then reconstruct the working tree on top by decoding
// `git status --porcelain`. Four of the defects this file has needed fixing were in
// that reconstruction, every one of them the same shape: a summary format read as a
// list of files. An untracked directory arriving as `?? dir/`. A quoted `"odd \"name\""`.
// A rename's source left behind so the run validated code the tree no longer had. A
// dangling symlink that `existsSync` calls absent. None of those are expressible here.
//
// Measured on this repo: 53ms against 166ms for `git clone --no-hardlinks`, ×33 runs.
// Bigger on disk (6.3M against 2.1M — loose objects rather than a pack) and peak usage
// is the base plus one mutant, which is nothing.
const SKIP_COPY = new Set(["node_modules", ".sources", ".wrangler"]);
function clone(dir) {
  fs.cpSync(ROOT, dir, {
    recursive: true,
    verbatimSymlinks: true, // a symlink stays a symlink, pointing where it pointed
    // Nothing here installs them, but a contributor's `npm i` or a local harvest would
    // otherwise be copied once per mutation. They are in `.assetsignore` and
    // `.gitignore`; no gate reads them.
    filter: (src) => !SKIP_COPY.has(path.basename(src)),
  });
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
    fs.rmSync(path.join(dir, c.remove), { force: true });
  }
  return null;
}

const only = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (only && !GATES[only]) {
  console.error(`✗ no gate called ${JSON.stringify(only)} — one of: ${Object.keys(GATES).join(", ")}`);
  process.exit(1);
}
const cases = only ? CASES.filter((c) => c.gate === only) : CASES;
// A typo'd gate name is caught above. What is left for this to catch is a gate in
// `GATES` with no case in `CASES` — which would otherwise print a tick for a gate
// nothing had tried to break. The same vacuous pass `check-syntax.mjs` refuses for an
// empty file list.
if (!cases.length) {
  console.error("✗ no claims selected — this check just stopped checking anything");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "etapp-checkcheck-"));
// Every exit, not only the happy one. The base-tree guard's `process.exit(1)` skipped
// the cleanup at the end and left a ~2MB clone behind on each failed run.
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const failures = [];

// The gates must all pass on the *unmutated* clone first. Otherwise a mutation that
// "fails" proves nothing — the gate was already red.
const base = clone(path.join(tmp, "base"));
// `python3` missing, or a gate that hangs, is not a held claim — and `r.stdout` is
// `null` when the spawn itself failed, so the old `r.stdout + r.stderr` was `0` and
// `.trim()` threw a TypeError over the top of the real reason.
const output = (r) => [r.stdout, r.stderr].filter(Boolean).join("").trim();

// Did the gate fail *for this claim*? Three of the judges report every failure as
// `  [tag] detail`, so an expectation written `[tag]` is matched against the set of
// tags the run actually emitted — exactly, not as a substring of the whole output.
//
// Substring matching over stdout+stderr certified a claim with a crash. The fixture
// case deletes `tests/markdown.fixture.md`; the probe then dies with an unhandled
// ENOENT whose stack trace contains the absolute path, so `expect:
// "markdown.fixture.md"` matched — while the `[fixture]` check that reads CONVENTION's
// promised needles was never reached. Zero `[fixture]` lines in the output, and the
// claim counted as held. Two earlier expectations went the same way: `"num"` matched
// `[writer]`, and `"reads"` matched the judge's fixed epilogue, printed on every
// failure.
//
// A crash emits no tags, so a crash now fails the case, which is the right answer: a
// gate that died did not demonstrate anything about the claim it makes. The two gates
// that report in prose rather than tags keep prose expectations, and those are matched
// as substrings — noted rather than hidden.
const TAGGED = /^\s*\[([a-z0-9/-]+)\]/;
function named(out, expect) {
  const wanted = /^\[([a-z0-9/-]+)\]$/.exec(expect);
  if (!wanted) return out.toLowerCase().includes(expect.toLowerCase());
  const emitted = new Set();
  for (const line of out.split("\n")) {
    const m = TAGGED.exec(line);
    if (m) emitted.add(m[1]);
  }
  return emitted.has(wanted[1]);
}
for (const [name, argv] of Object.entries(GATES)) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: base, encoding: "utf8", timeout: 180000 });
  if (r.error) {
    console.error(`✗ ${name} could not be run at all (${argv.join(" ")}) — ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`✗ ${name} does not pass on an unmutated tree — nothing below proves anything\n`);
    console.error(output(r) || `(no output; signal ${r.signal})`);
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
  const out = output(r);
  if (r.error) {
    failures.push([c, `the gate could not be run — ${r.error.message}`]);
  } else if (r.status === 0) {
    failures.push([c, "the gate passed — this claim is not held"]);
  } else if (!named(out, c.expect)) {
    failures.push([c, `the gate failed but never mentioned ${JSON.stringify(c.expect)} — ` +
      `it may be failing for an unrelated reason: ${out.trim().split("\n").filter(Boolean).slice(0, 2).join(" / ").slice(0, 160)}`]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`✗ ${failures.length} of ${cases.length} claim(s) are not actually held\n`);
  for (const [c, why] of failures) console.error(`  [${c.gate}] ${c.claim}\n      ${why}\n`);
  process.exit(1);
}
const byGate = cases.reduce((a, c) => ({ ...a, [c.gate]: (a[c.gate] || 0) + 1 }), {});
console.log(
  `✓ ${cases.length} claims broken on purpose, each one caught and named by the gate that makes it ` +
    `(${Object.entries(byGate).map(([g, n]) => `${g} ${n}`).join(", ")})`
);
