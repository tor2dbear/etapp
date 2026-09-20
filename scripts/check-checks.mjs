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
  dependencies: ["python3", "scripts/check-dependencies.py"],
  lookups: ["node", "scripts/check-lookups.mjs"],
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
  { gate: "query", claim: "a puck named after what every object inherits is matched on what it carries",
    edit: ["app.js", "  var IS_STATES = table({", "  var IS_STATES = ({"], expect: "[inherited]" },
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

  // `depends:` is authored once and derived twice, so every claim here is really the
  // same claim: the board and the harvester are one rule, and the rule is the one
  // AGENTS.md documents. Each mutation breaks one of them and leaves the other
  // standing, which is the shape the gate exists to notice.
  { gate: "dependencies", claim: "the harvester counts one reference once",
    edit: ["scripts/harvest.mjs", "      if (seen.has(key)) continue;\n", ""], expect: "[harvest]" },
  { gate: "dependencies", claim: "…and so does the board",
    edit: ["app.js", "      if (seen[key]) return;\n", ""], expect: "[duplicate]" },
  // Same mutation as the claim above, a different consequence of it: `dependRefs` is
  // what the modal's chips and the picker's tokens both walk, so losing the rule there
  // has to be named twice. What this does *not* hold is the call sites — a chip loop
  // rewritten back to `item.depends` renders wrong and passes, because the gate lifts
  // bytes and cannot see calls. Stated rather than papered over.
  { gate: "dependencies", claim: "…and the list the modal's chips are drawn from",
    edit: ["app.js", "      if (seen[key]) return;\n", ""], expect: "[chips]" },
  { gate: "dependencies", claim: "removing a blocker removes every spelling of it",
    edit: ["app.js", "    return (item.depends || []).filter(function (r) { return refKey(item, r) !== key; });",
      "    return (item.depends || []).filter(function (r) { return r !== ref; });"],
    expect: "[remove]" },
  { gate: "dependencies", claim: "the corpus is large enough to hold the claims made about it",
    edit: ["scripts/dep-probe.mjs", "for (let i = 0; i < 1000; i++) CASES.push(randomGraph(i));\n", ""],
    expect: "[coverage]" },
  { gate: "dependencies", claim: "the two agree on what is settled",
    edit: ["app.js", 'var TERMINAL = table({ done: 1, cancelled: 1 });', 'var TERMINAL = table({ done: 1 });'],
    expect: "[agree]" },
  { gate: "dependencies", claim: "`blocks` is the mirror of `blockedBy`",
    edit: ["app.js", "      live.forEach(function (d) { d.blocks.push(it.id); });\n", ""],
    expect: "[mirror]" },
  { gate: "dependencies", claim: "a settled puck waits for nothing",
    edit: ["app.js", "      if (TERMINAL[it.status]) return; // landed", "      if (false) return; // landed"],
    expect: "[terminal]" },
  { gate: "dependencies", claim: "a reference that names nothing still blocks",
    edit: ["app.js", "it.blockedBy = live.map(function (d) { return d.id; }).concat(unresolved);",
      "it.blockedBy = live.map(function (d) { return d.id; });"],
    expect: "[unknown]" },
  { gate: "dependencies", claim: "every puck in a loop is flagged",
    edit: ["scripts/harvest.mjs", "if (component.length > 1) for (const c of component) cycles.add(c);",
      "if (component.length > 2) for (const c of component) cycles.add(c);"],
    expect: "[cycle]" },
  { gate: "dependencies", claim: "…including a puck that names itself",
    edit: ["scripts/harvest.mjs", "else if (deps.includes(node)) cycles.add(node);", "else if (false) cycles.add(node);"],
    expect: "[cycle]" },
  { gate: "dependencies", claim: "the note and the list it is built from move together",
    edit: ["app.js", "      it.signals = needs ? rest.concat([{ type: \"depends-missing\" }]) : rest;",
      "      it.signals = rest;"],
    expect: "[signal]" },
  { gate: "dependencies", claim: "…and the fence the board's half is lifted through",
    edit: ["app.js", "  // dep:begin\n", ""], expect: "exactly one" },

  // A lookup table that answers for `constructor` is one line away at all times: the
  // fix is that the tables have no prototype, so the mutations take that away again —
  // from the helpers, from one table, and from the check's own idea of what a table
  // looks like. The last is the first mutation in this file aimed at a gate's own
  // corpus rather than at the code it judges, which #8's review asked for.
  { gate: "lookups", claim: "a map built from data inherits nothing",
    edit: ["app.js", "  function dict() { return table(); }", "  function dict() { return Object.create({}); }"],
    expect: "[dict]" },
  { gate: "lookups", claim: "…and neither does a table",
    edit: ["app.js", "    var t = Object.create(null);", "    var t = {};"], expect: "[table]" },
  { gate: "lookups", claim: "…and a table keeps every key it was given",
    edit: ["app.js", "    for (var k in o) t[k] = o[k];", "    for (var k in o) if (k !== \"toString\") t[k] = o[k];"],
    expect: "[table]" },
  { gate: "lookups", claim: "no table indexed by a variable is left bare",
    edit: ["app.js", "  var LEGACY_SORT = table({ default: DEFAULT_SORT });", "  var LEGACY_SORT = { default: DEFAULT_SORT };"],
    expect: "[bare-table]" },
  { gate: "lookups", claim: "…nor is an empty object literal written anywhere",
    edit: ["app.js", "    var byKey = dict();\n    keys.forEach", "    var byKey = {};\n    keys.forEach"],
    expect: "[bare]" },
  { gate: "lookups", claim: "…and so is the second declarator of a list, which has no keyword in front of it",
    edit: ["app.js", "entry = table({ name: name })", "entry = { name: name }"],
    expect: "[bare-table]" },
  { gate: "lookups", claim: "…and the one object on the board that arrives parsed from outside it",
    edit: ["app.js", "        var parsed = JSON.parse(raw);\n        if (parsed && typeof parsed === \"object\") {\n          var o = table(parsed);",
      "        var parsed = JSON.parse(raw);\n        if (parsed && typeof parsed === \"object\") {\n          var o = parsed;"],
    expect: "[bare-table]" },
  // Five of the six findings this gate collected in review were one defect — the scan
  // could not see a shape — so the scan runs against a fixture that names every shape, and
  // these break the scan rather than the file. Without them the fixture is prose: it would
  // go on passing as the matcher it tests stopped matching. The sixth was the reading
  // itself, so the last three take the lexer apart in the three ways it was wrong or could
  // be, and the parser is what answers.
  { gate: "lookups", claim: "the matcher's own fixture notices a keyword it stops treating as optional",
    edit: ["scripts/check-lookups.mjs", "  const KEYWORD = `(?:\\\\b(?:var|let|const)\\\\s+)?`;", "  const KEYWORD = `(?:\\\\b(?:var|let|const)\\\\s+)`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a property path it stops following to the end",
    edit: ["scripts/check-lookups.mjs", "          if (last) hits.push(k);",
      "          if (false) hits.push(k);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a nested literal it stops calling bare",
    edit: ["scripts/check-lookups.mjs", "?(table\\\\(|dict\\\\(\\\\)|\\\\{|${ID}|)`;", "?(table\\\\(|dict\\\\(\\\\)|zzzz|${ID}|)`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and that path spelled with brackets on the assignment side",
    edit: ["scripts/check-lookups.mjs", "    const steps = segmentsOf(g.steps);",
      "    const steps = [...g.steps.matchAll(/\\.\\s*([A-Za-z_$][\\w$]*)/g)].map((piece) => piece[1]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a member assignment, which binds a path and not a name",
    edit: ["scripts/check-lookups.mjs", "    const into = path ? members : bound;\n    const key = path || root;",
      "    const into = bound;\n    const key = root;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and what a member assignment put at the end of a path",
    edit: ["scripts/check-lookups.mjs", "    for (const b of members.get(full) || []) if (hasPrototype(b.opens)) hits.push(b);",
      "    if (false) hits.push(...(members.get(root) || []));"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a binding pattern, which is not an empty map",
    edit: ["scripts/check-lookups.mjs", "          if (text[j] === \"{\" || (text[j] === \"=\" && text[j + 1] === \">\")) {", "          if (false) {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an arrow’s parameter, which is one of those",
    edit: ["scripts/check-lookups.mjs", "          if (text[j] === \"{\" || (text[j] === \"=\" && text[j + 1] === \">\")) {", "          if (text[j] === \"{\") {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a method’s, where the body follows the list directly",
    edit: ["scripts/check-lookups.mjs", "          if (text[j] === \"{\" || (text[j] === \"=\" && text[j + 1] === \">\")) {", "          if (text[j] === \"=\" && text[j + 1] === \">\") {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a condition, which is never a parameter list however it ends",
    edit: ["scripts/check-lookups.mjs", "        if (holder && holder.braces.length && !NOT_PARAMS.has(head)) {", "        if (holder && holder.braces.length) {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and only the braces in a binding position inside that list",
    edit: ["scripts/check-lookups.mjs", "    const binding = !!level && !level.value && !level.afterEq &&\n      (last === \"(\" || last === \",\" || last === \":\" || last === \"[\");",
      "    const binding = !!level;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a computed key that merely starts with a string",
    edit: ["scripts/check-lookups.mjs", "  const computed = (m) => inCode(m) && !constantKey(m.index + m[0].length - 1);",
      "  const computed = (m) => inCode(m) && code[m.index + m[0].length] !== '\"' && code[m.index + m[0].length] !== \"'\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and grouping parentheses around an inline literal",
    edit: ["scripts/check-lookups.mjs", "    if (!index.exec(code) || constantKey(index.lastIndex - 1)) continue;",
      "    continue;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a reserved word standing as a property name",
    edit: ["scripts/check-lookups.mjs", "      last = identStart !== \".\" && RESERVED.has(ident) && !VALUE_WORDS.has(ident) ? \"kw\" : \"w\";",
      "      last = RESERVED.has(ident) && !VALUE_WORDS.has(ident) ? \"kw\" : \"w\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and which brace is a function's body, once it has parameters",
    edit: ["scripts/check-lookups.mjs", "      if (maker !== null && nesting === makerAt + 1) { kind = maker ? \"fnvalue\" : \"block\"; maker = null; }",
      "      if (maker !== null) { kind = maker ? \"fnvalue\" : \"block\"; maker = null; }"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a regex that opens a labelled statement",
    edit: ["scripts/check-lookups.mjs", "last === \":label\" || REGEX_AFTER.has(last)",
      "REGEX_AFTER.has(last)"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a property whose value is a name, followed to what that name holds",
    edit: ["scripts/check-lookups.mjs", "        if (k.opens === \"dict()\" || k.opens === \"\") continue;",
      "        continue;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a contextual keyword used as an ordinary name",
    edit: ["scripts/check-lookups.mjs", "  \"typeof\", \"var\", \"void\", \"while\", \"with\",",
      "  \"typeof\", \"var\", \"void\", \"while\", \"with\", \"get\","],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a case label closed by a colon at its own depth",
    edit: ["scripts/check-lookups.mjs", "      const closesLabel = pendingLabel && nesting === labelDepth && !owed;",
      "      const closesLabel = pendingLabel && !owed;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a comma inside grouping parentheses, which ends nothing",
    edit: ["scripts/check-lookups.mjs", "      if (depth === 0 && !outer.length && c === \",\") break;",
      "      if (depth === 0 && c === \",\") break;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a name the lexer reads as a keyword but a script may legally bind",
    edit: ["app.js", "  function table(o) {", "  var await = 1;\n  function table(o) {"],
    expect: "[lex]" },
  { gate: "lookups", claim: "\u2026and either branch of a conditional initializer",
    edit: ["scripts/check-lookups.mjs", "      if (depth === 0 && c === \";\") break;",
      "      if (depth === 0) break;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a keyword a regex may follow, which is now an inversion",
    edit: ["scripts/check-lookups.mjs", "const VALUE_WORDS = new Set([\"this\", \"super\", \"true\", \"false\", \"null\"]);",
      "const VALUE_WORDS = new Set([\"this\", \"super\", \"true\", \"false\", \"null\", \"await\"]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "\u2026and a function body inside an initializer, which is not a map",
    edit: ["scripts/check-lookups.mjs", "        if (m && (m[0] !== \"{\" || kinds.get(i) === \"literal\")) found.push({ opens: m[0], at: i });",
      "        if (m) found.push({ opens: m[0], at: i });"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and parentheses around what a name is bound to",
    edit: ["scripts/check-lookups.mjs", "          (c === \"(\" && before !== \")\" && before !== \"]\" && !IDENT_PART.test(before));",
      "          false;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an async modifier, which changes no position",
    edit: ["scripts/check-lookups.mjs", "      if (ident === \"async\") { carried = { last, word }; }",
      "      if (false) { carried = { last, word }; }"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an optional chain, which is the same read",
    edit: ["scripts/check-lookups.mjs", "  const INDEX = `\\\\s*(?:\\\\?\\\\.)?\\\\s*\\\\[`;",
      "  const INDEX = `\\\\s*\\\\[`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and grouping parentheses around what is indexed",
    edit: ["scripts/check-lookups.mjs", "  const GROUPED = `(?<![\\\\p{ID_Continue}$)\\\\]])\\\\(\\\\s*`;",
      "  const GROUPED = `(?<![\\\\p{ID_Continue}$)\\\\]])zzzz\\\\(\\\\s*`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a label\u2019s colon, which it then reads as a property\u2019s",
    edit: ["scripts/check-lookups.mjs", "      last = closesLabel || (last === \"w\" && statementPlace(identStart)) ? \":label\" : \":\";",
      "      last = \":\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a function expression, whose body closes a value",
    edit: ["scripts/check-lookups.mjs", "      if (maker !== null && nesting === makerAt + 1) { kind = maker ? \"fnvalue\" : \"block\"; maker = null; }\n",
      "      if (maker !== null && nesting === makerAt + 1) { kind = \"block\"; maker = null; }\n"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and which side of the keyword decides that",
    edit: ["scripts/check-lookups.mjs", "        maker = opensValue(from.last, from.word);",
      "        maker = false;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an empty block, which it then calls an empty map",
    edit: ["scripts/check-lookups.mjs", "    if (kinds.get(m.index) !== \"literal\") continue;", "    if (false) continue;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a quoted key no identifier could spell",
    edit: ["scripts/check-lookups.mjs", "  const QUOTED = new RegExp(`(${STRING})\\\\s*:\\\\s*${VALUE}`, \"yu\");",
      "  const QUOTED = new RegExp(`(\"${ID}\")\\\\s*:\\\\s*${VALUE}`, \"yu\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a postfix update, after which a slash is division",
    edit: ["scripts/check-lookups.mjs", "      else if ((c === \"+\" || c === \"-\") && last === c) last = \"++\";",
      "      else if (false) last = \"++\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a property path spelled with brackets",
    edit: ["scripts/check-lookups.mjs", "  const SEGMENT = new RegExp(`\\\\.\\\\s*(${ID})|\\\\[\\\\s*(${STRING})\\\\s*\\\\]`, \"gu\");",
      "  const SEGMENT = new RegExp(`\\\\.\\\\s*(${ID})|\\\\[zzzz\\\\s*(${STRING})\\\\s*\\\\]`, \"gu\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an object literal it stops telling apart from a block",
    edit: ["scripts/check-lookups.mjs", "const VALUE_AFTER = new Set(\"=(,:[?!&|+-*/%~^<>\".split(\"\"));", "const VALUE_AFTER = new Set([]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the code inside a template substitution",
    edit: ["scripts/check-lookups.mjs", "if (c === \"$\" && text[i + 1] === \"{\")", "if (false && text[i + 1] === \"{\")"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a regex after a control-flow paren, which it then reads as division",
    edit: ["scripts/check-lookups.mjs", "const CONTROL = new Set([\"if\", \"while\", \"for\", \"with\"]);",
      "const CONTROL = new Set([]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a receiver it stops keeping when the path’s root is not a name",
    edit: ["scripts/check-lookups.mjs", "`(?<![\\\\p{ID_Continue}$.)\\\\]])(?:${KEYWORD}", "`(?:${KEYWORD}"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a name assigned onto a property, which is that path’s and not the root’s",
    edit: ["scripts/check-lookups.mjs", "      if (path) link(memberHolds, path, held);", "      if (false) link(memberHolds, path, held);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a namesake property the alias side must not conflate either",
    edit: ["scripts/check-lookups.mjs", "      if (path) link(memberHolds, path, held);",
      "      if (path) { link(memberHolds, path, held); link(holders, held, steps[steps.length - 1]); }"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that name followed into its binding at the end of the path",
    edit: ["scripts/check-lookups.mjs", "    for (const held of memberHolds.get(full) || []) {", "    for (const held of []) {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a name that is the whole initialiser, whatever it is wrapped in",
    edit: ["scripts/check-lookups.mjs", "    commit();\n    return { found, holds: list, at };", "    return { found, holds: list, at };"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a branch of a conditional, which is one of its values",
    edit: ["scripts/check-lookups.mjs", "        else if (c === \":\") branch(true);", "        else if (c === \":\") branch(false);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an index, which is not the map it reads from",
    edit: ["scripts/check-lookups.mjs", "        if (!grouping && depth === 0) {\n          poisoned = true;", "        if (false) {\n          poisoned = true;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an operand, which is not the value of the expression it is in",
    edit: ["scripts/check-lookups.mjs", "        else if (!/[([{)\\]}]/.test(c) && c !== \";\" && c !== \",\") {\n          poisoned = true;",
      "        else if (false) {\n          poisoned = true;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the expression a parenthesis sits in, which it stops remembering",
    edit: ["scripts/check-lookups.mjs", "          poisoned = saved.poisoned;", "          poisoned = false;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the last operand inside it, which is what a parenthesis is worth",
    edit: ["scripts/check-lookups.mjs", "          commit();\n          const inner = list;", "          const inner = list;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an operand that stops being a name after it has been read",
    edit: ["scripts/check-lookups.mjs", "      if (!poisoned) for (const name of current) if (!ALIAS_SKIP.has(name)) list.push(name);",
      "      for (const name of current) if (!ALIAS_SKIP.has(name)) list.push(name);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the left of a `||`, which an object wins",
    edit: ["scripts/check-lookups.mjs", "        else if (c === \"|\") branch(true);", "        else if (c === \"|\") branch(false);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the left of an `&&`, which it never does",
    edit: ["scripts/check-lookups.mjs", "        else if (c === \"&\") branch(false);", "        else if (c === \"&\") branch(true);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and what a closing brace closes, before calling it a literal",
    edit: ["scripts/check-lookups.mjs", "    if (closes.get(m.index) !== \"literal\") continue;", "    if (false) continue;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a nullish fallback, which is not the conditional it starts like",
    edit: ["scripts/check-lookups.mjs", "        } else if (c === \"?\") branch(code[i + 1] === \"?\");", "        } else if (c === \"?\") branch(false);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a logical assignment, which puts its right side in the name",
    edit: ["scripts/check-lookups.mjs", "\\s*(?:\\\\|\\\\||&&|\\\\?\\\\?)?=(?![=>])", "\\s*=(?![=>])"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an assignment expression, which is worth its right-hand side",
    edit: ["scripts/check-lookups.mjs", "        else if (c === \"=\" && !/[!<>+\\-*/%&|^=]/.test(before)) branch(false);\n", ""],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the `=` of a comparison, which is not one of those",
    edit: ["scripts/check-lookups.mjs", "        else if (c === \"=\" && !/[!<>+\\-*/%&|^=]/.test(before)) branch(false);",
      "        else if (c === \"=\") branch(false);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and grouping parentheses around a target, or around its root",
    edit: ["scripts/check-lookups.mjs", "  const ROOT = (tag) => `(?:\\\\(\\\\s*(?<p${tag}>${ID})\\\\s*\\\\)|(?<n${tag}>${ID}))`;",
      "  const ROOT = (tag) => `(?:zzzz(?<p${tag}>${ID})zzzz|(?<n${tag}>${ID}))`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a conditional inside a case expression, which owes the colon",
    edit: ["scripts/check-lookups.mjs", "    if (c === \"?\" && pendingLabel && nesting === labelDepth && text[i + 1] !== \".\" && text[i + 1] !== \"?\" && last !== \"?\") ternaries++;\n", ""],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a destructuring assignment, which is a target and not a map",
    edit: ["scripts/check-lookups.mjs", "    if (patternTarget(m.index + m[0].length)) continue;\n", ""],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the alphabet JavaScript spells names in, which is not ASCII",
    edit: ["scripts/check-lookups.mjs", "const ID = \"[\\\\p{ID_Start}$_][\\\\p{ID_Continue}$\\\\u200C\\\\u200D]*\";",
      "const ID = \"[A-Za-z_$][\\\\w$]*\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a letter inside one, which the walk must not read as an operator",
    edit: ["scripts/check-lookups.mjs", "const IDENT_PART = /[\\p{ID_Continue}$\\u200C\\u200D]/u;", "const IDENT_PART = /[\\w$]/;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and where a name begins, which an ASCII boundary cannot say",
    edit: ["scripts/check-lookups.mjs", "  const EDGE = `(?<![.\\\\p{ID_Continue}$])`;", "  const EDGE = `\\\\b`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and every spelling of a constant number, not the two this file writes",
    edit: ["scripts/check-lookups.mjs", "        if (/[\\w.]/.test(code[i])) { i++; continue; }", "        if (/[\\d.]/.test(code[i])) { i++; continue; }"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a sign in front of one, which only counts before a digit",
    edit: ["scripts/check-lookups.mjs", "} else if (/\\d/.test(quote) || ((quote === \"-\" || quote === \"+\") && /\\d/.test(code[i + 1]))) {",
      "} else if (/\\d/.test(quote)) {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a key after a nested literal, which the depth counter must not lose",
    edit: ["scripts/check-lookups.mjs", "      for (const ch of (wrap ? wrap[0] : \"\") + opens) depth += delta(ch);\n", ""],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a name spliced into a pattern, where `$` is an anchor and not a letter",
    edit: ["scripts/check-lookups.mjs", "  const escapeRe = (name) => name.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");",
      "  const escapeRe = (name) => name;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the literal a wrapper opens, which is the one at it",
    edit: ["scripts/check-lookups.mjs", "    if (code[open] !== \"{\") return null;",
      "    if (code[open] !== \"{\") { open = code.indexOf(\"{\", open); if (open === -1) return null; }"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a property spelled like a variable, which is not that variable",
    edit: ["scripts/check-lookups.mjs", "  const EDGE = `(?<![.\\\\p{ID_Continue}$])`;", "  const EDGE = `(?<![\\\\p{ID_Continue}$])`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a contextual keyword in a parameter, which binds it just as well",
    append: ["app.js", "\nfunction zzContextual(await) { return await / 2; }\n"],
    expect: "[lex]" },
  { gate: "lookups", claim: "…and a parenthesised expression, whose value the walk already knows",
    edit: ["scripts/check-lookups.mjs", "    const { holds, at } = readInitialiser(m.index + m[0].length, true, !!throughAt(m[0]));", "    const { holds, at } = { holds: [], at: 0 };"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a comma inside one, which is a sequence and not a declarator’s end",
    edit: ["scripts/check-lookups.mjs", "    const outer = inGroup ? [{ list: [], poisoned: false, through: !!inThrough }] : [];", "    const outer = [];"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a path read off a parenthesised expression",
    edit: ["scripts/check-lookups.mjs", "    .concat(grouped.filter((g) => g.steps.length).map((g) => ({ roots: g.holds, path: g.steps })));", "    .concat([]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that a name bound more than once is said to be",
    edit: ["scripts/check-lookups.mjs", "      const shared = bindings.length > 1 ? `, one of ${bindings.length} bindings of that name, which this cannot tell apart` : \"\";", "      const shared = \"\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a floor on what the analysis *reaches*, not only on what it counts",
    edit: ["scripts/check-lookups.mjs", "  const INDEXED = new RegExp(`${rooted(`(${ID})`)}${INDEX}`, \"gu\");", "  const INDEXED = new RegExp(`zzzz${INDEX}`, \"gu\");"],
    expect: "[coverage]" },
  { gate: "lookups", claim: "…and a shorthand property, which is its own value",
    edit: ["scripts/check-lookups.mjs", "|(?=[,}]|$))`, \"yu\");", "|(?=zzzz))`, \"yu\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the last one in a literal, which no comma or brace follows",
    edit: ["scripts/check-lookups.mjs", "|(?=[,}]|$))`, \"yu\");", "|(?=[,}]))`, \"yu\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a method, which is a name followed by a parenthesis and not one",
    edit: ["scripts/check-lookups.mjs", "      const short = bare && m[2] === undefined;", "      const short = bare;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a call that hands back what it was given, which is not a factory",
    edit: ["scripts/check-lookups.mjs", "        if (THROUGH_STICKY.exec(code)) { i = THROUGH_STICKY.lastIndex - 2; continue; }",
      "        if (false) { i = THROUGH_STICKY.lastIndex - 2; continue; }"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and one of those around a property’s value",
    edit: ["scripts/check-lookups.mjs", "  const VALUE = `(?:${THROUGH}\\\\s*)?(table\\\\(|dict\\\\(\\\\)|\\\\{|${ID}|)`;",
      "  const VALUE = `(table\\\\(|dict\\\\(\\\\)|\\\\{|${ID}|)`;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and one around a literal indexed on the spot",
    edit: ["scripts/check-lookups.mjs", "`(?:${GROUPED}|${THROUGH}\\\\s*)(?=\\\\{)`", "`${GROUPED}(?=\\\\{)`"],
    expect: "[fixture]" },
  // Round 37, and the rule is one word wider than round 36 wrote it: what these calls hand
  // back is their *first argument*. The three the earlier round knew are the three whose
  // argument is also their only one, which is how the other half went missing.
  { gate: "lookups", claim: "…and the rest of that family, which is told by what it returns",
    edit: ["scripts/check-lookups.mjs", "const THROUGH_CALLS = [\"freeze\", \"seal\", \"preventExtensions\", \"defineProperty\", \"defineProperties\", \"assign\"];",
      "const THROUGH_CALLS = [\"freeze\", \"seal\", \"preventExtensions\"];"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that only the first of such a call's arguments is its value",
    edit: ["scripts/check-lookups.mjs", "          if (outer[outer.length - 1].through) {", "          if (false) {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the arguments after a literal indexed on the spot",
    edit: ["scripts/check-lookups.mjs", "    if (code[i] === \",\" && throughAt(m[0])) i = restOfCall(i);\n", ""],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a name indexed on the spot through one",
    edit: ["scripts/check-lookups.mjs", "new RegExp(`(?:${GROUPED}|${THROUGH}\\\\s*)`, \"gu\")", "new RegExp(GROUPED, \"gu\")"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the wrapper a key's value was read through, whose bracket counts too",
    edit: ["scripts/check-lookups.mjs", "      for (const ch of (wrap ? wrap[0] : \"\") + opens) depth += delta(ch);",
      "      for (const ch of opens) depth += delta(ch);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that somebody else's call of that name is not one of them",
    edit: ["scripts/check-lookups.mjs", "(?<![\\\\p{ID_Continue}$.])Object", "Object"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the flag that makes that lookbehind's alphabet an alphabet",
    edit: ["scripts/check-lookups.mjs", "const THROUGH_END = new RegExp(`${THROUGH}$`, \"u\");", "const THROUGH_END = new RegExp(THROUGH + \"$\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an empty pattern that is a for-of target",
    edit: ["scripts/check-lookups.mjs", "  const TARGET_WORD = /^(?:of|in)(?![\\p{ID_Continue}$])/u;", "  const TARGET_WORD = /^(?:in)(?![\\p{ID_Continue}$])/u;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a for-in one",
    edit: ["scripts/check-lookups.mjs", "  const TARGET_WORD = /^(?:of|in)(?![\\p{ID_Continue}$])/u;", "  const TARGET_WORD = /^(?:of)(?![\\p{ID_Continue}$])/u;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that `for await (` is a for head, whose brace is no parameter's",
    edit: ["scripts/check-lookups.mjs", "      heads.push(word === \"await\" && prev === \"for\" ? \"for\" : word);", "      heads.push(word);"],
    expect: "[fixture]" },
  // Round 38: a pattern nests and a default value does not, which is one sentence and eight
  // claims, because each half is wrong in a different direction.
  { gate: "lookups", claim: "…and a pattern written inside a pattern",
    edit: ["scripts/check-lookups.mjs", "      (last === \"(\" || last === \",\" || last === \":\" || last === \"[\");",
      "      (last === \"(\" || last === \",\" || last === \"[\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and one written inside an array pattern",
    edit: ["scripts/check-lookups.mjs", "      (last === \"(\" || last === \",\" || last === \":\" || last === \"[\");",
      "      (last === \"(\" || last === \",\" || last === \":\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that everything inside a value is a value, however it nests",
    edit: ["scripts/check-lookups.mjs", "if (holder && (c === \"{\" || c === \"[\")) holder.levels.push({ value: !binding, afterEq: false });",
      "if (holder && (c === \"{\" || c === \"[\")) holder.levels.push({ value: false, afterEq: false });"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that an `=` starts a default value, which is not a pattern",
    edit: ["scripts/check-lookups.mjs", "      else if (c === \"=\" && !/[!<>+\\-*/%&|^=]/.test(last) && text[i + 1] !== \"=\" && text[i + 1] !== \">\") level.afterEq = true;",
      "      else if (false) level.afterEq = true;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and that the comma after one ends it",
    edit: ["scripts/check-lookups.mjs", "      if (c === \",\") level.afterEq = false;", "      if (false) level.afterEq = false;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a substitution, whose brace the level stack must hear about",
    edit: ["scripts/check-lookups.mjs", "        if (parens.length) parens[parens.length - 1].levels.push({ value: true, afterEq: false });\n", ""],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a switch head, whose body is not a parameter list's",
    edit: ["scripts/check-lookups.mjs", "const NOT_PARAMS = new Set([...CONTROL, \"switch\"]);", "const NOT_PARAMS = new Set([...CONTROL]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a computed constant key, which is a key",
    edit: ["scripts/check-lookups.mjs", "  const COMPUTED = new RegExp(`\\\\[\\\\s*(${STRING})\\\\s*\\\\]\\\\s*:\\\\s*${VALUE}`, \"yu\");",
      "  const COMPUTED = new RegExp(`zzzz\\\\s*(${STRING})\\\\s*\\\\]\\\\s*:\\\\s*${VALUE}`, \"yu\");"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the brackets that open no key, which are a nesting",
    edit: ["scripts/check-lookups.mjs", "        if (!quoted) depth += delta(c);\n        continue;", "        continue;"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an alias it stops walking out to",
    edit: ["scripts/check-lookups.mjs", "const by = [...spread(name, holders)].find(indexedByAVariable);",
      "const by = [name].find(indexedByAVariable);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an alias it stops walking back from",
    edit: ["scripts/check-lookups.mjs", "  const bindingsOf = (name) => [...spread(name, heldFrom)].flatMap((held) => bound.get(held) || []);",
      "  const bindingsOf = (name) => bound.get(name) || [];"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and an object factory it stops counting as one",
    edit: ["scripts/check-lookups.mjs", "const hasPrototype = (opens) => opens === \"{\" || FACTORY.test(opens);",
      "const hasPrototype = (opens) => opens === \"{\";"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and a string whose contents it stops holding apart from code",
    edit: ["scripts/check-lookups.mjs", "      cover(i, j);\n      i = j;\n      last = c;",
      "      cover(i, i);\n      i = j;\n      last = c;"],
    expect: "[fixture]" },
  // Like the regex claim below it, this break trips the fixture first — the gate stops there
  // and the parser never speaks. The judge keeps a claim of its own, the next one: a block
  // comment's closing `*/`, which the fixture has no instance of and app.js has four.
  { gate: "lookups", claim: "a `//` inside a string is not the start of a comment",
    edit: ["scripts/check-lookups.mjs", "    if (c === '\"' || c === \"'\") {", "    if (c === \"\\u0000\") {"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and where a block comment ends, which only the parser notices",
    edit: ["scripts/check-lookups.mjs", "      const j = end === -1 ? text.length : end + 2;", "      const j = end === -1 ? text.length : end;"],
    expect: "[lex]" },
  // The fixture answers this one before the parser does — the line it added in round 6, a
  // regex holding a quote, is exactly this break — and since the gate stops when its own
  // fixture fails, `[fixture]` is the tag that arrives. The judge still has three claims of
  // its own for breaks the fixture does not see.
  { gate: "lookups", claim: "…and a regex is not a pair of quotes either",
    edit: ["scripts/check-lookups.mjs", "const REGEX_AFTER = new Set(\"(,=:[!&|?{};+-*%~^<>\".split(\"\").concat([\"=>\"]));",
      "const REGEX_AFTER = new Set([]);"],
    expect: "[fixture]" },
  { gate: "lookups", claim: "…and the shape it counts as wrapped still matches the file",
    edit: ["scripts/check-lookups.mjs", "filter((b) => b.opens === \"table(\")", "filter((b) => b.opens === \"zzzzz(\")"],
    expect: "[coverage]" },
  { gate: "lookups", claim: "…on the half that covers data too, which had no floor at all",
    edit: ["scripts/check-lookups.mjs", "code.matchAll(/\\bdict\\(\\)/g)", "code.matchAll(/\\bzzzz\\(\\)/g)"],
    expect: "[coverage]" },
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
// As bytes, and handed to `update-index` as bytes: `encoding: "utf8"` turns a filename
// byte that is not valid UTF-8 into U+FFFD, and the copy's index would then carry a path
// naming no file. Nothing here needs to read these records, only to pass them on, so they
// are never decoded at all — the same lesson as `-z`, one layer further down.
const TRACKED = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: ROOT, env: ENV });

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

// A FIFO, a socket or a device node cannot be copied at all: `cpSync` dies on an internal
// assertion — "Unreachable code", with a stack trace asking you to file a Node bug —
// before the base tree is even built. Reproduced with `mkfifo roadmap/test.pipe`. A dev
// server's socket inside a checkout is an ordinary thing to have, and no gate can read
// one either, so it is left out rather than allowed to make the check unrunnable.
function copyable(src) {
  const st = fs.lstatSync(src, { throwIfNoEntry: false });
  return !!st && (st.isFile() || st.isDirectory() || st.isSymbolicLink());
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
function materialize(copy, src, dropped = []) {
  for (const entry of fs.readdirSync(copy, { withFileTypes: true })) {
    const p = path.join(copy, entry.name);
    const source = path.join(src, entry.name);
    if (entry.isDirectory()) {
      materialize(p, source, dropped);
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
    // A link whose target is gone leaves its path behind for the stand-in below, because
    // dropping it was a second way to make the baseline lie: `check-bundle` reads the
    // directory entry, not the target, so a root-level `loose-link -> /definitely/not/here`
    // was red out there and green in here. Measured.
    if (!target) {
      dropped.push(path.relative(ROOT, source));
      continue;
    }
    // `copyFileSync` reads through the link kernel-side and, the destination having just
    // been removed, creates it with the source's mode — 755 stays 755 under a 077 umask,
    // measured. No whole file through the heap and no separate chmod to forget.
    fs.copyFileSync(source, p);
  }
  return dropped;
}

// The skip is an optimisation, so it must not change a single answer: one of these
// directories holding a *tracked* file means `git ls-files` hands that path to the gates
// while the copy has no such file. Measured on a tracked `.wrangler/vendor.js` — the real
// syntax gate green, the copy's baseline red, the guard refusing to run on a tree that
// was perfectly fine. Skipped only when nothing tracked lives underneath, which is the
// case that made it worth skipping.
const TRACKED_PATHS = TRACKED.toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((rec) => rec.slice(rec.indexOf("\t") + 1));

function skipped(src) {
  if (!SKIP_COPY.has(path.basename(src))) return false;
  const rel = path.relative(ROOT, src).split(path.sep).join("/") + "/";
  return !TRACKED_PATHS.some((t) => t.startsWith(rel));
}

// Relative, so it resolves beside the link and therefore inside the copy. The name is not
// assumed to be free: a tracked file sitting at it made the stand-in *resolve*, so a
// tracked dangling `collision.js` read as that file's contents and the copy reported four
// claims held while the real syntax gate was red. Measured. So the name is tried until
// the link demonstrably dangles, and asked of the result rather than of the odds.
const MISSING = ".etapp-entry-that-could-not-be-copied";

function standIn(p) {
  for (let n = 0; n < 100; n++) {
    fs.symlinkSync(n ? `${MISSING}-${n}` : MISSING, p);
    if (!fs.existsSync(p)) return; // follows the link: false means it dangles, which is the point
    fs.unlinkSync(p);
  }
  fail(`cannot place a stand-in for ${path.relative(ROOT, p)} that does not resolve to something`);
}

function clone(dir) {
  const special = [];
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
      !skipped(src) &&
      (copyable(src) || (special.push(path.relative(ROOT, src)), false)),
  });
  // The last step of copying, not the first step of indexing: run before `git init`, so
  // there is no `.git` in the copy for it to walk.
  const dropped = materialize(dir, ROOT);
  // Two kinds of entry cannot be brought over — one that cannot be copied at all, and a
  // link with nothing at the end of it — and both get the same stand-in, because the
  // mistake was the same both times: leaving the path out. `check-bundle` reads directory
  // entries off the disk, so a root-level FIFO, and then a root-level dangling link, each
  // made the real gate red while the copy's baseline came back green — the guard that
  // exists to refuse a red tree certifying against a tree that was not the tree. Measured
  // both times, both reported by review rather than by this file.
  //
  // A link that dangles *inside* the copy, rather than an empty file: it keeps the path
  // where every gate can see it and keeps it unreadable, which is what the original is.
  // An empty file would have parsed cleanly as a tracked `.js` that is really a broken
  // link — green here, red out there, the same lie one layer down.
  for (const rel of special.concat(dropped)) standIn(inside(dir, rel));
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

// Every claim below says a gate can fail. Nothing has ever said the one thing this
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
      if (entry.name === ".git" || skipped(path.join(dir, entry.name))) continue;
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
    // none of the cases produce.
    let killed = false;
    const kill = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, TIMEOUT);
    child.on("error", (error) => { clearTimeout(kill); resolve({ error, out }); });
    child.on("close", (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, killed, out: out.trim() });
    });
  });
}

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
