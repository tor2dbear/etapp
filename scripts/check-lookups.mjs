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
import fs from "node:fs";
import path from "node:path";
import { liftRegion, ROOT } from "./lib/region.mjs";

const failures = [];
const fail = (check, detail) => failures.push([check, detail]);

// ── 1. the helpers, as the browser gets them ────────────────────────────────────
const { region } = liftRegion("app.js", "dict");
const { table, dict } = new Function(`"use strict";\n${region}\nreturn { table, dict };`)();

// The names that cost this repository a crash, plus the rest of what every object
// inherits. `__proto__` is in the list on purpose: on a normal object it is an accessor
// rather than a value, so it is the one that does not merely answer wrongly but rewrites
// the object it is assigned on.
const INHERITED = [
  "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString", "__proto__", "__defineGetter__",
];

for (const name of INHERITED) {
  if (dict()[name] !== undefined) fail("dict", `a fresh dict() already answers for ${name}`);
  if (table({})[name] !== undefined) fail("table", `a fresh table({}) already answers for ${name}`);
}
// And it still has to be a table: the values put in come back out, including under the
// name that cost the crash, which is the case a `delete Object.prototype` trick would
// break. `__proto__` is not in this round trip and cannot be: in a source literal it
// sets the prototype rather than a key, so the argument never carries it — checked
// below on `dict()`, which is the half that receives data.
const t = table({ now: "Now", constructor: "C", toString: "T" });
for (const [k, v] of [["now", "Now"], ["constructor", "C"], ["toString", "T"]]) {
  if (t[k] !== v) fail("table", `table() lost ${k}: ${String(t[k])} instead of ${v}`);
}
if (Object.keys(t).length !== 3) fail("table", `table() kept ${Object.keys(t).length} of 3 keys`);
// The data half. On a normal object this assignment replaces the prototype and stores
// nothing, so an agent or a tag actually called `__proto__` would vanish from a count
// and take the object's identity with it.
const d = dict();
d["__proto__"] = "P";
d["constructor"] = "C";
if (d["__proto__"] !== "P") fail("dict", "dict() treated __proto__ as the prototype rather than a key");
if (Object.keys(d).length !== 2) fail("dict", `dict() kept ${Object.keys(d).length} of 2 data keys`);

// ── 2. no table left bare ───────────────────────────────────────────────────────
// What makes something a lookup table is not its shape but how it is read: somewhere it
// is indexed with a key that is not a literal, and that key is where an outside string
// gets in. A capitalised `var` holding an object literal that is never indexed that way
// — `NOT_DONE`, a query term written out once — is not one, and naming it as an
// exception would be the hand-maintained list this repository keeps being bitten by.
const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const declared = [...src.matchAll(/^ {2}var ([A-Z][A-Z0-9_]*) = (table\(\{|\{)/gm)]
  .map((m) => ({ name: m[1], wrapped: m[2] !== "{", line: src.slice(0, m.index).split("\n").length }));
const indexedByAVariable = (name) =>
  new RegExp(`\\b${name}\\s*\\[\\s*[^"'\\]]`).test(src);
for (const { name, wrapped, line } of declared) {
  if (!wrapped && indexedByAVariable(name)) {
    fail("bare-table", `app.js:${line} — ${name} is indexed by a variable somewhere but built without table()`);
  }
}
// Anti-vacuity: if the shape stopped matching anything, this section would pass by
// checking nothing. The tables are real and there are a couple of dozen of them.
const wrapped = declared.filter((d) => d.wrapped).length;
if (wrapped < 15) {
  fail("coverage", `only ${wrapped} tables go through table() — the pattern this checks for has moved`);
}

// ── 3. and no map built from data left bare either ──────────────────────────────
// The same question asked of the other half. Three maps were missed when this was
// written — `renderList`'s buckets, the hidden tray's two sets, the Labels facet's
// counts — and they were missed because nothing asked; the list of places to convert
// was in my head, which is the hand-maintained list this repository keeps paying for.
//
// A local `{}` is a map when something indexes it with a key that is not a literal, and
// the search is scoped to the block the declaration lives in, so two functions may both
// have a `seen` without one answering for the other.
const lines = src.split("\n");
const blockOf = (start) => {
  // From the declaration to the end of its enclosing block, by brace depth.
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth < 0) return lines.slice(start, i + 1).join("\n");
  }
  return lines.slice(start).join("\n");
};
for (let i = 0; i < lines.length; i++) {
  // `var x = {}` / `var a = {}, b = {}`, excluding the capitalised tables above, which
  // section 2 owns, and excluding a literal used as a value rather than a map.
  const names = [...lines[i].matchAll(/\b([a-z][A-Za-z0-9_]*) = \{\}[,;]/g)].map((m) => m[1]);
  if (!names.length) continue;
  const block = blockOf(i);
  for (const name of names) {
    if (new RegExp(`\\b${name}\\s*\\[\\s*[^"'\\]]`).test(block)) {
      fail("bare-map", `app.js:${i + 1} — ${name} is indexed by a variable in its own block but is not dict()`);
    }
  }
}

if (failures.length) {
  console.error(`✗ lookups: ${failures.length} failure(s)\n`);
  for (const [check, detail] of failures) console.error(`  [${check}] ${detail}`);
  process.exit(1);
}
console.log(
  `✓ lookups: ${wrapped} tables and every map indexed by a variable start with no ` +
    `prototype, so ${INHERITED.length} inherited names answer for no key that was not put there`
);
