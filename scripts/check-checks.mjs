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
import { execFileSync, spawn } from "node:child_process";
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
// It is also faster than the clone it replaced — around 50ms against 160ms here — but
// that is a side effect and not the reason, and the precise pair is the wrong thing to
// write down: measured again under load it came out 80-96ms, which is the sort of
// contradiction a number in a comment invites. What does not move is that a copy
// cannot mis-enumerate a tree it did not enumerate.
//
// Bigger on disk (6.3M against 2.1M — loose objects rather than a pack); peak usage is
// the base plus one mutant, which is nothing.
const SKIP_COPY = new Set(["node_modules", ".sources", ".wrangler"]);
const GIT_DIR = path.join(ROOT, ".git");

// Every git command here, and every gate below, runs without the caller's `GIT_*`
// variables. They are how git is told to look somewhere else, and a child inherits
// them: with an absolute `GIT_INDEX_FILE` set, the copy's `git add` wrote into the
// *caller's* index — measured, `secrets.txt` staged over there and the copy's own
// index untouched. The gates run `git ls-files`, so they need the same treatment or
// they read the caller's tracked set instead of the copy's. Nothing here wants any of
// them, so the whole prefix goes.
// The config files are the same sentence in a different spelling, and stripping `GIT_*`
// is what forecloses saying it: sealing them means *setting* two of these variables, not
// removing them. `init.templateDir` pointing at a template whose `index` is a symlink put
// the copy's index outside the copy — measured, a green run that wrote 3692 bytes into a
// file the fingerprint cannot see, because it is not under ROOT. `core.excludesFile` and
// `core.hooksPath` are the same shape waiting for a gate that asks a wider question.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
};
const git = (args, cwd, input) =>
  execFileSync("git", args, { cwd, env: ENV, input, encoding: "utf8", stdio: input === undefined ? undefined : ["pipe", "pipe", "pipe"] });

// The tracked set, as mode/hash/stage/path records. Not the index *file*: copying that
// has been wrong three times now, each in a different way git is allowed to be
// configured. A linked worktree puts it somewhere else; split-index makes it a link to
// a `sharedindex.<hash>` companion the copy does not have, so `git ls-files` exits 128
// with "index file open failed" before a single gate runs; and `GIT_INDEX_FILE` moves
// it again. `ls-files -s` answers through git, so every one of those is already
// resolved by the time this reads it.
const TRACKED = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: ROOT, env: ENV, encoding: "utf8" });

// Those records carry the source repository's hashes, and a copy created in the default
// format cannot read them: in a SHA-256 checkout `git init` makes a SHA-1 repository and
// `update-index --index-info` rejects every 64-character hash with "malformed index
// info" before a single gate runs. Reproduced in a SHA-256 clone of this repo. The flag
// and the query both arrived in git 2.29, so an older git answers neither and wants
// neither — one format existed then.
let OBJECT_FORMAT = "";
try {
  OBJECT_FORMAT = git(["rev-parse", "--show-object-format"], ROOT).trim();
} catch {}
// `--no-template` as well, because a template directory is reachable three ways and the
// sealing above only closes one: config, `GIT_TEMPLATE_DIR`, and the one compiled into
// git. Nothing in a template belongs in a copy that exists to hold an index for a few
// milliseconds.
const INIT = ["init", "--quiet", "--no-template", ...(OBJECT_FORMAT ? [`--object-format=${OBJECT_FORMAT}`] : [])];

// And the copy's own `.git` is checked rather than assumed. Six defects in this file have
// been a path inside the copy that names something outside it, and the last one arrived
// through a directory git was told to copy — so the question is asked of the result
// instead of enumerated over the ways in.
function assertNoEscape(root, dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoEscape(root, p);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const real = path.resolve(path.dirname(p), fs.readlinkSync(p));
    if (real !== root && !real.startsWith(root + path.sep)) {
      fail(`the copy's ${path.relative(root, p)} points at ${real}, which is outside the copy`);
    }
  }
}

// The copy keeps no symlinks. A link is a hole in it: every write in `apply()` follows
// one, so a contributor whose `format.js` is locally a link to a file kept elsewhere had
// the sabotage land on that real file — measured, its bytes came back changed by a run
// of the safety check. `cpSync` cannot close the hole by itself: `dereference: true`
// only rewrites a relative target to an absolute one, which escapes just as well. Same
// shape as the `.git` pointer file below.
//
// A link to a file becomes that file's bytes, which is what every gate meant to read
// anyway. A link whose target is gone is dropped: reading it would have failed in the
// real tree too. Anything else is refused by name rather than guessed at — following it
// is precisely how the bug above worked.
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const refuse = (rel, why) =>
  fail(
    `${rel} is a symlink that ${why} — the copy cannot hold it without reaching outside itself.\n` +
      `  Replace it with the file itself, or add it to SKIP_COPY above if no gate reads it.`
  );

// Walked in lockstep: `copy` is the directory being repaired, `src` the one it was copied
// from. A link is followed from `src`, never from `copy` — `cpSync` keeps the target
// string verbatim, so `format.js -> ../shared/format.js` means something else entirely
// once the link is sitting in a temp directory: nothing, or whatever happens to occupy
// that spot over there. Measured — the copy lost `format.js` and the base tree came back
// red on a repository whose own `node --check` is clean.
function materialize(copy, src) {
  for (const entry of fs.readdirSync(copy, { withFileTypes: true })) {
    const p = path.join(copy, entry.name);
    const source = path.join(src, entry.name);
    if (entry.isDirectory()) {
      materialize(p, source);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    let target = null;
    try {
      target = fs.statSync(source); // through the link, which is the point
    } catch (err) {
      // Only a target that is *gone* is dropped, and only because reading it would have
      // failed in the real tree too. A link that exists and cannot be followed — EACCES,
      // a loop — is not a question to answer by quietly deleting the file.
      if (err.code !== "ENOENT") refuse(path.relative(ROOT, source), `cannot be followed (${err.code})`);
    }
    if (target && !target.isFile()) refuse(path.relative(ROOT, source), "points at something other than a regular file");
    fs.unlinkSync(p); // unlinks the link, never the file it names
    // `copyFileSync` reads through the link kernel-side and, the destination having just
    // been removed, creates it with the source's mode — 755 stays 755 under a 077 umask,
    // measured. No whole file through the heap and no separate chmod to forget.
    if (target) fs.copyFileSync(source, p);
  }
}

function clone(dir) {
  fs.cpSync(ROOT, dir, {
    recursive: true,
    verbatimSymlinks: true, // every one of them is replaced below, by materialize()
    filter: (src) =>
      // `.git` is not copied. In a linked worktree it is a *pointer file*, so copying
      // it verbatim gave every temporary copy the real repository's index — and the
      // tracked-file mutation's `git add -f secrets.txt` then wrote into the user's own
      // worktree, which came back `AD secrets.txt` in their `git status`. Measured, in
      // a throwaway worktree, before this line existed. A tool that mutates a copy has
      // no business reaching the original, and "a copy is the tree" stops being true at
      // exactly the file that says where the tree's metadata lives.
      src !== GIT_DIR &&
      // Nothing here installs them, but a contributor's `npm i` or a local harvest
      // would otherwise be copied once per mutation. No gate reads them.
      !SKIP_COPY.has(path.basename(src)),
  });
  // The last step of copying, not the first step of indexing: run before `git init`, so
  // there is no `.git` in the copy for it to walk.
  materialize(dir, ROOT);
  // A repository of its own, with an index built from those records rather than copied.
  // `update-index --index-info` does not need the objects they name, and `git ls-files`
  // — the only git either gate runs — reads the index alone, so the copy sees the same
  // tracked set. A path that is tracked but absent from the working tree keeps its
  // entry, which is what makes a staged-then-deleted addition reproduce here.
  git(INIT, dir);
  assertNoEscape(dir, path.join(dir, ".git"));
  git(["update-index", "-z", "--index-info"], dir, TRACKED);
  return dir;
}

// Every path a mutation is about to touch, checked against the copy it belongs to. Four
// defects in this file have been the same sentence with a different subject — a worktree
// pointer file, an inherited `GIT_INDEX_FILE`, a split index, a symlink — and each was
// fixed by teaching the tool about one more layer that resolves a name to somewhere
// else. Nothing says that list is finished. So the rule is stated once, in code rather
// than in the comments above: resolve the name the way the kernel will, and refuse if
// the answer is not inside the copy. It costs two stats per mutation and does not depend
// on `materialize()` having been exhaustive, which is the assumption that keeps failing.
function inside(dir, rel) {
  const f = path.join(dir, rel);
  const leaf = path.join(fs.realpathSync(path.dirname(f)), path.basename(f));
  if (leaf !== dir && !leaf.startsWith(dir + path.sep)) {
    fail(`${rel} resolves to ${leaf}, which is outside the copy — refusing to write`);
  }
  if (fs.lstatSync(leaf, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fail(`${rel} is still a symlink inside the copy — refusing to write through it`);
  }
  return f;
}

function apply(dir, c) {
  if (c.edit) {
    const [rel, find, replace] = c.edit;
    const f = inside(dir, rel);
    const src = fs.readFileSync(f, "utf8");
    const n = src.split(find).length - 1;
    if (n !== 1) return `the mutation's anchor appears ${n} times in ${rel}, not once`;
    fs.writeFileSync(f, src.replace(find, replace));
  }
  if (c.append) {
    const [rel, text] = c.append;
    fs.appendFileSync(inside(dir, rel), text);
  }
  if (c.write) {
    const [rel, text] = c.write;
    fs.writeFileSync(inside(dir, rel), text);
    if (c.track) git(["add", "-f", "--", rel], dir);
  }
  if (c.remove) {
    fs.rmSync(inside(dir, c.remove), { force: true });
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

// `os.tmpdir()` honours TMPDIR, and a TMPDIR pointing into the checkout —
// `TMPDIR=$PWD/.tmp` — makes the destination a subdirectory of the source. `cpSync`
// refuses that outright, with `ERR_FS_CP_EINVAL` raised before the filter is consulted,
// so no skip list can rescue it: the run dies on a stack trace before a single gate has
// been asked anything. Measured.
//
// Refused rather than worked around. The obvious fallback — beside the repository —
// would put megabytes of copies in the parent of the checkout, which may itself be a
// repository, and they would then turn up in *its* `git status`: the exact signature of
// the `.git` defect above, reintroduced by the code whose job is containment.
function tmpBase() {
  const root = fs.realpathSync(ROOT);
  let dir;
  try {
    dir = fs.realpathSync(os.tmpdir());
  } catch (err) {
    fail(`${os.tmpdir()} cannot be used for the copies (${err.code}) — point TMPDIR somewhere writable`);
  }
  // Both sides are realpaths, so containment is a prefix. `path.relative` with a leading
  // `..` is not the same test: a directory named `..tmp` inside the checkout relativises
  // to `..tmp`, passes it, and dies on the ERR_FS_CP_EINVAL above. Reproduced.
  if (dir === root || dir.startsWith(root + path.sep)) {
    fail(`${dir} is inside the repository — point TMPDIR at a writable directory that is not`);
  }
  try {
    return fs.mkdtempSync(path.join(dir, "etapp-checkcheck-"));
  } catch (err) {
    fail(`cannot create a temporary directory in ${dir} (${err.code})`);
  }
}
const tmp = tmpBase();
// Every exit, not only the happy one. The base-tree guard's `process.exit(1)` skipped
// the cleanup at the end and left a ~2MB clone behind on each failed run.
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanup(); process.exit(130); });
const failures = [];

// Thirty-three claims say each gate can fail. Nothing has ever said the one thing this
// file promises about itself: that a run leaves the real tree exactly as it found it.
// Every breach of it so far — a worktree pointer, an inherited `GIT_INDEX_FILE`, a split
// index, a symlink — was found by a reviewer or by a contributor whose own files came
// back modified, which is the discovery channel this file's whole argument complains
// about. So the tree is fingerprinted before and after, and any difference is a failure
// that names the path.
//
// Stats are taken *through* a symlink on purpose: that is how the last breach escaped,
// and a link inside the tree pointing at a file outside it is the only way the damage is
// visible from in here. `.git` is not walked — it churns for its own reasons — but the
// two things a mutation could reach inside it are asked of git directly, which is how
// the first two breaches announced themselves: a file staged in the caller's own index.
function fingerprint() {
  const seen = [];
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name === ".git" || SKIP_COPY.has(entry.name)) continue;
      const here = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), here);
        continue;
      }
      const st = fs.statSync(path.join(dir, entry.name), { throwIfNoEntry: false });
      seen.push(st ? `${here} ${st.mode} ${st.size} ${st.mtimeMs} ${st.ino}` : `${here} — gone`);
    }
  };
  walk(ROOT, "");
  // One entry per record, not one entry per command: the difference is then the record
  // that moved rather than two copies of the whole index.
  for (const rec of git(["status", "--porcelain", "-z"], ROOT).split("\0").filter(Boolean)) seen.push(`git status: ${rec}`);
  for (const rec of git(["ls-files", "-s", "-z"], ROOT).split("\0").filter(Boolean)) seen.push(`git index: ${rec}`);
  return seen;
}
const BEFORE = fingerprint();

function assertTreeUntouched() {
  const after = fingerprint();
  const was = new Set(BEFORE);
  const now = new Set(after);
  const changed = [
    ...BEFORE.filter((l) => !now.has(l)).map((l) => `was  ${l}`),
    ...after.filter((l) => !was.has(l)).map((l) => `now  ${l}`),
  ].sort((a, b) => (a.slice(5) < b.slice(5) ? -1 : 1));
  if (!changed.length) return;
  console.error("\u2717 this run modified the repository it was supposed to only read\n");
  for (const line of changed.slice(0, 10)) console.error(`  ${line}`);
  if (changed.length > 10) console.error(`  … and ${changed.length - 10} more`);
  console.error("\n  (or someone edited the tree while it ran — check the paths above before believing this)");
  process.exit(1);
}

// The gates must all pass on the *unmutated* clone first. Otherwise a mutation that
// "fails" proves nothing — the gate was already red.
const base = clone(path.join(tmp, "base"));
const TIMEOUT = 180000;
function run(argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: ENV });
    let out = "";
    const take = (b) => { out += b; };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    // `killed` is carried out separately, because `close` reports a killed child as
    // `status: null` and null is not 0 — so a gate that printed its expected tag and
    // *then* hung looked exactly like a gate that failed for the right reason, and the
    // claim counted as held. Measured: tag printed, SIGKILL, `status=null`, verdict
    // "held". `spawnSync` had carried a `signal` that made this visible; the async
    // rewrite dropped it and nothing noticed, because a timeout is the one outcome
    // none of the 33 cases produce.
    let killed = false;
    const kill = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, TIMEOUT);
    child.on("error", (error) => { clearTimeout(kill); resolve({ error, out }); });
    child.on("close", (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, killed, out: out.trim() });
    });
  });
}

// `python3` missing, or a gate that hangs, is not a held claim — and `r.stdout` is
// `null` when the spawn itself failed, so the old `r.stdout + r.stderr` was `0` and
// `.trim()` threw a TypeError over the top of the real reason.
const output = (r) => [r.stdout, r.stderr].filter(Boolean).join("").trim();
const firstLines = (out) => out.split("\n").filter(Boolean).slice(0, 2).join(" / ").slice(0, 160);

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
// Through the same `run` the cases use. This loop had its own `spawnSync` with its own
// hardcoded 180000 — a second spelling of the timeout, and one that never learned the
// killed-vs-failed distinction the cases below now make.
for (const [name, argv] of Object.entries(GATES)) {
  const r = await run(argv, base);
  if (r.error) {
    console.error(`✗ ${name} could not be run at all (${argv.join(" ")}) — ${r.error.message}`);
    process.exit(1);
  }
  if (r.killed || r.signal) {
    console.error(`✗ ${name} did not finish on an unmutated tree (${r.killed ? `killed after ${TIMEOUT / 1000}s` : r.signal})`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`✗ ${name} does not pass on an unmutated tree — nothing below proves anything\n`);
    console.error(r.out || "(no output)");
    process.exit(1);
  }
}

// One case, start to finish, in its own directory. Returns the reason it did not hold,
// or null.
// `spawn`, not `spawnSync`. The first version of the pool below used `spawnSync` and
// bought nothing at all — 17s against 16s — because a synchronous spawn blocks the
// event loop, so four "workers" take their turns on one thread. Measured plainly:
// four 300ms children cost 1314ms with `spawnSync` in a loop and 344ms with `spawn`
// awaited together. The pool was real; the thing it was pooling was not.

async function judge(i, c) {
  const dir = clone(path.join(tmp, `m${i}`));
  try {
    const why = apply(dir, c);
    if (why) return `the mutation could not be applied — ${why}`;
    const r = await run(GATES[c.gate], dir);
    if (r.error) return `the gate could not be run — ${r.error.message}`;
    if (r.killed) return `the gate did not finish in ${TIMEOUT / 1000}s — it was killed, not failed`;
    if (r.signal) return `the gate died on ${r.signal} — that is not a failure it reported`;
    if (r.status === 0) return "the gate passed — this claim is not held";
    if (!named(r.out, c.expect)) {
      return `the gate failed but never mentioned ${JSON.stringify(c.expect)} — ` +
        `it may be failing for an unrelated reason: ${firstLines(r.out)}`;
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The cases are independent — each is its own copy of the tree and its own process —
// and the gates are the cost: about 90% of this step's wall clock, against 10% for the
// copying the comments above spend the most words on. Running them a few at a time
// took the whole run from roughly twenty seconds to under ten on a four-core machine.
//
// Sized by the machine, and the results are collected by index rather than in
// completion order, so the report reads the same however many ran at once. Nothing
// crosses between them: separate directories, separate processes, and the only shared
// state is this array, written from a single-threaded event loop.
const WIDTH = Math.max(1, Math.min(cases.length, os.availableParallelism?.() ?? 2));
const verdicts = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: WIDTH }, async () => {
    for (let i = next++; i < cases.length; i = next++) verdicts[i] = await judge(i, cases[i]);
  })
);
cases.forEach((c, i) => { if (verdicts[i]) failures.push([c, verdicts[i]]); });

// Before the verdict, and before the claim failures, because a tool that corrupted the
// tree has nothing worth saying about anything else.
assertTreeUntouched();

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
