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
import { liftRegion } from "./lib/region.mjs";

const failures = [];
const fail = (check, detail) => failures.push([check, detail]);

// ── 1. the helpers, as the browser gets them ────────────────────────────────────
const { src, lines, region } = liftRegion("app.js", "dict");
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
// The rest of this section is the *other* half of the rule — a non-empty literal that
// something does index with a key that is not a literal — and it has now been wrong in
// five different ways, once per round of review. Every one of them was the same defect:
// the scan could not see a shape, and nothing here said which shapes it could see. So
// the scan is a function of text, and the fixture below is the list, with the answer
// written next to each line. A shape the matcher stops seeing is a failing gate now,
// not a success line that has quietly stopped meaning anything.
//
// Comments are blanked rather than skipped, so the offsets — and the line numbers
// reported from them — still point at the real file. This file's own prose says `{}` a
// dozen times, and the first version of this section flagged two of its own sentences.
const blanked = (text) =>
  text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at) + " ".repeat(line.length - at);
    })
    .join("\n");

function survey(code) {
  const notes = [];
  const lineOf = (index) => code.slice(0, index).split("\n").length;
  const seen = new Set();
  const note = (check, at, subject, what) => {
    if (seen.has(check + at)) return;
    seen.add(check + at);
    notes.push({ check, line: lineOf(at), subject, what });
  };

  // Whitespace included, and over the whole source rather than line by line: `{ }` and a
  // literal broken across two lines are the same empty object, and both sailed past a
  // `/\{\}/` that matched only the bare token — measured, with the gate still reporting
  // that the file writes none. Three spellings are not a map and are left alone: an empty
  // catch, an empty function body, and the two-character string.
  const EXEMPT = [/catch\s*\([^)]*\)\s*$/, /function[^)]*\)\s*$/, /=>\s*$/];
  for (const m of code.matchAll(/\{\s*\}/g)) {
    if (code[m.index - 1] === '"' || code[m.index + m[0].length] === '"') continue;
    if (EXEMPT.some((re) => re.test(code.slice(0, m.index).trimEnd()))) continue;
    note("bare", m.index, null, `an empty object literal: ${m[0].replace(/\s+/g, " ")}`);
  }

  // Every name bound to an object, however the binding is spelled. The keyword is
  // optional, and that is the whole point: `var X = {` is one way, `x = {` after the
  // declaration is another, and `var out = views.slice(), entry = {` — the second
  // declarator of a list — is a third. Two rounds of review were spent on matchers that
  // read only the first. The optional group is greedy, so `var X = {` still matches once,
  // at the keyword, rather than twice.
  const bound = new Map();
  for (const m of code.matchAll(/(?:\b(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(table\(|dict\(\)|\{)/g)) {
    if (!bound.has(m[1])) bound.set(m[1], []);
    bound.get(m[1]).push({ opens: m[2], at: m.index + m[0].length - m[2].length });
  }

  // The balanced inside of the literal an opener starts, with quoted text skipped. For
  // `table(` the literal is its argument, so both openers are "the next `{`".
  const bodyOf = (from) => {
    const open = code.indexOf("{", from);
    if (open === -1) return null;
    let depth = 0;
    let quote = null;
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return { at: open + 1, text: code.slice(open + 1, i) };
    }
    return null;
  };

  // The keys written at the *top* level of a body, and what each one's value opens with.
  // Depth counts brackets and parentheses as well as braces, so a key inside a nested
  // literal, an array of them, or a function body is not mistaken for one of these.
  const KEY = /([A-Za-z_$][\w$]*)\s*:\s*(table\(|dict\(\)|\{|)/y;
  const keysOf = (body) => {
    const keys = new Map();
    let depth = 0;
    let quote = null;
    for (let i = 0; i < body.text.length; i++) {
      const c = body.text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{" || c === "[" || c === "(") { depth++; continue; }
      if (c === "}" || c === "]" || c === ")") { depth--; continue; }
      if (depth !== 0 || (i > 0 && /[\w$]/.test(body.text[i - 1]))) continue;
      KEY.lastIndex = i;
      const m = KEY.exec(body.text);
      if (!m) continue;
      if (!keys.has(m[1])) keys.set(m[1], { opens: m[2], at: body.at + i + m[0].length - m[2].length });
      i = KEY.lastIndex - 1;
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
      let body = b.opens === "dict()" ? null : bodyOf(b.at);
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
    if (!bindings.some((b) => b.opens === "{")) continue;
    if (!new RegExp(`\\b${name}\\s*\\[\\s*[^"'\\]]`).test(code)) continue;
    for (const b of bindings) {
      if (b.opens === "{") note("bare-table", b.at, name, `${name} is indexed by a variable somewhere but built without table()`);
    }
  }
  // `root.a.b[k]` — the value at the end of the path, not the root at the start of it.
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\[\s*[^"'\]]/g)) {
    const path = m[2].split(".").map((s) => s.trim()).filter(Boolean);
    const subject = `${m[1]}.${path.join(".")}`;
    for (const k of reached(m[1], path)) {
      if (k.opens === "{") note("bare-table", k.at, subject, `${subject} reaches an object literal built without table()`);
    }
  }
  // And a literal indexed on the spot, `{ a: "all", … }[k]`, which has no name at all.
  for (const m of code.matchAll(/\}\s*\[\s*[^"'\]]/g)) {
    note("bare-table", m.index, "(anonymous)", "an object literal indexed on the spot, without table()");
  }

  const wrapped = [...bound.values()].flat().filter((b) => b.opens === "table(").length;
  return { notes, wrapped };
}

// The matcher against text written for it, before it is turned on the file. Each line is
// a spelling and its answer; the ones that must be reported are named in `REPORTED`, and
// every other line is here because it must *not* be. Five rounds of review found five
// shapes this scan could not see, and not one of them was visible from the success line —
// which said "every table is covered" throughout. This is the assertion that was missing.
const FIXTURE = [
  'var A = { a: 1 }; A[k];', //                     a keyword declaration
  'let bee = { a: 1 }; bee[k];', //                 any keyword, any case
  'var cee; cee = { a: 1 }; cee[k];', //            bound after its declaration
  'var d = 1, e = { a: 1 }; e[k];', //              the second declarator of a list
  'var f = table({ g: { a: 1 } }); f.g[k];', //     a bare table inside a wrapped one
  'var h = { i: { j: { a: 1 } } }; h.i.j[k];', //   two segments deep
  'var m = table({ n: dict() }); m.n[k];', //       safe — the value is a dict
  'var o = table({ p: 1 }); o[k];', //              safe — the table is wrapped
  'var q = { r: 1 }; q["r"];', //                   safe — a literal key
  'var s = { t: 1 }; s.t;', //                      safe — not indexed at all
].join("\n");
const REPORTED = ["A", "bee", "cee", "e", "f.g", "h.i.j"];
const fixture = survey(blanked(FIXTURE));
const got = fixture.notes.filter((n) => n.check === "bare-table").map((n) => n.subject).sort();
if (got.join(" ") !== REPORTED.slice().sort().join(" ")) {
  fail("fixture", `the matcher reports ${got.join(", ") || "nothing"} where it should report ${REPORTED.join(", ")}`);
}
for (const n of fixture.notes.filter((n) => n.check !== "bare-table")) {
  fail("fixture", `the matcher reports ${n.check} on line ${n.line} of a fixture that has none: ${n.what}`);
}

const CODE = blanked(src);
const { notes, wrapped } = survey(CODE);
for (const n of notes) fail(n.check, `app.js:${n.line} — ${n.what}`);

// Anti-vacuity, over both halves. If the shapes stopped matching — a reformat, a rename,
// a regex tightened by one character — this section would pass by checking nothing, and
// the half that covers data was written without a floor and was blind three times.
const dicts = (CODE.match(/\bdict\(\)/g) || []).length;
if (wrapped < 15) fail("coverage", `only ${wrapped} tables go through table() — the pattern this checks has moved`);
if (dicts < 40) fail("coverage", `only ${dicts} maps go through dict() — the pattern this checks has moved`);

if (failures.length) {
  console.error(`✗ lookups: ${failures.length} failure(s)\n`);
  for (const [check, detail] of failures) console.error(`  [${check}] ${detail}`);
  process.exit(1);
}
console.log(
  `✓ lookups: the matcher sees all ${REPORTED.length} spellings of a bare table in its fixture, and in app.js ` +
    `${wrapped} tables and ${dicts} maps are built with no prototype, no empty object literal is written at all, ` +
    `and nothing a variable indexes — through a property path or not — reaches one that has a prototype`
);
