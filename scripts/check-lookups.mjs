#!/usr/bin/env node
// Can a lookup table answer for a key nobody put in it?
//
// A JavaScript object inherits `constructor`, `toString`, `valueOf`, `hasOwnProperty`
// and the rest, so `TABLE[k]` returns something for those names whether or not the
// table has them. The board is full of tables indexed by strings from outside — a URL
// parameter, a term someone typed, a field written in someone else's puck — and three
// of those answers were reachable before this check existed:
//
//   ?sort=constructor    the board died on "raw.split is not a function", because
//                        `LEGACY_SORT[raw]` handed back the Object constructor
//   agent: constructor   grouping by Agent died on `byKey[k].push`, and the sidebar
//                        counted the agent as "function Object() { [native code] }1"
//   tag: toString        the same, in ⌘K's tag counts
//
// `agent:`, `owner:` and `tags:` are free text in a puck, and a puck is plain markdown
// in someone else's repository. So this is not a hypothetical key, and the remedy is
// not a list of the places that need guarding — it is that the tables have no prototype
// to inherit from. Two questions here, and the second is the one that keeps it true:
//
//   1. do `table()` and `dict()` — the board's own, lifted from the file that ships —
//      actually produce objects with no inherited answers?
//   2. is every top-level lookup table in app.js built through `table()`?
//
// The second is a source assertion because that is where the next one will appear: a
// new `var SOMETHING = { … }` indexed by a URL parameter is one line, and nothing else
// would notice it.
//
// What this does NOT check is the behaviour end to end — that every puck still lands in
// exactly one column when its `agent` is named `constructor`. That needs the board in a
// browser, which a zero-build, dependency-free repository cannot ask CI for. It was
// measured by hand instead, in headless Chromium, and the transcript is in the pull
// request that introduced this file.
//
// Node builtins only, like the rest of scripts/.
import vm from "node:vm";
import { liftRegion } from "./lib/region.mjs";

const failures = [];
const fail = (check, detail) => failures.push([check, detail]);

// ── 1. the helpers, as the browser gets them ────────────────────────────────────
const { src, region } = liftRegion("app.js", "dict");
const { table, dict } = new Function(`"use strict";\n${region}\nreturn { table, dict };`)();

// One question, not a list of inherited names. A list would be the hand-maintained
// thing this file exists to argue against — and it is weaker: an object whose prototype
// is `Object.prototype` with `constructor` and `toString` deleted would pass a list and
// fail this. The three names that actually cost a crash are in the header, where they
// belong, as history rather than as the assertion.
for (const [what, made] of [["dict", dict()], ["table", table({})], ["table", table()]]) {
  if (Object.getPrototypeOf(made) !== null) fail(what, `${what}() returned an object with a prototype`);
}
// And it still has to be a table: what goes in comes out, including under the name that
// cost the crash. `__proto__` is not in this round trip and cannot be — in a source
// literal it sets the prototype rather than a key, so the argument never carries it.
// It is checked on `dict()` instead, which is the half that receives data: on a normal
// object that assignment replaces the prototype and stores nothing, so a tag or an agent
// actually called `__proto__` would vanish from a count and take the object with it.
const t = table({ now: "Now", constructor: "C", toString: "T" });
for (const [k, v] of [["now", "Now"], ["constructor", "C"], ["toString", "T"]]) {
  if (t[k] !== v) fail("table", `table() lost ${k}: ${String(t[k])} instead of ${v}`);
}
if (Object.keys(t).length !== 3) fail("table", `table() kept ${Object.keys(t).length} of 3 keys`);
const d = dict();
d["__proto__"] = "P";
d["constructor"] = "C";
if (d["__proto__"] !== "P") fail("dict", "dict() treated __proto__ as the prototype rather than a key");
if (Object.keys(d).length !== 2) fail("dict", `dict() kept ${Object.keys(d).length} of 2 data keys`);

// ── 2. nothing in app.js is built with a prototype ──────────────────────────────
// This was two heuristics: one asking whether a capitalised table was wrapped, one
// asking whether a lowercase map was indexed by a variable somewhere in its block. Both
// answered "is this a lookup table?" by guessing, and both were blind — a map spelled
// `cols: {}` inside a larger literal was neither, and it was live: `data-col` is a group
// key, so with a puck whose agent is named `constructor` the board read the Object
// constructor back out and assigned a function to `scrollTop`.
//
// So the rule is a construction instead of a guess: **an empty object literal is not
// written in this file**. `dict()` makes a map, `table()` makes a lookup, and a
// non-empty literal is a record — it has its keys written out, which is what makes it
// not the shape that means "something will fill this". Nothing needs to decide whether a
// given map is "indexed by data", which is the judgement that kept being wrong.
//
// The rest is the *other* half of the rule — an object that something indexes with a key
// that is not a literal — and it has now been wrong in seven different ways, once per
// round of review. Six were the same defect: the scan could not see a shape, and nothing
// here said which shapes it could see. So the scan is a function of text, and the fixture
// below is the list, with the answer written next to each line. A shape the matcher stops
// seeing is a failing gate now, not a success line that has quietly stopped meaning
// anything — and what the success line is allowed to say is bounded by that list.
//
// The sixth was the text itself. Blanking a comment by cutting each line at its first
// `//` cuts `"https://api.github.com/repos/"` in half — 34 lines of app.js, and every
// one of them left an unterminated quote for the brace scanner to inherit. So this reads
// the file the way the file is written.

// A comment is `//` outside a string, and `"` is a delimiter outside a regex, and there
// is no way to know which is which except in order. Comments are blanked (spaces, so the
// offsets — and the line numbers reported from them — still point at the real file) and
// the strings, templates and regex literals are *masked*: their text is left in place and
// marked, so a `{`, a `//` or a `constructor` inside one is never mistaken for code.
//
// `/` is the ambiguous one — regex or division — and it is read from what precedes it,
// which is the ordinary rule and is not exact: `(a + b) / 2` and `if (x) /re/.test(y)`
// are both a `/` after `)`. This resolves it as division, and the assertion below is what
// makes that safe rather than assumed.
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%~^<>".split(""));
const REGEX_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else"]);

function lex(text) {
  const out = text.split("");
  const mask = new Uint8Array(text.length);
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const cover = (from, to) => { for (let k = from; k < to; k++) mask[k] = 1; };
  let i = 0;
  let last = "";
  let word = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? text.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) { j++; break; }
        j++;
      }
      cover(i, j);
      i = j;
      last = c;
      word = "";
      continue;
    }
    if (c === "/" && (last === "" || REGEX_AFTER.has(last) || REGEX_WORDS.has(word))) {
      // A character class can hold an unescaped `/`, so the closing one is only the one
      // outside `[…]`. An opener with no closer on its line was not a regex after all.
      let j = i + 1;
      let klass = false;
      let closed = false;
      while (j < text.length && text[j] !== "\n") {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") klass = true;
        else if (d === "]") klass = false;
        else if (d === "/" && !klass) { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        while (j < text.length && /[a-z]/.test(text[j])) j++;
        cover(i, j);
        i = j;
        last = "/";
        word = "";
        continue;
      }
    }
    if (/\S/.test(c)) {
      last = c;
      word = /[\w$]/.test(c) ? word + c : "";
    }
    i++;
  }
  return { code: out.join(""), mask };
}

function survey(text) {
  const { code, mask } = lex(text);
  const notes = [];
  const lineOf = (index) => code.slice(0, index).split("\n").length;
  const seen = new Set();
  const note = (check, at, subject, what) => {
    if (seen.has(check + at)) return;
    seen.add(check + at);
    notes.push({ check, line: lineOf(at), subject, what });
  };
  // Every scan below starts from a position outside a string, a template or a regex —
  // this is the one place that is said, rather than nine quote-tracking loops.
  const inCode = (m) => !mask[m.index];

  // Whitespace included, and over the whole source rather than line by line: `{ }` and a
  // literal broken across two lines are the same empty object, and both sailed past a
  // `/\{\}/` that matched only the bare token — measured, with the gate still reporting
  // that the file writes none. Three spellings are not a map and are left alone: an empty
  // catch, an empty function body, and the two-character string.
  const EXEMPT = [/catch\s*\([^)]*\)\s*$/, /function[^)]*\)\s*$/, /=>\s*$/];
  for (const m of [...code.matchAll(/\{\s*\}/g)].filter(inCode)) {
    if (EXEMPT.some((re) => re.test(code.slice(0, m.index).trimEnd()))) continue;
    note("bare", m.index, null, `an empty object literal: ${m[0].replace(/\s+/g, " ")}`);
  }

  // Every name bound to an object, however the binding is spelled. The keyword is
  // optional, and that is the whole point: `var X = {` is one way, `x = {` after the
  // declaration is another, and `var out = views.slice(), entry = {` — the second
  // declarator of a list — is a third. Two rounds of review were spent on matchers that
  // read only the first. The optional group is greedy, so `var X = {` still matches once,
  // at the keyword, rather than twice.
  //
  // A literal is not the only thing that makes an object with a prototype, and this is
  // where the reading stops being a construction and becomes a list. `Object.fromEntries`
  // is the one that matters — this very pull request took it out of `roadmap.mjs`, where
  // `order[a.status]` found the Object constructor and the comparator returned NaN — and
  // `JSON.parse` is next to it because the board parses other people's `board.config.json`.
  // The list is short because these are the platform's, not the repo's, but a list is
  // what it is: nothing here can see through `makeThing()` into a `return { … }`, and the
  // success line says so rather than claiming the file is clean of a thing it cannot see.
  // `Object.create(null)` is deliberately absent — that is the cure, not the hazard.
  const FACTORY = /Object\.fromEntries\(|JSON\.parse\(|new Object\(|Object\.(?:assign|create)\(\s*\{/;
  const bound = new Map();
  const BINDING = /(?:\b(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(table\(|dict\(\)|Object\.fromEntries\(|JSON\.parse\(|new Object\(|Object\.(?:assign|create)\(\s*\{|\{)/g;
  for (const m of [...code.matchAll(BINDING)].filter(inCode)) {
    if (!bound.has(m[1])) bound.set(m[1], []);
    bound.get(m[1]).push({ opens: m[2], at: m.index + m[0].length - m[2].length });
  }
  // A literal is the only opener this can read *into*; a factory call is opaque, and
  // `bodyOf` would happily run past it to the next unrelated `{`.
  const isLiteral = (opens) => opens === "{" || opens === "table(";
  const hasPrototype = (opens) => opens === "{" || FACTORY.test(opens);

  // The balanced inside of the literal an opener starts. For `table(` the literal is its
  // argument, so both openers are "the next `{` that is code".
  const bodyOf = (from) => {
    let open = code.indexOf("{", from);
    while (open !== -1 && mask[open]) open = code.indexOf("{", open + 1);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (mask[i]) continue;
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) return { at: open + 1, text: code.slice(open + 1, i), mask: mask.subarray(open + 1, i) };
    }
    return null;
  };

  // The keys written at the *top* level of a body, and what each one's value opens with.
  // Depth counts brackets and parentheses as well as braces, so a key inside a nested
  // literal, an array of them, or a function body is not mistaken for one of these. A key
  // may be quoted — app.js writes 143 of them — and the quoted spelling is read only when
  // what it quotes could be reached by a property path in the first place.
  const KEY = /([A-Za-z_$][\w$]*)\s*:\s*(table\(|dict\(\)|\{|)/y;
  const QUOTED = /["']([A-Za-z_$][\w$]*)["']\s*:\s*(table\(|dict\(\)|\{|)/y;
  const keysOf = (body) => {
    const keys = new Map();
    let depth = 0;
    for (let i = 0; i < body.text.length; i++) {
      const c = body.text[i];
      const quoted = body.mask[i] === 1;
      if (quoted && !(c === '"' || c === "'")) continue;
      if (!quoted) {
        if (c === "{" || c === "[" || c === "(") { depth++; continue; }
        if (c === "}" || c === "]" || c === ")") { depth--; continue; }
      }
      if (depth !== 0) continue;
      if (!quoted && i > 0 && /[\w$]/.test(body.text[i - 1])) continue;
      const re = quoted ? QUOTED : KEY;
      re.lastIndex = i;
      const m = re.exec(body.text);
      if (!m) continue;
      if (!keys.has(m[1])) keys.set(m[1], { opens: m[2], at: body.at + i + m[0].length - m[2].length });
      i = re.lastIndex - 1;
    }
    return keys;
  };

  // Where `root.a.b` actually lands. Asking about the *root* instead was the fourth and
  // fifth findings, one in each direction: `boardAt.cols[k]` was reported although `cols`
  // is a `dict()`, and `table({ status: { now: "Now" } })` was certified although
  // `.status` is a bare literal — `table()` is shallow, and wrapping the root protected
  // nothing. A root this cannot resolve — a parameter, a function result — yields
  // nothing, which is the boundary: it is the same boundary a name bound to a call has
  // always had, and it is here rather than in a claim.
  const reached = (root, path) => {
    const hits = [];
    for (const b of bound.get(root) || []) {
      let body = isLiteral(b.opens) ? bodyOf(b.at) : null;
      for (let s = 0; body && s < path.length; s++) {
        const k = keysOf(body).get(path[s]);
        if (!k) break;
        if (s === path.length - 1) { hits.push(k); break; }
        body = k.opens === "{" || k.opens === "table(" ? bodyOf(k.at) : null;
      }
    }
    return hits;
  };

  // `name[k]` — the binding itself, read with a key that is not a literal.
  for (const [name, bindings] of bound) {
    if (!bindings.some((b) => hasPrototype(b.opens))) continue;
    if (![...code.matchAll(new RegExp(`\\b${name}\\s*\\[\\s*[^"'\\]]`, "g"))].some(inCode)) continue;
    for (const b of bindings) {
      if (!hasPrototype(b.opens)) continue;
      const built = b.opens === "{" ? "without table()" : `with ${b.opens.replace(/\s+/g, "")}…) and not passed through table()`;
      note("bare-table", b.at, name, `${name} is indexed by a variable somewhere but built ${built}`);
    }
  }
  // `root.a.b[k]` — the value at the end of the path, not the root at the start of it.
  for (const m of [...code.matchAll(/\b([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\[\s*[^"'\]]/g)].filter(inCode)) {
    const path = m[2].split(".").map((piece) => piece.trim()).filter(Boolean);
    const subject = `${m[1]}.${path.join(".")}`;
    for (const k of reached(m[1], path)) {
      if (k.opens === "{") note("bare-table", k.at, subject, `${subject} reaches an object literal built without table()`);
    }
  }
  // And a literal indexed on the spot, `{ a: "all", … }[k]`, which has no name at all.
  for (const m of [...code.matchAll(/\}\s*\[\s*[^"'\]]/g)].filter(inCode)) {
    note("bare-table", m.index, "(anonymous)", "an object literal indexed on the spot, without table()");
  }

  const wrapped = [...bound.values()].flat().filter((b) => b.opens === "table(").length;
  const dicts = [...code.matchAll(/\bdict\(\)/g)].filter(inCode).length;
  return { notes, wrapped, dicts, code };
}

// The matcher against text written for it, before it is turned on the file. Each line is
// a spelling and its answer; the ones that must be reported are named in `REPORTED`, and
// every other line is here because it must *not* be. Seven rounds of review found seven
// shapes this scan could not see, and not one of them was visible from the success line —
// which said "every table is covered" throughout. This is the assertion that was missing.
const FIXTURE = [
  'var A = { a: 1 }; A[k];', //                                          a keyword declaration
  'let bee = { a: 1 }; bee[k];', //                                      any keyword, any case
  'var cee; cee = { a: 1 }; cee[k];', //                                 bound after its declaration
  'var d = 1, e = { a: 1 }; e[k];', //                                   the second declarator of a list
  'var f = table({ g: { a: 1 } }); f.g[k];', //                          a bare table inside a wrapped one
  'var h = { i: { j: { a: 1 } } }; h.i.j[k];', //                        two segments deep
  'var u = table({ url: "https://e.invalid", bad: { a: 1 } }); u.bad[k];', // a URL before the table
  'var v = { "w": { a: 1 } }; v.w[k];', //                               a quoted key
  'var y = { z: { a: 1 } }; y.z[k]; String(x).replace(/"/g, "&q;");', // a regex holding a quote
  'var F1 = Object.fromEntries([["a", 1]]); F1[k];', //                  a factory, not a literal
  'var F2 = JSON.parse("{}"); F2[k];', //                                …and the one the board uses
  'var F3 = Object.assign({ a: 1 }, x); F3[k];', //                      …and one that starts as a literal
  'var F4 = Object.create(null); F4[k];', //                             safe — that is the cure
  'var F5 = table(JSON.parse("{}")); F5[k];', //                         safe — the factory is wrapped
  'var m = table({ n: dict() }); m.n[k];', //                            safe — the value is a dict
  'var o = table({ p: 1 }); o[k];', //                                   safe — the table is wrapped
  'var q = { r: 1 }; q["r"];', //                                        safe — a literal key
  'var s2 = { t: 1 }; s2.t;', //                                         safe — not indexed at all
  'var c2 = { d2: 1 }; // c2[k] here is a comment, not code', //         safe — a comment
  'var e2 = { f2: 1 }; var g2 = "e2[k] here is a string";', //           safe — a string
].join("\n");
const REPORTED = ["A", "bee", "cee", "e", "f.g", "h.i.j", "u.bad", "v.w", "y.z", "F1", "F2", "F3"];
const fixture = survey(FIXTURE);
const got = fixture.notes.filter((n) => n.check === "bare-table").map((n) => n.subject).sort();
if (got.join(" ") !== REPORTED.slice().sort().join(" ")) {
  fail("fixture", `the matcher reports ${got.join(", ") || "nothing"} where it should report ${REPORTED.join(", ")}`);
}
for (const n of fixture.notes.filter((n) => n.check !== "bare-table")) {
  fail("fixture", `the matcher reports ${n.check} on line ${n.line} of a fixture that has none: ${n.what}`);
}

const { notes, wrapped, dicts, code } = survey(src);
for (const n of notes) fail(n.check, `app.js:${n.line} — ${n.what}`);

// The judge on the reading above, and the reason the `/` heuristic is safe rather than
// assumed: removing the comments from a file that parses leaves a file that parses. A
// blank cut through a string leaves it unterminated, and a regex read as a string swallows
// the comment after it — both are syntax errors, and neither is anything this file would
// otherwise notice. It is the same shape as the rest of the repository's checks: the thing
// that decides is a parser, not our own reading of the output.
for (const [what, text] of [["app.js", code], ["the fixture", fixture.code]]) {
  try {
    new vm.Script(text, { filename: "blanked" });
  } catch (e) {
    fail("lex", `${what} no longer parses once its comments are blanked — the scan is reading it wrong: ${e.message}`);
  }
}

// Anti-vacuity, over both halves. If the shapes stopped matching — a reformat, a rename,
// a regex tightened by one character — this section would pass by checking nothing, and
// the half that covers data was written without a floor and was blind three times.
if (wrapped < 15) fail("coverage", `only ${wrapped} tables go through table() — the pattern this checks has moved`);
if (dicts < 40) fail("coverage", `only ${dicts} maps go through dict() — the pattern this checks has moved`);

if (failures.length) {
  console.error(`✗ lookups: ${failures.length} failure(s)\n`);
  for (const [check, detail] of failures) console.error(`  [${check}] ${detail}`);
  process.exit(1);
}
// What the success line may say is the whole subject of this file's review history: six
// of the seven findings were a check claiming more than it held. So it names what was
// read — a literal, and the handful of platform factories above — rather than the file
// being clean of a thing no scan of text can see. A repo-local `makeThing()` with a
// `return { … }` in it is outside this, and saying so is the difference between a boundary
// and a blind spot.
console.log(
  `✓ lookups: the matcher sees all ${REPORTED.length} spellings in its fixture, app.js still parses with its comments ` +
    `blanked, and in it ${wrapped} tables and ${dicts} maps are built with no prototype, no empty object literal is ` +
    `written at all, and no object literal or Object.fromEntries/JSON.parse/new Object/Object.assign({…}) that a ` +
    `variable indexes — through a property path or not — is left with a prototype`
);
