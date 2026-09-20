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
// answered "is this a lookup table?" by guessing, and both were blind — a map declared
// as `cols: {}` inside a larger literal was neither, and it was live: `data-col` is a
// group key, so with a puck whose agent is named `constructor` the board read the Object
// constructor back out and assigned a function to `scrollTop`.
//
// So the rule is a construction instead of a guess: **an empty object literal in value
// position is not written in this file**. `dict()` is how a map is made and `table()` is
// how a lookup is made, and a non-empty literal is a record — it has its keys written
// out, which is what makes it not the shape that means "something will fill this".
// Nothing needs to decide whether a given map is "indexed by data", which is the
// judgement that kept being wrong.
//
// Three spellings of `{}` are not value position and are left alone: an empty catch, an
// empty function body, and the two-character string.
const EXEMPT = [/catch\s*\([^)]*\)\s*$/, /function[^)]*\)\s*$/, /=>\s*$/];
let empties = 0;
lines.forEach((line, i) => {
  // Prose about the rule is not the rule: this file's own comments say `{}` a dozen
  // times, and the first run of this section flagged two of them.
  const comment = line.indexOf("//");
  for (const m of line.matchAll(/\{\}/g)) {
    if (comment !== -1 && m.index > comment) continue;
    const before = line.slice(0, m.index).trimEnd();
    if (line[m.index - 1] === '"' || line[m.index + 2] === '"') continue;
    if (EXEMPT.some((re) => re.test(before))) continue;
    empties++;
    fail("bare", `app.js:${i + 1} — an empty object literal: ${line.trim().slice(0, 70)}`);
  }
});

// A capitalised name holding a *non-empty* literal is a lookup table, and those are
// still a judgement call — so the narrower question stays for them: is it indexed
// anywhere by a key that is not a literal?
const declared = [...src.matchAll(/^ {2}var ([A-Z][A-Z0-9_]*) = (table\(\{|\{)/gm)]
  .map((m) => ({ name: m[1], wrapped: m[2] !== "{", at: m.index }));
const indexedByAVariable = (name) => new RegExp(`\\b${name}\\s*\\[\\s*[^"'\\]]`).test(src);
for (const { name, wrapped, at } of declared) {
  if (!wrapped && indexedByAVariable(name)) {
    const line = src.slice(0, at).split("\n").length;
    fail("bare-table", `app.js:${line} — ${name} is indexed by a variable somewhere but built without table()`);
  }
}

// Anti-vacuity, over both halves. If the shapes stopped matching — a reformat, a rename,
// a regex tightened by one character — this section would pass by checking nothing, and
// the half that covers data was written without a floor and was blind three times.
const wrapped = declared.filter((d) => d.wrapped).length;
const dicts = (src.match(/\bdict\(\)/g) || []).length;
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
