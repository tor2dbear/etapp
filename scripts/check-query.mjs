#!/usr/bin/env node
// Does the query grammar hold the properties the board assumes of it?
//
// `?q=` is the store. The search box, the sidebar places, the filter popover and the
// URL are four faces of one list of predicates — app.js says so at the top of the
// section — and every one of them reaches that list through `parseQuery` and writes
// it back through `serializeTerms`. A chip toggle is a parse and a serialize. So is a
// URL write, a saved view's comparison, and every render. Three properties follow,
// and none of them was checked by anything:
//
//   never throws     `parseQuery` runs per render and at boot. A throw in it is not a
//                    wrong answer, it is a blank board. `target:'\n` was one: `.` does
//                    not match a line terminator, so the operator regex returned null.
//   a fixed point    serialize∘parse must be idempotent, or the round trip rewrites
//                    your query a little at a time. `'` opened a phrase that never
//                    closed, so a quote was eaten per pass — and `don't ship` searched
//                    for a substring no body can contain.
//   nothing vanishes The section promises "a typo narrows the search instead of
//                    silently disappearing". Every token has to become a term.
//
// The grammar is not imported: it is a fenced region of app.js, a classic script the
// browser loads whole. It is lifted between two whole-line markers and evaluated here,
// so what is checked is the bytes the browser runs. A missing marker is a hard failure.
//
// Node builtins only, like the rest of scripts/.
import { lcg } from "./lib/fuzz.mjs";
import { liftRegion } from "./lib/region.mjs";

// The whole app.js source, read once — section 6 below scans it for unguarded URL
// decodes and used to read the 656 KB file a second time to do so.
const { src: APP_SRC, region: GRAMMAR } = liftRegion("app.js", "q");

function loadGrammar() {
  // No prelude. There was one, supplying `TERMINAL` and `isFlagged` by hand because
  // they sat outside the fence — and the hand-written `isFlagged` was `!!i.flagged`,
  // a field app.js never sets, so `is:flagged` was checked against a predicate that
  // could not fire. Both definitions moved inside the fence instead. If the region
  // ever reaches for a name it does not define, this throws rather than being handed
  // a stub that agrees with nothing.
  // eslint-disable-next-line no-new-func
  return new Function(
    `"use strict";${GRAMMAR};` +
      "return { parseQuery, serializeTerms, tokenize, runQuery, FIELDS, IS_STATES, FIELD_ALIAS, IS_ALIAS };"
  )();
}

const G = loadGrammar();
const rt = (s) => G.serializeTerms(G.parseQuery(s));

// One bail-out threshold. It was `> 8` in two places and `> 12` in a third, with
// nothing saying why they differed — a fuzz that breaks tends to break in floods, and
// the first handful name the defect as well as a hundred do.
const BAIL = 8;
const failures = [];
const fail = (check, detail) => failures.push([check, detail]);

// ── the corpus ───────────────────────────────────────────────────────────────
// Every documented form in AGENTS.md, every alias, and the shapes that broke.
const CORPUS = [
  "status:now", "status:now,next", "-status:done", "repo:pia-terminal", "tag:ui",
  "label:ui", "labels:a,b", "tags:x", "agent:backend", "discipline:backend",
  "owner:tor2dbear", "priority:high", "prio:high", "issue:42",
  "target:<=2026-11-30", "updated:>=2026-01-01", "created:>2020-01-01",
  "target:<2026-06-01", "updated:=2026-01-01", "parent:auth", "etapp:auth", "epic:auth",
  '"grep context"', "has:priority", "-has:priority", "-has:agent", "-has:target",
  "is:ready", "is:blocked", "is:flagged", "is:stale", "is:adapted", "is:done",
  "is:blocking", "is:parent", "is:member", "is:standalone", "is:orphan", "is:etapp",
  "is:parent,member", "-is:blocked",
  // the shapes that broke, and their neighbours
  "don't ship", "it's broken", "O'Brien", "rock 'n' roll", "user's guide",
  "target:'\n", "updated:'\r", "created:' ", "target:' ",
  "100% done", "50%", "a%b",
  // malformed input that must narrow rather than vanish or throw
  "a:b", "-a:b", "foo:", ":bar", "-", "--x", "x:", "is:", "has:", "has:nope",
  "is:nope", "tag:", "tag:a,,b", "status:now extra -tag:ui is:blocked",
  'say "hi" now', "a:b:c", "Hello, world", "\t", "  ", "",
];

const ATOMS = [
  "status", "is", "has", "tag", "repo", "parent", "updated", "target", "priority",
  "owner", "agent", "issue", "label", "prio", "epic", "orphan", "ready", "now",
  ":", ",", "-", '"', "'", " ", "\t", "\n", "\r", " ", " ",
  "a", "xy", ">=", "<=", ">", "<", "=", "2026-01-01", "%", "#", "\\", "*", "`",
  "[", "]", "(", ")", "+", "&", "?", "/", "owner/repo#slug",
];
const SEED = 20260919;
function fuzz(n) {
  const rnd = lcg(SEED);
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = 1 + Math.floor(rnd() * 12);
    for (let j = 0; j < len; j++) s += ATOMS[Math.floor(rnd() * ATOMS.length)];
    out.push(s);
  }
  return out;
}

const INPUTS = CORPUS.concat(fuzz(200000));

// ── 1. `parseQuery` never throws, and neither does a round trip ──────────────
let checked = 0;
for (const s of INPUTS) {
  let once, twice;
  try {
    once = rt(s);
  } catch (e) {
    fail("throws", `parseQuery/serializeTerms threw on ${JSON.stringify(s)} — ${e.message}`);
    if (failures.length > BAIL) break;
    continue;
  }
  try {
    twice = rt(once);
  } catch (e) {
    fail("throws", `the second pass threw on ${JSON.stringify(once)} — ${e.message}`);
    if (failures.length > BAIL) break;
    continue;
  }
  checked++;
  // ── 3. Nothing a person typed silently disappears ──────────────────────────
  // "Anything that isn't a known field or `is:` state stays free text, so a typo
  // narrows the search instead of silently disappearing." Held to token count: a
  // tokenized input must produce at least as many terms as it produced tokens. In
  // this loop rather than its own: it needs the same `parseQuery` the round trip
  // already ran, and a second pass over 200k inputs cost 253ms to re-derive it.
  const tokens = G.tokenize(s).length;
  if (tokens) {
    const terms = G.parseQuery(s).length;
    if (terms < tokens) {
      fail("vanishing", `${JSON.stringify(s)} has ${tokens} token(s) but only ${terms} term(s)`);
      if (failures.length > BAIL) break;
    }
  }
  // ── 2. serialize∘parse is a fixed point ────────────────────────────────────
  if (once !== twice) {
    fail(
      "fixed-point",
      `${JSON.stringify(s)} serializes to ${JSON.stringify(once)} and then to ` +
        `${JSON.stringify(twice)} — the round trip rewrites the query`
    );
    if (failures.length > BAIL) break;
  }
}


// ── 4. The documented grammar still means what AGENTS.md says ────────────────
const MEANS = [
  ["status:now,next", [["status", "in", ["now", "next"], false]]],
  ["-status:done", [["status", "in", ["done"], true]]],
  ["label:ui", [["tag", "in", ["ui"], false]]],
  ["prio:high", [["priority", "in", ["high"], false]]],
  ["epic:auth", [["parent", "in", ["auth"], false]]],
  ["target:<=2026-11-30", [["target", "<=", ["2026-11-30"], false]]],
  ["updated:2026-01-01", [["updated", "=", ["2026-01-01"], false]]],
  ["has:priority", [["has", "is", ["priority"], false]]],
  ["-has:agent", [["has", "is", ["agent"], true]]],
  ["is:orphan", [["is", "is", ["standalone"], false]]],
  ["is:etapp", [["is", "is", ["parent"], false]]],
  ["is:parent,member", [["is", "is", ["parent", "member"], false]]],
  ['"grep context"', [["text", "has", ["grep context"], false]]],
  // The apostrophe: two words, both searchable, the quote kept.
  ["don't ship", [["text", "has", ["don't"], false], ["text", "has", ["ship"], false]]],
  // An unknown field is free text, not a dropped term.
  ["nope:x", [["text", "has", ["nope:x"], false]]],
  ["is:nope", [["text", "has", ["is:nope"], false]]],
];
for (const [q, want] of MEANS) {
  const got = G.parseQuery(q).map((t) => [t.field, t.op, t.values, !!t.neg]);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail("grammar", `${JSON.stringify(q)} parses as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}

// ── 5. An apostrophe finds the puck that carries one ─────────────────────────
// The defect this check exists for, stated as the user meets it rather than as a
// property: the search box found nothing for a title it was looking straight at.
const ITEM = {
  id: "x", title: "don't ship on friday", body: "", tags: [], repo: "o/r",
  repoName: "R", status: "now", issue: null, parentRef: null, children: [], blockedBy: [],
  signals: [], native: true, priority: null, agent: null, owner: null,
};
for (const [q, want] of [["don't", true], ["don't ship", true], ["ship", true], ["dont", false]]) {
  const hit = G.runQuery(ITEM, G.parseQuery(q));
  if (hit !== want) fail("search", `${JSON.stringify(q)} ${hit ? "matches" : "does not match"} ${JSON.stringify(ITEM.title)}, expected the opposite`);
}

// ── 5b. Every `is:` state is a real predicate that runs ──────────────────────
// The grammar checks above parse `is:flagged` and serialize it back without ever
// *calling* the predicate — a name in `IS_STATES` could be undefined, or throw, and
// nothing here would notice. That is not hypothetical: the probe used to supply a
// hand-written `isFlagged` reading a field app.js never sets, so the state was
// permanently false and this file was the last place that would have said so.
//
// Anchored by name, so a state deleted from `IS_STATES` fails here rather than
// quietly leaving the grammar. These are the ones AGENTS.md and the sidebar rely on.
const IS_NAMES = [
  "ready", "blocked", "flagged", "stale", "adapted", "done",
  "blocking", "parent", "member", "standalone",
];
const SAMPLES = [
  { id: "bare", status: "now", signals: [], blockedBy: [], blocks: [], children: [], parentRef: null, native: true },
  { id: "rich", status: "done", signals: [{ type: "stale" }], blockedBy: ["x"], blocks: ["y"],
    children: ["c"], parentRef: "o/r#p", native: false },
];
for (const name of IS_NAMES) {
  const pred = G.IS_STATES[name];
  if (typeof pred !== "function") {
    fail("is-states", `IS_STATES has no ${name} — the grammar lost a state the board offers`);
    continue;
  }
  for (const item of SAMPLES) {
    let got;
    try {
      got = pred(item);
    } catch (e) {
      fail("is-states", `is:${name} threw on the ${item.id} sample — ${e.message}`);
      continue;
    }
    if (typeof got !== "boolean") {
      fail("is-states", `is:${name} answered ${String(got)} on the ${item.id} sample, not a boolean`);
    }
  }
}
// And the two that a stub would have got wrong: they have to disagree across the two
// samples, or the predicate is not reading anything.
for (const name of ["flagged", "blocked", "blocking", "parent", "member", "adapted", "done"]) {
  const pred = G.IS_STATES[name];
  if (typeof pred === "function" && pred(SAMPLES[0]) === pred(SAMPLES[1])) {
    fail("is-states", `is:${name} answers the same for an empty puck and a fully-linked one — it is not reading the item`);
  }
}

// ── 6. Nothing decodes the URL bare ──────────────────────────────────────────
// A source check, not a behavioural one, because the behaviour it guards is a thrown
// URIError in a browser and this file runs in Node. `decodeURIComponent` throws on a
// malformed escape, and `?q=50%` is an ordinary hand-written link: unguarded in
// `readUrl`, which runs before the first paint, it left the page with nothing but its
// static shell. The same call on `location.hash` threw after the render, so the board
// looked right while Back/Forward went unwired.
//
// Every other fragile read in app.js is already wrapped. This asserts that the three
// that read the URL stay that way — `safeDecode` exists, and no `location.search` or
// `location.hash` is handed to a bare decode. The demo interceptor's own decodes are
// out of scope on purpose: they read URLs the app itself just encoded.
{
  const src = APP_SRC;
  if (!/function safeDecode\(/.test(src)) {
    fail("url-decode", "app.js no longer defines safeDecode — the URL readers are unguarded again");
  }
  src.split("\n").forEach((line, i) => {
    if (!/decodeURIComponent\s*\(/.test(line)) return;
    if (!/location\.(search|hash)/.test(line)) return;
    fail("url-decode", `app.js:${i + 1} decodes the URL without safeDecode — \`?q=50%\` blanks the board: ${line.trim()}`);
  });
  ["readUrl", "setHash", "itemFromHash"].forEach((fn) => {
    const m = new RegExp(`function ${fn}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\}`).exec(src);
    if (!m) { fail("url-decode", `app.js no longer has a ${fn}() for this check to read`); return; }
    if (/location\.(search|hash)/.test(m[0]) && !/safeDecode\(/.test(m[0])) {
      fail("url-decode", `${fn}() reads the URL but no longer goes through safeDecode`);
    }
  });
}

if (failures.length) {
  console.error(`✗ query grammar: ${failures.length} failure(s)\n`);
  for (const [check, detail] of failures) console.error(`  [${check}] ${detail}`);
  console.error(`\n(fuzz seed ${SEED} — the same inputs every run)`);
  process.exit(1);
}
console.log(
  `✓ query: ${checked} inputs parse without throwing and round-trip to a fixed point, ` +
    `no token vanishes, ${MEANS.length} documented forms parse as AGENTS.md describes, ` +
    `${IS_NAMES.length} \`is:\` states answer as predicates rather than as stubs, ` +
    `an apostrophe finds the puck that carries one, and nothing decodes the URL bare`
);
