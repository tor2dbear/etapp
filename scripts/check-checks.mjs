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
  { gate: "markdown", claim: "the fixture is what the contract points at",
    remove: ["tests/markdown.fixture.md"], expect: "markdown.fixture.md" },
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
  const untracked = new Set();
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const rel = entries[i].slice(3);
    if (code[0] === "?") untracked.add(rel);
    dirty.push(rel);
    // A rename or copy carries its source as the following field. Both go on the list
    // rather than being skipped: the loop below copies a path that exists in the
    // working tree and deletes one that does not, which is exactly right for each —
    // a rename's source is gone and has to be removed from the clone, a copy's source
    // is still there and is re-copied harmlessly.
    //
    // Skipping it meant the clone kept HEAD's copy of the old path beside the new one.
    // Measured: with `tests/markdown.fixture.md` renamed away, the markdown gate — which
    // reads that exact path — passed on the base clone and the whole run went green on
    // a tree where the fixture no longer exists. The meta-check was validating stale
    // code, which is the one failure it is built to be incapable of.
    if (code[0] === "R" || code[0] === "C") dirty.push(entries[++i]);
  }
  for (const rel of dirty) {
    const from = path.join(ROOT, rel);
    const to = path.join(dir, rel);
    // `lstat`, not `existsSync`: a dangling symlink "does not exist" and would have
    // been silently skipped, leaving the base clone green on a tree the real gate
    // rejects. A symlink is recreated as one rather than dereferenced, and anything
    // that is neither a file nor a symlink — a submodule gitlink, a typechange — is
    // reported rather than handed to `copyFileSync`, which is the enumeration class
    // the untracked-directory bug already came from.
    let st = null;
    try { st = fs.lstatSync(from); } catch { st = null; }
    if (st && !st.isFile() && !st.isSymbolicLink()) {
      throw new Error(`cannot mirror ${rel} into the clone — it is not a regular file or symlink`);
    }
    if (st) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.rmSync(to, { force: true });
      if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else fs.copyFileSync(from, to);
      // Only what git already considers tracked. `git add -f` on everything made an
      // untracked file tracked in the clone, which changes what both `git ls-files`
      // and check-bundle see — measured: an untracked `probe.tmp.js` with a syntax
      // error is invisible to the real gate and aborted this one on the base tree.
      if (!untracked.has(rel)) execFileSync("git", ["add", "-f", rel], { cwd: dir, stdio: "ignore" });
    } else if (fs.existsSync(to) || fs.lstatSync(to, { throwIfNoEntry: false })) {
      fs.rmSync(to, { force: true });
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

const only = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (only && !GATES[only]) {
  console.error(`✗ no gate called ${JSON.stringify(only)} — one of: ${Object.keys(GATES).join(", ")}`);
  process.exit(1);
}
const cases = only ? CASES.filter((c) => c.gate === only) : CASES;
// `check-checks.mjs fomat` used to print "✓ every gate can fail — 0 claims" and exit 0.
// The same vacuous pass `check-syntax.mjs` refuses for an empty file list, in the file
// whose entire subject is checks that cannot fail.
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
let ran = 0;

// The gates must all pass on the *unmutated* clone first. Otherwise a mutation that
// "fails" proves nothing — the gate was already red.
const base = clone(path.join(tmp, "base"));
// `python3` missing, or a gate that hangs, is not a held claim — and `r.stdout` is
// `null` when the spawn itself failed, so the old `r.stdout + r.stderr` was `0` and
// `.trim()` threw a TypeError over the top of the real reason.
const output = (r) => [r.stdout, r.stderr].filter(Boolean).join("").trim();
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
  ran++;
  if (r.error) {
    failures.push([c, `the gate could not be run — ${r.error.message}`]);
  } else if (r.status === 0) {
    failures.push([c, "the gate passed — this claim is not held"]);
  } else if (!out.toLowerCase().includes(c.expect.toLowerCase())) {
    failures.push([c, `the gate failed but never mentioned ${JSON.stringify(c.expect)} — ` +
      `it may be failing for an unrelated reason: ${out.trim().split("\n").filter(Boolean).slice(0, 2).join(" / ").slice(0, 160)}`]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

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
