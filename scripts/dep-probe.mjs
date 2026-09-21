#!/usr/bin/env node
// What `depends:` derives, taken from both implementations of it.
//
// One authored field, two derived ones. A puck declares `depends:`; `blockedBy` (what
// still holds me up) and `blocks` (what I hold up) are computed — by the harvester for
// the payload, and again by the board after an optimistic edit, because a board that
// waited for the next harvest would show the two directions disagreeing between
// renders. Two implementations of one rule is this repo's recurring defect, so the
// rule is not asserted here: both are lifted out of the files that ship and run
// side by side on the same graphs.
//
// This prints JSON. `scripts/check-dependencies.py` is the judge, and it derives the
// answer a third time, in Python, from the convention's own wording — so "they agree"
// cannot mean "they are the same mistake".
//
// Node builtins only, like the rest of scripts/.
// For the side effect: `format.js` assigns `globalThis.__PUCK_FORMAT__`, which is what
// both lifted regions reach for. Supplying the real one is not a stub — it is the same
// object the browser gets from the same file.
import "../format.js";
import { lcg } from "./lib/fuzz.mjs";
import { liftRegion } from "./lib/region.mjs";

// The board's half: the reference forms, the derivation, and the settled statuses the
// derivation reads. Three fences rather than one file, because `TERMINAL` belongs to
// the query grammar that also reads it — lifting it rather than restating it here is
// the difference between checking the board and checking a copy of the board. A probe
// that defines what it is testing has already been written in this repo once, and it
// certified a predicate that could not fire.
function board() {
  // `dict` too: the board's `TERMINAL` is a lookup table now, and `table()` lives in its
  // own fence. Lifted, not restated.
  const parts = ["dict", "term", "ref", "dep"].map((n) => liftRegion("app.js", n).region).join("\n");
  // `"use strict"` because app.js declares it on its first line. Without it the lifted
  // bytes run in sloppy mode here and strict mode there, so an undeclared assignment or
  // a duplicate parameter would pass this gate and throw in the browser — the gate would
  // be judging the right bytes under the wrong rules.
  const make = new Function(
    "DATA",
    "fmt",
    `"use strict";\n${parts}\nreturn { recomputeDeps, dependRefs, withoutDepend, resolveRef, refFor };`
  );
  return (items) => {
    const api = make({ items }, () => globalThis.__PUCK_FORMAT__);
    api.recomputeDeps();
    return { items, api };
  };
}

// The harvester's half, the same way.
// The harvester's half, the same way. It is an ES module, so its bytes are strict too,
// and the reference rule it now imports is handed in from the same `format.js`.
function harvester() {
  const parts = ["term", "dep"].map((n) => liftRegion("scripts/harvest.mjs", n).region).join("\n");
  const make = new Function(
    "refKey",
    "itemKey",
    `"use strict";\n${parts}\nreturn { resolveBlockedBy };`
  );
  const fmt = globalThis.__PUCK_FORMAT__;
  const api = make(fmt.refKey, fmt.itemKey);
  return (items) => {
    const cycles = api.resolveBlockedBy(items);
    return { items, cycles: items.filter((it) => cycles.has(it)).map((it) => it.id) };
  };
}

const runBoard = board();
const runHarvest = harvester();

// A case is the authored graph alone: repo, slug, status and the `depends:` list as
// written. Everything else is what the two implementations are asked to derive.
// `id` as the harvester spells it: the repo's last segment and the slug, which is not
// the reference form and is what every consumer of the payload sees.
const mk = (repo, slug, status, depends) =>
  ({ repo, slug, id: `${repo.split("/").pop()}/${slug}`, status, depends });
const clone = (items) => items.map((it) => ({ ...it, depends: it.depends.slice() }));

const A = "me/board", B = "them/other";
const CASES = [
  ["a bare slug names a puck in the same repo",
    [mk(A, "x", "now", ["y"]), mk(A, "y", "now", [])]],
  ["owner/repo#slug names one anywhere",
    [mk(A, "x", "now", [`${B}#y`]), mk(B, "y", "now", [])]],
  ["the two spellings of one reference are one edge",
    [mk(A, "x", "now", ["y", `${A}#y`]), mk(A, "y", "now", [])]],
  ["a reference that names nothing survives as written",
    [mk(A, "x", "now", ["ghost"])]],
  ["the same unknown reference twice is one blocker",
    [mk(A, "x", "now", ["ghost", `${A}#ghost`])]],
  ["a settled blocker stops blocking",
    [mk(A, "x", "now", ["y"]), mk(A, "y", "done", [])]],
  ["a settled puck waits for nothing",
    [mk(A, "x", "done", ["y"]), mk(A, "y", "now", [])]],
  ["a cancelled puck is settled too",
    [mk(A, "x", "cancelled", ["y"]), mk(A, "y", "now", [])]],
  ["a puck that depends on itself blocks itself",
    [mk(A, "x", "now", ["x"])]],
  ["two pucks waiting for each other",
    [mk(A, "x", "now", ["y"]), mk(A, "y", "now", ["x"])]],
  ["a three-puck loop",
    [mk(A, "x", "now", ["y"]), mk(A, "y", "now", ["z"]), mk(A, "z", "now", ["x"])]],
  ["a loop across repos",
    [mk(A, "x", "now", [`${B}#y`]), mk(B, "y", "now", [`${A}#x`])]],
  ["a puck pointing into a loop is not in it",
    [mk(A, "w", "now", ["x"]), mk(A, "x", "now", ["y"]), mk(A, "y", "now", ["x"])]],
  ["a settled puck in a loop is still in the loop",
    [mk(A, "x", "done", ["y"]), mk(A, "y", "now", ["x"])]],
  ["a diamond is not a loop",
    [mk(A, "top", "now", ["l", "r"]), mk(A, "l", "now", ["b"]), mk(A, "r", "now", ["b"]), mk(A, "b", "now", [])]],
  ["same slug in two repos is two pucks",
    [mk(A, "x", "now", ["dup"]), mk(A, "dup", "now", []), mk(B, "dup", "now", [])]],
  ["a blank reference",
    [mk(A, "x", "now", [""])]],
  ["whitespace around a reference is not a different reference",
    [mk(A, "x", "now", [" y ", "y"]), mk(A, "y", "now", [])]],
];

// Seeded, so a failure is reproducible and CI cannot be lucky. Small graphs on
// purpose: the interesting shapes — a loop, a settled node inside one, a reference
// with two spellings — are all reachable in six pucks, and a thousand of those cover
// more of them than a few large ones would.
const next = lcg(20260919);
const rnd = (n) => Math.floor(next() * n);
const STATUS = ["now", "next", "later", "inbox", "done", "cancelled"];
// Every reference form, including the ones a human writes only by mistake. Written as a
// list because the ladder this replaced had two arms spelling the same thing, which
// weighted the qualified form twice without saying so.
const asWritten = (t, it) => (t.repo === it.repo ? t.slug : `${t.repo}#${t.slug}`);
const FORMS = [
  (t) => `${t.repo}#${t.slug}`,            // qualified, even at home
  asWritten,                                // what a person would write
  (t, it) => `  ${asWritten(t, it)}  `,     // padded
  () => `missing-${rnd(3)}`,                // names nothing
  () => "",                                 // a blank entry
];
function randomGraph(i) {
  const n = 2 + rnd(5);
  const items = [];
  for (let k = 0; k < n; k++) items.push(mk(rnd(4) ? A : B, `p${k}`, STATUS[rnd(STATUS.length)], []));
  for (const it of items) {
    const edges = rnd(4);
    for (let e = 0; e < edges; e++) {
      const t = items[rnd(items.length)];
      it.depends.push(FORMS[rnd(FORMS.length)](t, it));
    }
  }
  return [`random graph ${i}`, items];
}
for (let i = 0; i < 1000; i++) CASES.push(randomGraph(i));

const derived = (it) => ({
  id: it.id,
  blockedBy: it.blockedBy || [],
  blocks: it.blocks || [],
  missingDepends: it.missingDepends || [],
});

// The board carries one signal of its own — `depends-missing` — because an optimistic
// edit must not leave the note and the list it is built from out of step. The
// harvester decides every signal elsewhere, in `computeSignals`, so the two are not
// compared on it: the judge holds the board to its own list instead. Pucks arrive
// carrying signals, so the corpus hands it some to keep and one stale note to drop.
const seeded = (items, i) =>
  clone(items).map((it, k) => {
    if (k % 3 === 0) it.signals = [{ type: "stale" }];            // one to keep
    else if (k % 3 === 1 && i % 2 === 0) it.signals = [{ type: "depends-missing" }]; // one to drop
    else it.signals = [];
    return it;
  });

const out = [];
CASES.forEach(([name, items], i) => {
  const b = seeded(items, i);
  const { api } = runBoard(b);
  const h = runHarvest(clone(items));
  out.push({
    name,
    items: items.map((it) => ({ repo: it.repo, slug: it.slug, id: it.id, status: it.status, depends: it.depends })),
    board: b.map(derived),
    boardSignals: b.map((it) => (it.signals || []).map((g) => g.type).sort()),
    // The two render-path answers, taken from the same lifted bytes. Without them the
    // gate checked the derivation and nothing else, so the chips could go back to one
    // per line of `depends:` and the ✕ back to removing a single spelling with every
    // gate still green — measured, by reverting both.
    dependRefs: b.map((it) => api.dependRefs(it)),
    afterRemovingFirst: b.map((it) => (it.depends.length ? api.withoutDepend(it, it.depends[0]) : [])),
    harvest: h.items.map(derived),
    cycles: h.cycles.sort(),
  });
});
process.stdout.write(JSON.stringify({ cases: out }) + "\n");
