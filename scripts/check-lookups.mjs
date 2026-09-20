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
// Comments are blanked rather than skipped, so the offsets — and the line numbers
// reported from them — still point at the real file. This file's own prose says `{}` a
// dozen times, and the first version of this section flagged two of its own sentences.
const CODE = lines
  .map((line) => {
    const at = line.indexOf("//");
    return at === -1 ? line : line.slice(0, at) + " ".repeat(line.length - at);
  })
  .join("\n");
const lineAt = (index) => CODE.slice(0, index).split("\n").length;

// Whitespace included, and over the whole source rather than line by line: `{ }` and a
// literal broken across two lines are the same empty object, and both sailed past a
// `/\{\}/` that matched only the bare token — measured, with the gate still reporting
// that the file writes none. Three spellings are not a map and are left alone: an empty
// catch, an empty function body, and the two-character string.
const EXEMPT = [/catch\s*\([^)]*\)\s*$/, /function[^)]*\)\s*$/, /=>\s*$/];
for (const m of CODE.matchAll(/\{\s*\}/g)) {
  const before = CODE.slice(0, m.index).trimEnd();
  if (CODE[m.index - 1] === '"' || CODE[m.index + m[0].length] === '"') continue;
  if (EXEMPT.some((re) => re.test(before))) continue;
  fail("bare", `app.js:${lineAt(m.index)} — an empty object literal: ${m[0].replace(/\s+/g, " ")}`);
}

// A *non-empty* literal is a record until something indexes it with a key that is not a
// literal, and then it is a lookup table and needs `table()`. Two shapes, because there
// are two ways to write one:
//
//   a declaration, of any case and any keyword — the first version of this read only
//   `var ALL_CAPS`, so a lowercase or `const` table was invisible while the success line
//   claimed every table was covered;
//
//   and a literal indexed on the spot, `{ a: "all", … }[k]`, which has no name at all.
//   app.js has one, in the keyboard handler.
const declared = [...CODE.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(table\(\{|\{)/g)]
  .map((m) => ({ name: m[1], wrapped: m[2] !== "{", at: m.index }));
// Through a property path too, not just `name[k]`: a table can be held in one —
// `var t = { status: { now: "Now" } }` read as `t.status[k]` — and looking only for
// `t[` meant the declaration was recorded and then never tested. No instance of that
// shape is in app.js today (the empty-literal rule above already covers the property
// maps that are, `cols:` and `keys:`), so this closes the claim rather than a hole:
// the sentence this section prints has to be true of the next table as well.
const indexedByAVariable = (name) =>
  new RegExp(`\\b${name}\\s*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\[\\s*[^"'\\]]`).test(CODE);
for (const { name, wrapped, at } of declared) {
  if (!wrapped && indexedByAVariable(name)) {
    fail("bare-table", `app.js:${lineAt(at)} — ${name} is indexed by a variable somewhere but built without table()`);
  }
}
for (const m of CODE.matchAll(/\}\s*\[\s*[^"'\]]/g)) {
  fail("bare-table", `app.js:${lineAt(m.index)} — an object literal indexed on the spot, without table()`);
}

// Anti-vacuity, over both halves. If the shapes stopped matching — a reformat, a rename,
// a regex tightened by one character — this section would pass by checking nothing, and
// the half that covers data was written without a floor and was blind three times.
const wrapped = declared.filter((d) => d.wrapped).length;
const dicts = (CODE.match(/\bdict\(\)/g) || []).length;
if (wrapped < 15) fail("coverage", `only ${wrapped} tables go through table() — the pattern this checks has moved`);
if (dicts < 40) fail("coverage", `only ${dicts} maps go through dict() — the pattern this checks has moved`);

if (failures.length) {
  console.error(`✗ lookups: ${failures.length} failure(s)\n`);
  for (const [check, detail] of failures) console.error(`  [${check}] ${detail}`);
  process.exit(1);
}
console.log(
  `✓ lookups: ${wrapped} tables and ${dicts} maps are built with no prototype, and app.js ` +
    `writes no empty object literal at all — so no key that was not put there has an answer`
);
