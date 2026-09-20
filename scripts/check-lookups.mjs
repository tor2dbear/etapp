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
import { reporter } from "./lib/report.mjs";

const { fail, report } = reporter("lookups");

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
// that is not a literal — and it has now been wrong in twenty-eight different ways over
// twenty rounds of review. Twenty were the same defect: the scan could not see a
// shape, and nothing
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
// `/` is the ambiguous one — regex or division — and it is read from what precedes it.
// `(a + b) / 2` and `if (x) /re/.test(y)` are the same character after the same bracket,
// so a `)` is not one token: it is remembered by which `(` it closes, and only the four
// heads whose `)` is followed by a statement open a regex. Reading it as division whatever
// preceded it made `if (true) /{}/.test("")` — a valid line — report an empty object
// literal, which is a *red gate on good code*: Codex found it (#9, round 9).
//
// The direction the error runs in is the thing to be exact about, and getting that wrong
// is the most recent entry in this section's review history. A regex read as division
// leaves the text alone and scans its body as code: it can only add a finding, never hide
// one — noise, which is what the `if (true) /{}/` line above was. Division read as a regex
// masks real code, and *that* one is dangerous.
//
// This comment used to say that direction "needs a `/` after an operator, a keyword or a
// control-flow `)`, which is where a `/` is a regex in JavaScript anyway". That was wrong,
// and wrong in the way this whole file keeps being wrong: `}` was in the set too, so
// `{ … } / x` — division after a value — masked everything to the next slash, and Codex
// built a line where the masked span held a live lookup. Both brackets are classified by
// what they close now. What is deliberately *not* claimed is that no third shape exists.
// The fixture is where the next one gets written down.
// JavaScript's identifier alphabet is not ASCII: `var café = { … }; café[k]` bound nothing
// at all. Codex found it (#9, round 33). One fragment and two tests, used by every pattern
// and every character check that reads a name, so the alphabet cannot be right in one place
// and wrong in another — which is the failure rounds 26 to 31 kept being, in a different
// part of the same file. The regexes that use it carry the `u` flag, which is what makes
// `\p{…}` mean anything.
const ID = "[\\p{ID_Start}$_][\\p{ID_Continue}$\\u200C\\u200D]*";
// The lexer reads a whole name with the same fragment the patterns use, rather than a start
// test and an end test that could drift apart — and a sticky match always moves, where two
// tests that disagreed left the scan standing still and the gate never finished.
const IDENT = new RegExp(ID, "yu");
const IDENT_PART = /[\p{ID_Continue}$\u200C\u200D]/u;

// The calls that hand back the very object they were given — what each one answers is its
// *first argument*. `Object.freeze({ … })` is that literal, prototype and all, so the
// reading looks *through* them rather than treating them as factories: a factory entry
// would have called `Object.freeze(dict())` a hazard, which it is not.
//
// Codex found `freeze` (#9, round 36) and then, on the evidence of that fix,
// `defineProperty` (#9, round 37). The list is the family rather than the calls it named,
// because what makes one transparent is a fact about what it returns, not about how it is
// spelled — and the round-36 list was the three whose argument is also their *only*
// argument, which is how the first-argument half of the rule went missing.
//
// `Object.assign` moves here out of the factory list, where it had been the one entry that
// was not a factory. `Object.assign({ … }, src)` is its first argument, and calling it "a
// call that makes an object" was right about that spelling alone: `Object.assign(dict(),
// src)` was invisible and `Object.assign(source, src)` was not an alias of `source`.
//
// `Object.setPrototypeOf` is the one identity-returning call deliberately left out, and it
// is left out because transparency would be wrong in *both* directions: it hands back its
// argument with a different prototype, so `Object.setPrototypeOf(dict(), Object.prototype)`
// is a hazard with the cure taken off it and `Object.setPrototypeOf({ … }, null)` is a cure.
// Neither is something this file can see; app.js writes none of the seven, so all of this is
// reach for the immutable-table refactor that would bring them.
//
// One list, because the success line has to name these too, and a second hand-spelling of
// them is a line of prose that drifts from the code under it — which this file has paid for
// once already, in round 30.
const THROUGH_CALLS = ["freeze", "seal", "preventExtensions", "defineProperty", "defineProperties", "assign"];
// The lookbehind is the one `GROUPED` carries, for the same reason: without it a match
// starts in the middle of a name, so `myObject.freeze({ … })[k]` was read as the platform's
// call and its argument reported — the sixteenth red gate on valid code, since a method
// called `freeze` on somebody else's object answers whatever it likes. `a.Object.freeze(`
// is out with it. Found looking for the rest of round 37's family, not named by it.
const THROUGH = `(?<![\\p{ID_Continue}$.])Object\\s*\\.\\s*(?:${THROUGH_CALLS.join("|")})\\s*\\(`;
// `u`, or the alphabet in the lookbehind is six literal characters and the test is silently
// something else — the same flag the patterns that embed this one already carry.
const THROUGH_END = new RegExp(`${THROUGH}$`, "u");

const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%~^<>".split("").concat(["=>"]));
// The keyword side of the same question, and it is written as an inversion because the
// list I had was a guess: "the keywords a regex may follow" was missing `await`, which made
// `await /{}/.test("")` — valid async code — report an empty object literal. Codex found it
// (#9, round 18), the fourth red gate this file has produced on code that is fine.
//
// A `/` is division after a *value* and a regex after everything else, so what has to be
// listed is what a name can be: the reserved words are a closed set the language defines,
// five of them stand for values, and an identifier that is not reserved is a value by
// definition. That cannot be short by one the way the other list was.
// Only the words a script may *never* use as a name. `get`, `set`, `of`, `as`, `from`, `let`
// and `static` are contextual — they are ordinary identifiers almost everywhere, and app.js
// uses three of them — so calling them keywords made `get / x` a regex and masked whatever
// followed. Codex found it (#9, round 19), and it was mine: the inversion one round earlier
// took "reserved" to mean "in some list of reserved-ish words" rather than "cannot be a
// name". Erring this way is also the safe way round: a keyword read as a value scans a
// regex body as code, which is noise, while a name read as a keyword hides code.
const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with",
  // …and the two that are keywords exactly where a `/` after them is a regex — inside an
  // async function or a generator — but are legal names in a sloppy script like this one.
  // The assertion below is what pays for that: app.js binds neither, and says so out loud
  // rather than leaving the reading to rest on a fact nothing checks.
  "await", "yield",
]);
const CONTEXTUAL = ["await", "yield"];
const VALUE_WORDS = new Set(["this", "super", "true", "false", "null"]);
// …and the keywords whose `{` opens a statement rather than a value. Everything else that
// can stand in front of a `{` at all — `return`, `case`, `typeof`, `throw`, `await` — takes
// an expression, so the brace is a literal.
// `catch` came back red the moment the inversion landed — it had been on the safe side of
// the old list by accident, not by decision, which is the whole reason the fixture runs
// first. `static` is here for a class's static block; `if`, `while`, `for`, `with` and
// `switch` never reach this, since their `(…)` puts a `)` in front of the brace.
// `var` and `const` are here because the brace after a declaration keyword opens a binding
// *pattern* — `var { a } = obj` — and a pattern is not a value. (`let` is contextual and
// already arrives as a plain name, which reaches the same answer.)
const BLOCK_WORDS = new Set(["else", "do", "try", "finally", "catch", "var", "const"]);
// The four heads whose closing `)` is followed by a statement rather than by more of an
// expression — so the `/` after it opens a regex. Everything else that ends in `)` is a
// value, and the `/` after *that* is division.
const CONTROL = new Set(["if", "while", "for", "with"]);
// …and the heads whose `(…)` is never a parameter list, which is those four and one more.
// `switch` is not a `CONTROL` head — the `/` after its `)` is not a regex, because a switch
// body is a `{` and nothing else — but that body is exactly what the parameter-list rule
// reads as the mark of one, so `switch ({})` had its literal reclassified as a pattern and
// went unreported. A miss rather than a red gate, and the same misreading as `for await`:
// the answer was right for four heads and the question was about five.
const NOT_PARAMS = new Set([...CONTROL, "switch"]);
// And `}` is three, for the same reason. A `{` in expression position opens an object
// literal, which is a *value*, so the `/` after its `}` is division — `{ … } / x`. A `{`
// anywhere else opens a block, and a statement follows its `}`, so a `/` there opens a
// regex. Treating every `}` as a block made `var r = { valueOf: … } / (hidden = { now: 1 },
// hidden[k]) / 2` mask the lookup in the middle of it: the dangerous direction, and the one
// the comment beside it had just claimed could not happen. Codex found it (#9, round 10).
const VALUE_AFTER = new Set("=(,:[?!&|+-*/%~^<>".split(""));
// A `{` opens a value after an operator, or after a keyword that takes one.
const opensValue = (last, word) => VALUE_AFTER.has(last) || (last === "kw" && !BLOCK_WORDS.has(word));
// The third is a function or class *expression*'s body. It is not an object literal — an
// empty one is an empty callback, not an empty map — but it is a value, so the `/` after
// its `}` is division: `var r = function () {} / x` hid a lookup the same way a literal
// did, one round later. Codex found it (#9, round 13). A *declaration*'s body is a block
// in both senses, and which one a `function` is comes from what stands before the keyword.
const MAKERS = new Set(["function", "class"]);

function lex(text) {
  const out = text.split("");
  const mask = new Uint8Array(text.length);
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const cover = (from, to) => { for (let k = from; k < to; k++) mask[k] = 1; };
  let i = 0;
  let last = "";
  let word = "";
  // The word before that one, which exists for a single construct: `for await (` puts a
  // second word between the head and its parenthesis, and reading the nearest one called
  // that parenthesis `await`'s. Then `for await (const x of y) /{}/.test(x)` took the `/`
  // for division — valid code reported as an empty object literal, the seventeenth red
  // gate, and the same sentence as round 18 one word further left. Found looking for the
  // family of Codex's round-37 finding rather than named by it.
  let prev = "";
  // What preceded each open paren, so a `)` can say which kind it is. `if (x) /re/` and
  // `(a + b) / 2` are the same character after the same bracket, and the only difference
  // is four characters further back.
  const heads = [];
  // …and what each open brace was: a value, or a block. `kinds` keeps that by position,
  // because the empty-literal rule needs the same answer — `catch {}` and `class E {}` are
  // blocks, and the list of exemptions that used to stand in for this could not say so.
  const braces = [];
  const kinds = new Map();
  // …and the same answer at the *closing* brace, because `}[` is read there and nowhere
  // else: `if (true) { run(); } [value].forEach(run)` is a block and an array literal, and
  // the rule that looks for a literal indexed on the spot had only the character to go on.
  // Codex found it (#9, round 28) — the ninth time this gate has failed valid code, and the
  // third of those where the lexer already knew the answer and the rule did not ask.
  const closes = new Map();
  // Whether the next `{` is a function or class expression's body (true), a declaration's
  // (false), or neither (null).
  let maker = null;
  // The bracket depth the `function` or `class` keyword stood at; only a brace one deeper
  // than that is its body.
  let makerAt = -1;
  // The depth of a parameter list, so a brace that opens a *parameter* can be told from one
  // that opens a default value. `function f({})` and `catch ({})` are binding patterns, and
  // calling them object literals failed the gate on valid code — the sixth time that has
  // happened here. Codex found it (#9, round 23); the `catch` half it did not name, and was
  // there too. An arrow's parameter list is *not* covered: `({}) => {}` and `({})[k]` differ
  // only in what follows the `)`, and guessing would cost the round-22 rule that reads the
  // second one. app.js is ES5 throughout and writes neither.
  // Which parentheses are open, how deep each one is, and the empty literals written
  // directly inside it. A parenthesis turns out to be a *parameter list* only at its `)` —
  // when what follows is `=>` or a body — so the braces inside it are re-read then. The rule
  // it replaces named the two shapes it knew, `function` and `catch`, and called everything
  // else a literal: `({}) => 1`, `class Z { m({}) {} }`, `var p = { m({}) {} }` and
  // `(a, {}) => a` were all red gates on valid code. Codex found them (#9, round 34), the
  // fourteenth. A head that is `if`, `while`, `for` or `with` is never a parameter list,
  // which the `heads` stack already knows.
  const parens = [];
  const closerOf = new Map();
  const braceAt = [];
  // A `:` is two things as well: the one in `{ a: 1 }` puts what follows in expression
  // position, and the one in `case 1:` or `outer:` does not — so `case 1: {}` was read as
  // an empty object literal and failed CI on a valid switch arm. Codex found it (#9, round
  // 14). Which one it is comes from where the thing before it stood, and the brace stack
  // already knows whether the enclosing `{` was a literal or a block.
  let identStart = "";
  // What stood before an `async` that is still waiting for its `function`.
  let carried = null;
  // How deep the brackets were when a `case` or `default` was seen. Its label is closed by a
  // colon at *that* depth and no other: `case { a: {} }.a:` has a property colon inside the
  // case expression, and taking that one for the label left the nested literal read as a
  // block. Codex found it (#9, round 19).
  // …and a conditional inside the case expression has its own colon at that very depth, so
  // depth alone is not enough: `case flag ? 1 : { … }[k]:` closed the label on the ternary's
  // colon and the literal after it was then read as a block. Codex found it (#9, round 32).
  // The open conditionals are counted, and the first colon that is not owed to one of them
  // is the label's.
  let nesting = 0;
  let labelDepth = -1;
  let pendingLabel = false;
  let ternaries = 0;
  // A template is not one opaque run: `${…}` inside it is code, and masking through to the
  // closing backtick hid a lookup written there. Each frame is the template's text, or a
  // substitution and how deep its braces are.
  const nest = [];
  const top = () => nest[nest.length - 1];
  // Statement position: the start, after a `;`, after a block's `}`, after a control-flow
  // head's `)`, or just inside a `{` that is not an object literal.
  const statementPlace = (token) =>
    token === "" || token === ";" || token === "}" || token === ")head" ||
    (token === "{" && braces[braces.length - 1] !== "literal");
  while (i < text.length) {
    const c = text[i];
    // Inside a template's text, the only three things that matter.
    if (top() && top().kind === "tpl") {
      if (c === "\\") { cover(i, i + 2); i += 2; continue; }
      if (c === "`") { cover(i, i + 1); i++; nest.pop(); last = "`"; word = ""; continue; }
      // `nesting++` because the `}` that closes this substitution reaches the counter below,
      // so without it every template leaves the count one lower than it was — measured at
      // -3 across the fixture's three of them.
      //
      // **There is no claim for this line, and that is deliberate.** Every comparison the
      // counter feeds is between two numbers that drift together, so the drift cancels, and
      // I could not build a case where removing this changes an answer — including the one
      // that should have worked, a substitution inside a parameter list, where the reset
      // below lands on the same verdict by a different route. So it is a correctness fix
      // with an unobservable effect, which is a thing worth writing down rather than
      // covering with a mutation that would not bite.
      if (c === "$" && text[i + 1] === "{") {
        cover(i, i + 2); i += 2; nesting++; nest.push({ kind: "sub", depth: 0 });
        // A substitution is an expression, and everything written inside it is a value. The
        // level stack below has to hear about this brace, because it will hear about the `}`
        // that closes it — and a push that never happened is a *pop* of somebody else's
        // level, which is how `(a = { x: `${y}`, z: {} })` lost the value it was inside.
        if (parens.length) parens[parens.length - 1].levels.push({ value: true, afterEq: false });
        last = "{"; word = ""; continue;
      }
      cover(i, i + 1);
      i++;
      continue;
    }
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
    if (c === "`") {
      cover(i, i + 1);
      i++;
      nest.push({ kind: "tpl" });
      continue;
    }
    if (c === '"' || c === "'") {
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
    if (c === "/" && (last === "" || last === "kw" || last === ")head" || last === ":label" || REGEX_AFTER.has(last))) {
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
    // An identifier is one token. Accumulating it character by character joined the two
    // in `return function` into `returnfunction`, so the keyword that decides its own
    // body's kind was never seen — the first attempt at the round-13 fix did nothing, and
    // the rig said so. `last` becomes a placeholder rather than the final letter: a `/`
    // after a name is division, which is what the letter meant anyway.
    IDENT.lastIndex = i;
    const name = IDENT.exec(text);
    if (name) {
      const ident = name[0];
      const j = i + ident.length;
      // `async` stands in front of the keyword without changing where it stands. Reading it
      // as an ordinary name meant `var r = async function () {}` looked like a declaration
      // and its body like a block, so the `/` after it masked a lookup — the same defect as
      // round 13, one word to the left. Codex found it (#9, round 16).
      if (ident === "async") { carried = { last, word }; }
      else if (MAKERS.has(ident)) {
        const from = carried || { last, word };
        maker = opensValue(from.last, from.word);
        // …and the brace that is its body is the one *after* the parameter list.
        // `function f(k, lookup = { now: [] }) { … }` has a literal in the parameters, and
        // letting the first brace consume `maker` classified that literal as the body and
        // left the real body to the ordinary rule. Codex found it (#9, round 21).
        makerAt = nesting;
        carried = null;
      } else carried = null;
      if ((ident === "case" || ident === "default") && statementPlace(last)) { pendingLabel = true; labelDepth = nesting; ternaries = 0; }
      identStart = last;
      prev = word;
      word = ident;
      // A reserved word after a `.` is a property name — `holder.yield` is a value, and
      // reading it as a keyword made the `/` after it a regex and masked what followed.
      // Codex found it (#9, round 21). Round 19 was the same sentence about contextual
      // words; this is the other half, where the *position* rather than the word decides.
      // `?.yield` arrives here with a `.` in front of it too.
      last = identStart !== "." && RESERVED.has(ident) && !VALUE_WORDS.has(ident) ? "kw" : "w";
      i = j;
      continue;
    }
    // A `?` that opens a conditional inside the case expression owes a colon. `?.` and `??`
    // owe none, and are told apart by the character after.
    if (c === "?" && pendingLabel && nesting === labelDepth && text[i + 1] !== "." && text[i + 1] !== "?" && last !== "?") ternaries++;
    if (c === ":") {
      const owed = pendingLabel && nesting === labelDepth && ternaries > 0;
      if (owed) ternaries--;
      const closesLabel = pendingLabel && nesting === labelDepth && !owed;
      last = closesLabel || (last === "w" && statementPlace(identStart)) ? ":label" : ":";
      if (closesLabel) pendingLabel = false;
      word = "";
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") nesting++;
    else if (c === ")" || c === "]" || c === "}") nesting--;
    if (c === "(") {
      // `levels` is the bracket nesting *inside* this parenthesis, which is what says whether
      // a brace is a binding position. See the `{` below.
      parens.push({ depth: nesting, braces: [], levels: [{ value: false, afterEq: false }] });
      heads.push(word === "await" && prev === "for" ? "for" : word);
    }
    // A pattern nests, and round 34 read only its first level: `function f({ value: {} }) {}`
    // had its inner brace reported, and so did `([{}]) => 1`, `({ a: [{}] })` and
    // `({ a: { b: {} } })` — the eighteenth red gate on valid code, which Codex found
    // (#9, round 38). What a default value does *not* do is nest: in `({ a = {} })` and
    // `(a = [1, {}])` the brace after the `=` is an expression, and an empty object literal
    // there is one — the fixture has said so since round 7 and must keep saying it. So each
    // bracket level inside the parenthesis carries whether it is a *value*, which everything
    // inside it inherits, and each level carries whether an `=` has started a default, which
    // the next comma ends. "Reclassify the pattern recursively" would have taken the defaults
    // with it.
    const holder = parens[parens.length - 1];
    const level = holder && holder.levels[holder.levels.length - 1];
    if (level) {
      if (c === ",") level.afterEq = false;
      // The character before is what tells this `=` from `==`, `<=`, `!=` and an arrow.
      else if (c === "=" && !/[!<>+\-*/%&|^=]/.test(last) && text[i + 1] !== "=" && text[i + 1] !== ">") level.afterEq = true;
    }
    // A binding position: a level that is not a value, not past an `=`, and a brace written
    // where a parameter or a pattern's part is written rather than where a value is.
    const binding = !!level && !level.value && !level.afterEq &&
      (last === "(" || last === "," || last === ":" || last === "[");
    if (holder && (c === "{" || c === "[")) holder.levels.push({ value: !binding, afterEq: false });
    if (holder && (c === "}" || c === "]") && holder.levels.length > 1) holder.levels.pop();
    if (c === "{") {
      let kind;
      if (maker !== null && nesting === makerAt + 1) { kind = maker ? "fnvalue" : "block"; maker = null; }
      else kind = last !== "=>" && opensValue(last, word) ? "literal" : "block";
      // A brace in a binding position inside a parenthesis may yet turn out to be a
      // parameter's pattern; the `)` decides.
      if (kind === "literal" && binding) holder.braces.push(i);
      braceAt.push(i);
      braces.push(kind);
      kinds.set(i, kind);
      if (top() && top().kind === "sub") top().depth++;
    }
    if (c === "}" && top() && top().kind === "sub") {
      if (top().depth === 0) { cover(i, i + 1); i++; nest.pop(); last = "`"; word = ""; continue; }
      top().depth--;
    }
    if (/\S/.test(c)) {
      if (c === ")") {
        const head = heads.pop();
        const holder = parens.pop();
        // `=>` or a body after the `)` makes it a parameter list, and every empty literal
        // written straight inside it a pattern. Read at the `)` because that is the first
        // place the answer exists.
        if (holder && holder.braces.length && !NOT_PARAMS.has(head)) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (text[j] === "{" || (text[j] === "=" && text[j + 1] === ">")) {
            for (const at of holder.braces) {
              kinds.set(at, "block");
              if (closerOf.has(at)) closes.set(closerOf.get(at), "block");
            }
          }
        }
        last = CONTROL.has(head) ? ")head" : ")";
      }
      else if (c === "}") {
        const was = braces.pop();
        closerOf.set(braceAt.pop(), i);
        closes.set(i, was);
        last = was !== "block" ? "}expr" : "}";
      }
      // `counter++ / x` is division: a postfix update is a value, and its second `+`
      // is not the operator that `+` usually is. `a + +b` collapses to the same token
      // and is division at the same place, so the one rule covers both.
      else if ((c === "+" || c === "-") && last === c) last = "++";
      // An arrow's `>` is not the comparison this would otherwise read: `x => {}` opens a
      // block, and `x => /re/.test(y)` opens a regex. One token says both.
      else if (c === ">" && last === "=") last = "=>";
      else last = c;
      // A name is a token of its own above; everything here ends one.
      word = "";
    }
    i++;
  }
  return { code: out.join(""), mask, kinds, closes };
}

// A key written as a string is the string it denotes, not the characters between the
// quotes: `"a\\-b"` and `"a-b"` are one key. Only the escapes JavaScript gives a different
// character to — everything else stands for itself, which is what the last branch says.
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
const unescape = (raw) => raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (all, what) => {
  if (what[0] === "u" || what[0] === "x") return String.fromCharCode(parseInt(what.slice(1), 16));
  return what in ESCAPES ? ESCAPES[what] : what;
});

function survey(text) {
  const { code, mask, kinds, closes } = lex(text);
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
  // that the file writes none.
  //
  // An empty *block* is not an empty map, and which one a `{}` is was a list of three
  // exemptions — an empty catch, an empty function body, an arrow — written from the
  // shapes app.js happened to contain. `try {} catch {}` with no binding and `class E {}`
  // are neither, and both were reported as empty object literals: a red gate on valid
  // code, which Codex found (#9, round 12). The lexer already answers this question for
  // the `/` after a `}`, so it answers it here too, and the list is gone.
  // …and a destructuring *assignment* is not a map either. `({} = source)` and
  // `({ a: {} } = source)` write a brace in value position with no keyword in front of it,
  // so the keyword rule that exempts `var {} = x` says nothing about them and both were
  // reported: a red gate on valid code, the tenth, which Codex found (#9, round 32). What
  // makes it a pattern is the `=` it is the target of, reached out through the patterns and
  // parentheses it sits inside.
  // …and `=` is one of three spellings of "is the target of". `for ({} of rows)` and
  // `for ({} in src)` put the pattern in front of a word instead, and both were reported —
  // a red gate on valid code, the fifteenth, which Codex found (#9, round 37). The array
  // form `for ([{}] of rows)` came with them, since reaching out through the closers is
  // what all three have in common and it was already written. What this gives up is `({} in
  // src)` as an expression, where an empty literal is a key: not a lookup table by any
  // reading, and the direction to err in.
  const TARGET_WORD = /^(?:of|in)(?![\p{ID_Continue}$])/u;
  const patternTarget = (from) => {
    for (let i = from; i < code.length; i++) {
      const c = code[i];
      if (mask[i] || /\s/.test(c)) continue;
      if (c === "}" || c === "]" || c === ")") continue;
      if (TARGET_WORD.test(code.slice(i, i + 3))) return true;
      return c === "=" && code[i + 1] !== "=" && code[i + 1] !== ">";
    }
    return false;
  };
  for (const m of [...code.matchAll(/\{\s*\}/g)].filter(inCode)) {
    if (kinds.get(m.index) !== "literal") continue;
    if (patternTarget(m.index + m[0].length)) continue;
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
  // `Object.create(null)` is deliberately absent — that is the cure, not the hazard — and
  // `Object.assign` left with round 37: it hands back its first argument rather than making
  // anything, which is a different question answered in a different place.
  // One list. Written twice, a factory added to only one of them made the gate go *quiet*
  // rather than red — recorded as an opener that `hasPrototype` then denies, or found by
  // neither — which is the failure this file exists to catch, in the file itself.
  const FACTORIES = `Object\\.fromEntries\\(|JSON\\.parse\\(|new Object\\(|Object\\.create\\(\\s*\\{`;
  const FACTORY = new RegExp(FACTORIES);
  // What a name is bound to is an *expression*, not a token. `var x = flag ? { … } : { … }`
  // holds one of two literals and `var x = y || { … }` may hold one, and matching the opener
  // immediately after the `=` saw neither — Codex found the conditional (#9, round 18).
  // Widening that regex one shape at a time is what rounds 14 and 17 already were, so the
  // initialiser is read to the end of its declarator instead, and every opener at its *top*
  // level is a binding of the name. The grouping parentheses of round 17 fall out of that
  // rather than being a case in a pattern.
  //
  // Depth counts brackets and parentheses, so `f({ … })` and `[{ … }]` are not bindings:
  // there the literal is an argument or an element, and what the name holds is the call's
  // answer or the array. The read stops at the `;` or `,` that ends the declarator, or at
  // the bracket that closes whatever the expression sits inside.
  const OPENER = new RegExp(`table\\(|dict\\(\\)|${FACTORIES}|\\{`, "y");
  const bound = new Map();
  // Words a value is never held under.
  const ALIAS_SKIP = new Set(["function", "new", "typeof", "return", "true", "false", "null", "undefined", "this", "void", "delete", "in", "of", "case"]);

  // One spelling of "a quoted body, escapes and all", used by both the fragment that finds
  // a constant path segment and the one that reads a quoted key.
  const DQ = `(?:[^"\\\\]|\\\\.)*`;
  const SQ = `(?:[^'\\\\]|\\\\.)*`;
  const STRING = `"${DQ}"|'${SQ}'`;
  // …and one spelling of a number, because a key may be written as one: `table({ 0: { … } })`
  // is indexed `outer[0][k]`, and `STEPS` read a dot name or a quoted bracket and nothing
  // else, so the path reached nothing. Codex found it (#9, round 41). The mirror was missing
  // on the *writing* side at the same time — a literal's `0:` was no key either, since a key
  // had to start like a name — which is the fourth round in a row whose finding was one half
  // of a pair.
  const NUMBER = `[-+]?(?:0[xXoObB][0-9a-fA-F_]+|(?:\\d[\\d_]*(?:\\.[\\d_]*)?|\\.[\\d_]+)(?:[eE][-+]?\\d+)?)n?`;
  // A key is the string it denotes. For a quoted one that is what is between the quotes; for
  // a number it is `String(Number(…))`, which is not a guess — it is the conversion the
  // language does, so `{ 16: … }`, `t[0x10]` and `t["16"]` are one key by construction rather
  // than by a table of spellings. A number this cannot read is no key at all.
  const numberKey = (raw) => {
    const n = Number(raw.replace(/_/g, "").replace(/n$/, ""));
    // Infinity is a key like any other — `{ 1e999: … }` is the key `Infinity`, which is what
    // the conversion says and what a fixture line holds. Only a number this cannot read at
    // all is no key.
    return Number.isNaN(n) ? null : String(n);
  };
  const asKey = (raw) => (/^["']/.test(raw) ? unescape(raw.slice(1, -1)) : /^[-+.\d]/.test(raw) ? numberKey(raw) : raw);
  const CONSTANT = `${STRING}|${NUMBER}`;
  const SEGMENT = new RegExp(`\\.\\s*(${ID})|\\[\\s*(${CONSTANT})\\s*\\]`, "gu");
  const STEPS = `(?:\\s*(?:\\?\\.|\\.)\\s*${ID}|\\s*(?:\\?\\.)?\\s*\\[\\s*(?:${CONSTANT})\\s*\\])`;
  // A path is all of its steps or none of them: one segment this cannot read leaves a path
  // that means something else, and a *shorter* path is not a safer answer — it is a different
  // question. So an unreadable one empties the whole reading, which every caller already
  // treats as "no path here".
  const segmentsOf = (text) => {
    const steps = [...text.matchAll(SEGMENT)].map((piece) => (piece[1] !== undefined ? piece[1] : asKey(piece[2])));
    return steps.includes(null) ? [] : steps;
  };
  // A match that ends at its `[`, so the bracket can be read — and one sticky reader of it,
  // because three places ask "does an index start here" and a hand-spelling in any of them
  // would not learn the next shape this grows. It grew `?.` once already.
  const INDEX = `\\s*(?:\\?\\.)?\\s*\\[`;
  const INDEX_AT = new RegExp(INDEX, "y");
  // …and one for a run of steps, for the walk: `STEPS` itself, so the value side and the
  // index side cannot come to read a path differently.
  const STEP_TAIL = new RegExp(`(?:${STEPS})+`, "yu");
  // The position just past the `[` of an index that starts here, or -1.
  const indexAt = (at) => {
    INDEX_AT.lastIndex = at;
    return INDEX_AT.test(code) ? INDEX_AT.lastIndex : -1;
  };

  // Forward to the next character that is code. Six places stepped over whitespace by hand,
  // two of them consulting `mask` and four not, with nothing saying why.
  const skip = (i) => {
    while (i < code.length && (mask[i] || /\s/.test(code[i]))) i++;
    return i;
  };
  // …and forward over whitespace *only*, which is a different question: a string is not
  // whitespace, and the pattern reader below has keys that are written as one — `skip` steps
  // over `{ "inner": x }`'s key as though it were not there. Comments are blanked to spaces
  // by the lexer, so both of these step over those.
  const spaced = (i) => {
    while (i < code.length && /\s/.test(code[i])) i++;
    return i;
  };
  // Whether a parenthesis is a transparent call's, asked of the text that runs up to and
  // including it — a position in some places and a match in others, one reading in all of
  // them. Round 36 wrote the test twice and round 37 needed it in two more places, which is
  // where the second copy would have started drifting from the first.
  const throughAt = (upTo) => THROUGH_END.exec(upTo.trimEnd());
  // Only the *first* argument of such a call is what it hands back, so the rest of the list
  // is stepped over rather than read: `Object.defineProperty(dict(), "x", { value: 1 })` is
  // a dict, and reading the descriptor as part of the value would report it: the red gate
  // this round's own fix would have shipped, had the rule stopped at the name. From a
  // position inside an argument list to the `)` that closes it, or -1 if the text runs out.
  const restOfCall = (from) => {
    let depth = 0;
    for (let i = from; i < code.length; i++) {
      if (mask[i]) continue;
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return i;
        depth--;
      }
    }
    return -1;
  };

  // The walk answers two questions about an initialiser: which openers it contains, and
  // whether it *is* a bare name. `var lookup = (source)` was invisible while
  // `var lookup = ({ … })` was not, because the openers were read by this walk — which is
  // transparent to grouping parentheses — and the name by a regex that wanted it hard
  // against the `=`. Codex found it (#9, round 27), and it is round 26 one level down: two
  // readings of one thing, only one of them taught. So whatever the walk is transparent to,
  // it is transparent to for both answers.
  // `inGroup` when the caller has already stepped over the opening parenthesis: then a comma
  // is the sequence operator rather than the end of a declarator, which is the difference
  // between reading `(sideEffect(), N)` as `N` and not reading it at all.
  const readInitialiser = (from, inGroup, inThrough) => {
    const found = [];
    const open = [];
    let depth = 0;
    // The name so far, and whether anything has happened to it that means the value is no
    // longer just that name: an operator, a property access, a call, a number. A branch
    // separator starts the question again — `?` discards what it read, because that was the
    // condition, and `:` keeps it, because that was a branch. A sequence comma discards, for
    // the same reason `(sideEffect(), source)` is `source`. A `||` keeps what it read and a
    // `&&` discards it, from the one fact: an object is truthy, so `a || b` *is* `a` when `a`
    // holds one, and `a && b` never is. I had both of those as “the right operand only” and
    // wrote the reason for the `&&` next to the rule for the `||`; Codex found the half that
    // was a miss (#9, round 28). Reading a gap out loud is not the same as checking it.
    // `??` keeps its left for the same kind of reason — an object is not nullish — and is
    // told from a conditional `?` by the character after it. I saw this one while writing the
    // `||` rule and left it, which is how it came back as round 29.
    // Nothing is written down until the operand it belongs to is over, because an operand
    // that looked like a name can stop being one after the fact: `(subject || "").trim()`
    // reads `subject` and then calls something on the parenthesis, and a name pushed at the
    // `||` could not be taken back. app.js has two of those. So `current` is what this
    // operand could be, `list` is what the expression could be, and only an operand that
    // ends unpoisoned joins the list.
    // An operand is a *root and a path* — `source` is that root with no path, `source.inner`
    // is the same root with one step. They were names alone until round 40, where a name
    // bound by destructuring turned out to be a path read of the value beside it and the
    // machinery to say so did not exist. One shape for both, because `{ inner } = source` and
    // `= source.inner` are the same sentence and had better not be two readings of it.
    let current = [];
    let list = [];
    let poisoned = false;
    const commit = () => {
      if (!poisoned) for (const cand of current) if (cand.path.length || !ALIAS_SKIP.has(cand.root)) list.push(cand);
      current = [];
    };
    const branch = (keep) => {
      if (keep) commit();
      current = [];
      poisoned = false;
    };
    // A grouping parenthesis is its own expression: it starts the question again, and what
    // it hands back is one operand of the expression it sits in — which may poison it
    // afterwards. `b.title = level ? "P: " + (LABEL[level] || level) : "none"` hands `title`
    // a concatenation, not `level`. Measured against app.js, which is where it appeared.
    const outer = inGroup ? [{ list: [], poisoned: false, through: !!inThrough }] : [];
    // Grouping parentheses are transparent to `depth` so that `x = ({ … })` binds the
    // literal — but they still enclose, and a comma inside one is a sequence operator rather
    // than the end of the declarator: `var x = (sideEffect(), { … })` stopped the read before
    // the literal. Codex found it (#9, round 19). How many are open is `outer.length`, the
    // stack they already push their poison onto; a second counter alongside it could only
    // ever have said the same thing or been wrong.
    let before = "=";
    let at = code.length;
    for (let i = from; i < code.length; i++) {
      at = i;
      if (mask[i] || !/\S/.test(code[i])) continue;
      const c = code[i];
      if (depth === 0) {
        // A property path is a value like any other: `var lookup = source.inner` holds what
        // `source.inner` holds, where the reading stopped at the dot and called the operand
        // poisoned — the boundary the success line has named since round 8 and the one a
        // destructuring turns out to be written in. The steps come off `STEPS`, the fragment
        // the index side reads a path with, and they are appended to whatever candidates the
        // operand has: `(a.b || c).d` is `a.b.d` or `c.d`, which falls out rather than being
        // a case. A step that is not constant — `source[k]` — matches nothing here and
        // poisons the operand below, as it did before.
        if (current.length && !poisoned && (c === "." || c === "[" || (c === "?" && code[i + 1] === "."))) {
          STEP_TAIL.lastIndex = i;
          const tail = STEP_TAIL.exec(code);
          if (tail) {
            const steps = segmentsOf(tail[0]);
            // A step that was matched and could not be read is not *no* step: without this
            // the operand quietly becomes an alias of its own root, and `var x = source[0]`
            // would answer for `source` itself. Measured — it is what the mutation for the
            // segment reader produces.
            if (!steps.length) { poisoned = true; current = []; }
            else for (const cand of current) cand.path = cand.path.concat(steps);
            before = code[STEP_TAIL.lastIndex - 1];
            i = STEP_TAIL.lastIndex - 1;
            continue;
          }
        }
        if (IDENT_PART.test(c)) {
          if (before !== "." && !IDENT_PART.test(before)) {
            IDENT.lastIndex = i;
            const word = IDENT.exec(code);
            if (!word) poisoned = true;
            else if (!poisoned) current = [{ root: word[0], path: [] }];
          }
        } else if (c === "?") branch(code[i + 1] === "?");
        else if (c === ":") branch(true);
        else if (c === "|") branch(true);
        else if (c === "&") branch(false);
        else if (c === "," && outer.length) {
          // …except in a transparent call, where the first argument is the whole value and
          // the rest of the list is not read at all. In grouping parentheses the same comma
          // is the sequence operator, which starts the question again instead.
          const group = outer[outer.length - 1];
          if (group.through) {
            const end = restOfCall(i);
            if (end < 0) break;
            i = end - 1;
            continue;
          }
          // …and in a selected array it separates elements, every one of which may be the
          // one selected, so what it reads is kept rather than dropped.
          branch(!!group.selected);
        }
        // `lookup = alias = unsafe` hands `lookup` what the inner assignment is worth, which
        // is `unsafe` and not `alias` — so the target is discarded and the reading carries on
        // to the right of it. The character before is what tells this `=` from the one in
        // `!=`, `<=` or `>=`, where an operand was already read and must stay poisoned.
        else if (c === "=" && !/[!<>+\-*/%&|^=]/.test(before)) branch(false);
        else if (!/[([{)\]}]/.test(c) && c !== ";" && c !== ",") {
          poisoned = true;
          current = [];
        }
        OPENER.lastIndex = i;
        const m = OPENER.exec(code);
        // `var v = function (k, x) { … }` has a `{` at the top level of its initialiser and
        // it is a body, not a map. The lexer has classified every brace already, so this
        // asks it rather than guessing from what precedes — measured: without it, `v` was
        // reported twice in app.js, from two different functions that both spell a
        // formatter that way.
        if (m && (m[0] !== "{" || kinds.get(i) === "literal")) found.push({ opens: m[0], at: i });
      }
      if (c === "(" || c === "[" || c === "{") {
        // A grouping parenthesis is transparent — `x = ({ … })` binds the literal — while a
        // call's is not, because `x = f({ … })` binds whatever `f` answered.
        const through = c === "(" && !!throughAt(code.slice(Math.max(0, i - 40), i + 1));
        // An array literal that is *selected from* hands back one of its elements, so it is
        // transparent the way grouping parentheses are: `var t = [{ … }][0]` holds the
        // literal where `var t = [{ … }]` holds the array, and the index after its closer is
        // the whole difference. Codex found it (#9, round 39). *Which* element it hands back
        // is a question about the key, and every element is a possible answer — so all of
        // them are kept, the way both sides of a `||` are. An array nobody indexes is still
        // the array, which is the fixture line this must not move.
        //
        // What it does not reach is the same selection with no name to hold it,
        // `[{ … }][0][k]`: the two anonymous rules below read a literal's own closing brace
        // or a parenthesis in front of it, and an array's closer is neither. A gap in reach,
        // written down rather than implied, and the direction to err in.
        let selected = false;
        if (c === "[" && depth === 0) {
          const close = restOfCall(i + 1);
          selected = close >= 0 && indexAt(close + 1) >= 0;
        }
        const grouping = through || selected ||
          (c === "(" && before !== ")" && before !== "]" && !IDENT_PART.test(before));
        // A call or an index is not the name that precedes it — `f(source)` holds whatever
        // `f` answered, not `source`.
        if (!grouping && depth === 0) {
          poisoned = true;
          current = [];
        }
        if (grouping) {
          outer.push({ list, poisoned, through, selected });
          list = [];
          current = [];
          poisoned = false;
        } else depth++;
        open.push(grouping);
        before = c;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        if (!open.length) break;
        if (open.pop()) {
          // The last operand inside is the parenthesis's value, and the parenthesis is then
          // one operand of what encloses it — which is where it was, poison and all.
          commit();
          const inner = list;
          const saved = outer.pop();
          list = saved.list;
          poisoned = saved.poisoned;
          current = inner;
          // The index that did the selecting is part of it, not a read of what it selected:
          // left in the text, `[source][0]` poisons the very operand it just picked, and the
          // literal survives only because the openers were already written down.
          if (saved.selected) {
            const after = indexAt(i + 1);
            const close = after >= 0 ? restOfCall(after) : -1;
            if (close >= 0) i = close;
          }
        } else depth--;
        before = c;
        continue;
      }
      if (depth === 0 && c === ";") break;
      if (depth === 0 && !outer.length && c === ",") break;
      before = c;
    }
    commit();
    // The two kinds of candidate the walk can end with, told apart by whether anything was
    // read off them.
    return {
      found,
      holds: list.filter((cand) => !cand.path.length).map((cand) => cand.root),
      paths: list.filter((cand) => cand.path.length),
      at,
    };
  };
  // A member assignment binds a *path*, not a name. `left.lookup = { … }` recorded `lookup`
  // and the name-keyed rule then read an unrelated `right.lookup[k]` as the same thing —
  // valid code, failing the gate, which is the seventh time that has happened here and the
  // first from a name collision rather than a misclassification. Codex found it (#9, round
  // 24). So the receiver is kept: the path goes in its own map, where only the path rule
  // can reach it, and the bare name is not recorded at all.
  // How a path is spelled and how it is read back as a key — defined here because both the
  // assignment side and the reading side need the same answer. Round 10 taught the reader
  // that `t["status"]` and `t.status` are one path; round 24 then built a *writer* that knew
  // only dots, so `o["lookup"] = { … }` was recorded under nothing. Codex found it (#9,
  // round 25) — the same failure to look for the mirror that round 17 was.
  // `var source = { now: 1 }; var lookup = source; lookup[k]` — the object is one name and
  // the index is another, and asking only about the name that was bound certified it. So
  // the plain `a = b` assignments are edges, walked in both directions: from a binding
  // *out* to whatever may be holding its value when the index happens, and from an index
  // *back* to the binding whose literal it reaches. Only a bare identifier on the right —
  // `a = b.c`, `a = b(…)` and `a = b[…]` are all something this cannot follow, and they
  // are the boundary the success line names.
  //
  // An assignment is read *once*, and what it binds and what it aliases both come out of
  // that one reading. They were two passes over the same text — this one path-aware since
  // round 24, the alias one still name-only — so `left.lookup = source` kept its receiver
  // as a binding and dropped it as an alias, and an unrelated `right.lookup[k]` was then
  // read as an index of `source`: valid code, failing the gate, the eighth time. Codex
  // found it (#9, round 26). It is the missing mirror of rounds 17 and 25 once more, and
  // the answer is again to delete the second implementation rather than teach it what the
  // first one already knows — there is no longer a place where the two can disagree.
  // The lookbehind is the rest of keeping the receiver. Without it a match could *start*
  // in the middle of a path whose root is not a name, so `f().lookup = { … }` bound a bare
  // `lookup` — the same collision from the same dropped receiver, in a shape Codex did not
  // name and this found by looking for its siblings. A receiver that cannot be resolved
  // yields nothing now, which is the boundary every unresolvable root here has.
  const members = new Map();
  const memberHolds = new Map();
  const holders = new Map();
  const heldFrom = new Map();
  // …and what holds a *path* rather than a name: `var lookup = source.inner` and
  // `left.lookup = source.inner`, which are the two targets every other map here comes in a
  // pair for. Keyed by the path's spelling so the same one twice is once.
  const heldPaths = new Map();
  const memberPaths = new Map();
  const link = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  const linkPath = (map, key, p) => {
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(`${p.root === null ? p.from.map((b) => b.at).join("+") : p.root}.${p.path.join(".")}`, p);
  };
  // `x ||= { … }`, `x &&= v` and `x ??= v` all put the right side into `x` — in two of the
  // three only sometimes, which is the same “may hold” every alias here already means. They
  // are the siblings of round 29's finding, and the reading was blind to all three: the
  // character before the `=` was not one it allowed. `+=` still is not, because a sum is not
  // the thing that was added to it.
  // Grouping parentheses are allowed around the target too — around the whole of it,
  // `(holder.lk) = { … }`, or around its root, `(holder).lk = { … }`, or both. The reading
  // has been transparent to them on the *value* side since round 19 and on the *index* side
  // since round 22, and stopped at the `)` on this one. Codex found it (#9, round 31), which
  // is the third place the same parenthesis had to be taught separately.
  //
  // The outer pair is optional on each side rather than required in pairs, and that is not
  // laziness: `(B3 = { … }, B3[k])` puts an opening parenthesis in front of an assignment it
  // does not belong to, and a match that insisted on the closing one threw the whole
  // assignment away. Six fixture lines went dark the moment I tried it — which is what the
  // fixture is for, since the rule I would have written from reading the code was wrong.
  // Nothing is lost by ignoring an unpaired one: `x) = 1` is not a thing JavaScript parses,
  // and what makes this a target is the name and the `=`, not the parentheses.
  //
  // Every alternative begins with a character that must be there — a `(` or the first letter
  // of a name — and that is not a style choice. Written with one optional `(\(?)\s*` in
  // front, the pattern could match the empty string at any position, so V8 had no first-set
  // to filter on and tried all 663 000 offsets of app.js instead of the 32 000 that begin a
  // name. Measured: **1647 ms of a 1830 ms gate, down to 36 ms** when the parenthesis moved
  // into its own branch, with all 2262 matches identical. Named groups, because duplicating
  // the root renumbers the positional ones.
  const ROOT = (tag) => `(?:\\(\\s*(?<p${tag}>${ID})\\s*\\)|(?<n${tag}>${ID}))`;
  const KEYWORD = `(?:\\b(?:var|let|const)\\s+)?`;
  const TAIL = `(?<steps>(?:${STEPS})*)\\s*\\)?\\s*(?:\\|\\||&&|\\?\\?)?=(?![=>])`;
  const TARGET = new RegExp(
    `(?<![\\p{ID_Continue}$.)\\]])(?:${KEYWORD}\\(\\s*${ROOT("g")}|${KEYWORD}${ROOT("b")})${TAIL}`,
    "gu"
  );
  for (const m of [...code.matchAll(TARGET)].filter(inCode)) {
    const g = m.groups;
    const root = g.pg !== undefined ? g.pg : g.ng !== undefined ? g.ng : g.pb !== undefined ? g.pb : g.nb;
    const steps = segmentsOf(g.steps);
    const path = steps.length ? `${root}.${steps.join(".")}` : null;
    const { found, holds, paths } = readInitialiser(m.index + m[0].length);
    const into = path ? members : bound;
    const key = path || root;
    for (const opener of found) {
      if (!into.has(key)) into.set(key, []);
      into.get(key).push(opener);
    }
    // A path holds the name the same way a name does, and keyed the same way — which is
    // the second half of round 26: `outer["lookup"] = inner` recorded nothing at all,
    // because only a literal or a factory on the right was ever written down.
    for (const held of holds) {
      if (path) link(memberHolds, path, held);
      else if (held !== root) {
        link(holders, held, root);
        link(heldFrom, root, held);
      }
    }
    // A path on the right is not an alias — `lookup` does not become another name for
    // `source`, it becomes another name for one thing *inside* it — so it is written down as
    // what it is and read back through `reached`, the same walk the index side does.
    for (const p of paths) if (p.root !== key) linkPath(path ? memberPaths : heldPaths, key, p);
  }

  // A destructuring binds each of its names to a *path* of the value beside it:
  // `var { lookup } = source` is `var lookup = source.lookup` spelled the other way round,
  // and `TARGET` above reads a name or a member path on the left of an `=`, so a pattern was
  // neither — every name one binds was invisible, not bound and not an alias and not
  // anything. Codex found it (#9, round 40). What it binds goes through the same `heldPaths`
  // a member expression on the right goes through, because they are the same sentence.
  //
  // Only an `=`. A pattern in a `for … of` head or a parameter list binds an element or an
  // argument, which is not a path of anything this can read, and those are the unresolvable
  // roots the success line has always named.
  const PATTERN_AT = new RegExp(`(?:\\b(?:var|let|const)\\s+|(?<![\\p{ID_Continue}$.)\\]])\\(\\s*)(?=[{[])`, "gu");
  // A pattern's parts are separated by commas at its own level; this is where the next one
  // starts, whatever was in between.
  const afterEntry = (from, close) => {
    let depth = 0;
    for (let i = from; i < close; i++) {
      if (mask[i]) continue;
      const c = code[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 0) return i + 1;
    }
    return close;
  };
  // A property of a pattern: a name, a constant key or a computed constant one — the same
  // spellings a literal's keys have — and whether a colon follows, which is what tells
  // `{ lookup }` from `{ lookup: alias }`.
  const PROP = new RegExp(`(?:(${ID})|(${CONSTANT})|\\[\\s*(${CONSTANT})\\s*\\])\\s*(:)?`, "yu");
  // What a pattern binds, and under which path of the value. Written here rather than read
  // with `keysOf`, which reads a *literal*: a pattern's grammar is not a literal's — it has
  // defaults and a rest element and no values at all — and one reader taught both grammars is
  // how this file has repeatedly ended up right about the cases it was shown.
  const patternBinds = (open, path, out) => {
    const close = restOfCall(open + 1);
    if (close < 0) return;
    const array = code[open] === "[";
    let i = open + 1;
    while (i < close) {
      i = spaced(i);
      if (i >= close) break;
      if (code[i] === ",") { i++; continue; }
      // A rest element is a *new* ordinary object, whatever it was taken from.
      if (code.startsWith("...", i)) {
        IDENT.lastIndex = spaced(i + 3);
        const rest = IDENT.exec(code);
        if (rest && !array) out.push({ name: rest[0], rest: true, at: i });
        i = afterEntry(rest ? IDENT.lastIndex : i + 3, close);
        continue;
      }
      let key = null;
      let target = i;
      if (!array) {
        PROP.lastIndex = i;
        const m = PROP.exec(code);
        if (!m) { i = afterEntry(i, close); continue; }
        key = m[1] !== undefined ? m[1] : asKey(m[2] !== undefined ? m[2] : m[3]);
        if (key === null) { i = afterEntry(i, close); continue; }
        if (m[4] === ":") target = spaced(PROP.lastIndex);
        else {
          // A shorthand is the key and the name at once, the way it is in a literal.
          out.push({ name: key, path: path && path.concat(key), at: i });
          i = afterEntry(PROP.lastIndex, close);
          continue;
        }
      }
      const inner = path && !array && key !== null ? path.concat(key) : null;
      if (code[target] === "{" || code[target] === "[") {
        patternBinds(target, inner, out);
        i = afterEntry(target, close);
        continue;
      }
      IDENT.lastIndex = target;
      const one = IDENT.exec(code);
      if (one) out.push({ name: one[0], path: inner, at: target, element: array });
      i = afterEntry(one ? IDENT.lastIndex : target, close);
    }
  };
  // A *default* in a pattern needs nothing here: `{ lookup = { … } }` is the assignment
  // `lookup = { … }` as far as text goes, and the loop above has bound it already. The
  // fixture says so in two lines rather than leaving it to be rediscovered.
  const restBinds = [];
  for (const m of [...code.matchAll(PATTERN_AT)].filter(inCode)) {
    const open = spaced(m.index + m[0].length);
    const close = restOfCall(open + 1);
    if (close < 0) continue;
    const eq = spaced(close + 1);
    if (code[eq] !== "=" || code[eq + 1] === "=" || code[eq + 1] === ">") continue;
    const binds = [];
    patternBinds(open, [], binds);
    if (!binds.length) continue;
    const read = readInitialiser(eq + 1);
    // What the value is, as roots a path can be asked of: the names it may hold, the paths it
    // may hold — and, when it is no name at all, `= table({ lookup: source })`, the openers
    // the walk found, bound under a name nothing in the file can spell so that the same
    // reading answers for them.
    const roots = [...read.holds.map((held) => ({ root: held, path: [] })), ...read.paths];
    if (read.found.length) roots.push({ root: null, from: read.found, path: [] });
    // An array pattern binds by *position*, and a position is not a key this can look up. The
    // one value it can answer for is an array literal written beside it, whose elements are
    // read the way a selection's are: any of them may be the one.
    const elements = binds.some((b) => b.element) && code[spaced(eq + 1)] === "["
      ? readInitialiser(spaced(eq + 1) + 1, true)
      : null;
    for (const b of binds) {
      if (b.rest) { restBinds.push(b); continue; }
      if (b.element) {
        if (!elements) continue;
        if (elements.found.length) {
          if (!bound.has(b.name)) bound.set(b.name, []);
          bound.get(b.name).push(...elements.found);
        }
        for (const held of elements.holds) if (held !== b.name) { link(holders, held, b.name); link(heldFrom, b.name, held); }
        continue;
      }
      if (!b.path) continue;
      for (const r of roots) linkPath(heldPaths, b.name, { root: r.root, from: r.from, path: r.path.concat(b.path) });
    }
  }
  // A literal is the only opener this can read *into*; a factory call is opaque, and
  // `bodyOf` would happily run past it to the next unrelated `{`.
  const isLiteral = (opens) => opens === "{" || opens === "table(";
  const hasPrototype = (opens) => opens === "{" || FACTORY.test(opens);

  const spread = (start, edges) => {
    const out = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const one = queue.pop();
      for (const next of edges.get(one) || []) if (!out.has(next)) { out.add(next); queue.push(next); }
    }
    return out;
  };
  // `(unsafe)[k]` is `unsafe[k]` with grouping parentheses around it, and the matcher read
  // only the second spelling. The lookbehind is what keeps `f(unsafe)[k]` out: there the
  // parenthesis belongs to the call and the thing being indexed is what `f` returned, not
  // the literal — app.js has eight of those and none of them is this. Nested grouping,
  // `((unsafe))[k]`, is not covered: a gap in reach, which is the direction to err in.
  const GROUPED = `(?<![\\p{ID_Continue}$)\\]])\\(\\s*`;
  // Where a name begins. `\b` is an ASCII boundary even under the `u` flag — `\bÖVER` matches
  // nothing at all, because neither the space in front of it nor the Ö itself is a `\w`. The
  // fixture line for a name *starting* with such a letter is what found that; the one that
  // merely contains one, `café`, passed either way.
  // …and a `.` in front of it means the name belongs to something else: `other.qq[k]` is an
  // index of *that* property and not of a variable spelled `qq`, which was reported all the
  // same. Round 24 taught the writing side that a property is not a name; this is the same
  // sentence on the reading side, and it turned up while writing a fixture line for one of
  // `/code-review`'s findings rather than from the finding itself.
  const EDGE = `(?<![.\\p{ID_Continue}$])`;
  // `x[k]` and `x?.[k]` are one read, and a `.` may be optional wherever it appears in a
  // path. app.js writes neither spelling — it is ES5 throughout — but a gate that goes
  // blind on an ordinary refactor is the thing this file keeps being reviewed for.
  // What makes a bracket a *lookup* is that its key is not a constant, and "the character
  // after the `[` is not a quote" is not that question: `lookup["" + externalKey]` starts
  // with one and is computed all the same. Codex found it (#9, round 22). So the bracket is
  // read: a sole string or number is a constant key, and anything else — a name, a
  // concatenation, a call — is data.
  // What starts a number, which is a digit *or* a decimal point in front of one: `[.5]` and
  // `[-.5]` are as constant as `[0.5]` is, and both were read as variable keys and reported —
  // the nineteenth red gate on valid code, which Codex found (#9, round 39). Round 33 widened
  // the *body* of a number to every spelling JavaScript has and left its first character as
  // the one digit test it had always been; this is that sentence finished.
  const numberAt = (j) => /\d/.test(code[j]) || (code[j] === "." && /\d/.test(code[j + 1]));
  const constantKey = (at) => {
    let i = at + 1;
    while (i < code.length && /\s/.test(code[i])) i++;
    const quote = code[i];
    if (quote === '"' || quote === "'") {
      // `cover()` masked the whole literal including both quotes, so the lexer's answer to
      // "where does this string end" is one loop instead of a second implementation of how
      // an escape works — the two had been living 480 lines apart.
      while (i < code.length && mask[i]) i++;
    } else if (numberAt(i) || ((quote === "-" || quote === "+") && numberAt(i + 1))) {
      // Every spelling JavaScript has for a number, not just the two this file writes:
      // `[1e3]`, `[0x10]`, `[-1]`, `[1_000]` and `[1n]` are all constant keys, and each was
      // read as a variable one and reported. A red gate on valid code, the eleventh, which
      // Codex found (#9, round 33). A sign only counts in front of a digit, and inside the
      // number only behind an exponent — otherwise `lookup[1 - n]`, which really is
      // computed, would be read as a constant.
      if (quote === "-" || quote === "+") i++;
      while (i < code.length) {
        if (/[\w.]/.test(code[i])) { i++; continue; }
        if ((code[i] === "+" || code[i] === "-") && /[eE]/.test(code[i - 1])) { i++; continue; }
        break;
      }
    } else return false;
    while (i < code.length && /\s/.test(code[i])) i++;
    return code[i] === "]";
  };
  const computed = (m) => inCode(m) && !constantKey(m.index + m[0].length - 1);
  // A name spliced into a pattern is not a name any more: `$` is an identifier character
  // and a regex anchor, so `$LOOK[k]` and `LOOK$[k]` matched nothing while `plain[k]` was
  // reported. `/code-review` found it, one round after the alphabet widened to admit far
  // more characters than `$`.
  // Both halves of the anonymous rule say it the same way, because the fixture counts them
  // as one claim.
  const ON_THE_SPOT = "an object literal indexed on the spot, without table()";
  const escapeRe = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Where a name stands to be indexed: bare, or inside grouping parentheses. Both readers
  // need it, and they had it written out in two orders — `GROUPED`/`EDGE` are the pair three
  // rounds went into, and a fix to one spelling would have missed the other, which is the
  // missing mirror of rounds 17, 25 and 26.
  const rooted = (name) => `(?:${EDGE}${name}|${GROUPED}${name}\\s*\\))`;
  // Whether a name is indexed by a variable anywhere, which is a scan of the whole file per
  // name — so it is asked once per name and remembered. Round 40 gave the rules a great many
  // more names to ask about, and the answer for a name cannot change while the file does not.
  const indexedNames = new Map();
  const indexedByAVariable = (name) => {
    if (!indexedNames.has(name)) {
      indexedNames.set(
        name,
        indexedGroup.has(name) ||
          [...code.matchAll(new RegExp(`${rooted(escapeRe(name))}${INDEX}`, "gu"))].some(computed)
      );
    }
    return indexedNames.get(name);
  };

  // The balanced inside of the literal an opener starts. For `table(` the literal is its
  // argument, so both openers are "the next `{` that is code".
  // The literal an opener opens is the one *at* it — not the next one anywhere in the file.
  // `table(` was read as though its argument were always a literal, so `var o = table(parsed)`
  // sent this hunting forward to an unrelated `{` and read its keys as `o`'s. app.js writes
  // exactly that at 1229, and `o` is an ordinary local name there, so the next `o.x[k]`
  // anybody wrote would have failed CI against someone else's object. `/code-review` found
  // it: the twelfth red gate on valid code, and the first that was not a reviewer's
  // construction but a shape already in the file.
  const bodyOf = (from) => {
    let open = from;
    while (open < code.length && (mask[open] || /\s/.test(code[open]))) open++;
    if (code[open] !== "{") return null;
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
  // The opener a key's value starts with — and a bare identifier counts, because
  // `table({ status: inner })` protects nothing about what `inner` holds. Ordered so that
  // `dict()` and `table(` win over the identifier that starts them.
  // …or no colon at all: `{ inner }` is the key `inner` holding whatever `inner` holds, and
  // reading only the colon form meant `table({ inner })` certified a path that reaches a
  // bare literal. Codex found it (#9, round 35). The lookahead is what keeps a method out:
  // in `{ m() {} }` the name is followed by `(`, so it is neither a shorthand property nor
  // a key. End-of-text counts as well, because what is read here is the *inside* of the
  // literal: the last shorthand in `{ inner }` has no comma and no brace after it, which is
  // how the first version of this matched nothing at all.
  // The wrapper is stepped over and not captured, so `opens` stays the opener itself.
  const VALUE = `(?:${THROUGH}\\s*)?(table\\(|dict\\(\\)|\\{|${ID}|)`;
  const KEY = new RegExp(`(${ID})\\s*(?::\\s*${VALUE}|(?=[,}]|$))`, "yu");
  // A constant key is the value it denotes: `"status-name"` is as much a key as `status` is,
  // and `0` is as much one as `"0"`. Restricting it to identifier shapes meant
  // `t["status-name"][k]` reached nothing — Codex found that (#9, round 12), and the numeric
  // half of the same sentence in round 41. One capture for the whole key rather than one per
  // quote: the two alternatives each carried their own copy of `VALUE`, which is two places
  // for the next round to teach and the shape every duplicated fragment here has had.
  const CONSTANT_KEY = new RegExp(`(${CONSTANT})\\s*:\\s*${VALUE}`, "yu");
  // …and a *computed* constant key is that same string one bracket further out:
  // `{ ["lookup"]: … }` is the key `lookup`, which the reading side has taken since round 10
  // — `t["lookup"]` and `t.lookup` are one path — while the writing side took neither
  // spelling of it. Codex found it (#9, round 38). A computed key that is not constant,
  // `{ [name]: … }` or a template, is a key this cannot know, and it is the same boundary a
  // root bound to a call has: it reaches nothing rather than reaching wrong.
  const COMPUTED = new RegExp(`\\[\\s*(${CONSTANT})\\s*\\]\\s*:\\s*${VALUE}`, "yu");
  // What a bracket does to a depth count. Written twice twenty lines apart, and the second
  // copy exists because the first one was missing a case — which is the argument for there
  // being one.
  const delta = (ch) => ("{[(".includes(ch) ? 1 : "}])".includes(ch) ? -1 : 0);
  const keysOf = (body) => {
    const keys = new Map();
    let depth = 0;
    for (let i = 0; i < body.text.length; i++) {
      const c = body.text[i];
      const quoted = body.mask[i] === 1;
      if (quoted && !(c === '"' || c === "'")) continue;
      // Four spellings, one position: a name, a string, a number, or a computed constant. The
      // bracket a computed key opens with is the bracket the depth counter is watching for,
      // so the match is tried *before* the counter takes it — `["lookup"]:` is a key and
      // `[0]` is an index — and the counter takes it when there is no key here after all.
      const here =
        depth === 0 &&
        !(!quoted && i > 0 && IDENT_PART.test(body.text[i - 1])) &&
        // Only the quote that *opens* a string — an escaped one inside it is masked too.
        !(quoted && i > 0 && body.mask[i - 1] === 1);
      const re = quoted ? CONSTANT_KEY : c === "[" ? COMPUTED : /[-+.\d]/.test(c) ? CONSTANT_KEY : KEY;
      let m = null;
      if (here) {
        re.lastIndex = i;
        m = re.exec(body.text);
      }
      if (!m) {
        if (!quoted) depth += delta(c);
        continue;
      }
      // A key, however it is spelled, is the string it denotes — and a shorthand is its own
      // value and stands where it is written.
      const bare = re === KEY;
      const name = bare ? m[1] : asKey(m[1]);
      if (name === null) { depth += delta(c); continue; }
      const short = bare && m[2] === undefined;
      const opens = short ? name : m[2];
      const at = short ? body.at + i : body.at + i + m[0].length - opens.length;
      if (!keys.has(name)) keys.set(name, { opens, at });
      // The match consumed the token the value *opens* with, and the scan then jumps past
      // it — so the brackets inside it never reached the depth counter while their closers
      // did. Depth went to -1 at the end of the first nested literal, and from there every
      // later key of the parent was skipped and the nested one's keys were read as the
      // parent's: a miss and a false positive from the same line. `/code-review` found it.
      // …and the wrapper it stepped over on the way there, whose `(` is a bracket like any
      // other. Counting only `opens` left the depth one short after every transparent value,
      // so `table({ s: Object.freeze({ … }), t: { … } })` lost every key after the first and
      // the round-36 fix quietly cost reach it was written to add. Nothing reported it;
      // found looking for the rest of round 37's family.
      const wrap = throughAt(m[0].slice(0, m[0].length - opens.length));
      for (const ch of (wrap ? wrap[0] : "") + opens) depth += delta(ch);
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
  // A name holds what it was bound to, what it was aliased from — and what the path it was
  // read out of reaches, which is the same question `reached` answers for an index site,
  // asked one step earlier. The guard is because the two call each other and a path can lead
  // back to where it started: `var a = b.x; var b = { x: a };` is a circle, and something has
  // to refuse to go round it twice.
  const resolving = new Set();
  // What a held path reaches, whether it starts at a name or at the openers of the value a
  // pattern was written beside.
  const spelled = (p) => (p.root === null ? `the value beside the pattern` : p.root);
  const throughPath = (p) => {
    const tag = `${p.root === null ? p.from.map((b) => b.at).join("+") : p.root}.${p.path.join(".")}`;
    if (resolving.has(tag)) return [];
    resolving.add(tag);
    try {
      return p.root === null ? reachedFrom(p.from, p.path) : reached(p.root, p.path);
    } finally {
      resolving.delete(tag);
    }
  };
  const bindingsOf = (name) => {
    const out = [];
    for (const held of spread(name, heldFrom)) {
      out.push(...(bound.get(held) || []));
      for (const p of (heldPaths.get(held) || new Map()).values()) out.push(...throughPath(p));
    }
    return out;
  };
  // …and the same reading started from openers rather than from a name, for the value a
  // pattern is written beside: `var { lookup } = table({ lookup: source })` has no name to
  // ask about, and binding its openers under one nothing could spell would have put an
  // invented name into the counts and into every rule that walks `bound`.
  const reachedFrom = (from, path) => reached(null, path, from);
  const reached = (root, path, from) => {
    const hits = [];
    const seen = new Set();
    // A step lands on a literal, on a `dict()`, or on a *name* — and the name is the one
    // that was missing: `table({ status: inner })` says nothing about what `inner` holds, so
    // the path is followed into that binding instead of stopping at a value it cannot read.
    // Codex found it (#9, round 20). The `seen` set is because a name can lead back to
    // itself and the walk has to end.
    const step = (bindings, at) => {
      for (const b of bindings) {
        if (!isLiteral(b.opens)) continue;
        const body = bodyOf(b.opens === "{" ? b.at : b.at + b.opens.length);
        if (!body) continue;
        const k = keysOf(body).get(path[at]);
        if (!k) continue;
        const last = at === path.length - 1;
        if (isLiteral(k.opens)) {
          if (last) hits.push(k);
          else step([k], at + 1);
          continue;
        }
        if (k.opens === "dict()" || k.opens === "") continue;
        if (seen.has(k.opens + "@" + at)) continue;
        seen.add(k.opens + "@" + at);
        const next = bindingsOf(k.opens);
        if (last) hits.push(...next);
        else step(next, at + 1);
      }
    };
    step(from || bindingsOf(root), 0);
    // A reading that started from openers has no name, so there is no path anything could
    // have been assigned onto.
    if (root === null) return hits;
    // …and what a member assignment put there, which is keyed by the whole path so that two
    // properties spelled alike stay apart.
    const full = `${root}.${path.join(".")}`;
    for (const b of members.get(full) || []) if (hasPrototype(b.opens)) hits.push(b);
    // …and a *name* assigned onto the path is followed into its binding, exactly as a name
    // written as a property value is. Reading only the literals meant
    // `outer["lookup"] = inner` reached nothing. Codex found it (#9, round 26).
    for (const held of memberHolds.get(full) || []) {
      for (const b of bindingsOf(held)) if (hasPrototype(b.opens)) hits.push(b);
    }
    // …and a *path* assigned onto it, `outer.lookup = source.inner`, which is the mirror of
    // the line above and of the whole `heldPaths` half.
    for (const p of (memberPaths.get(full) || new Map()).values()) {
      for (const b of throughPath(p)) if (hasPrototype(b.opens)) hits.push(b);
    }
    return hits;
  };

  // What a parenthesised expression is worth, when the thing indexed is that parenthesis.
  // The index side knew one shape — a name in brackets, optionally wrapped — while the value
  // side had a walk that reads every operator; so `((N))[k]`, `(a || N)[k]`,
  // `(f(), N)[k]` and `(flag ? N : d)[k]` were all invisible here and all understood there.
  // app.js:5640 writes one of them, `(archive ? full.count : byQuery.count)[k]`, and the
  // gate could not read it: what it reaches is a `dict()`, so the silence was luck rather
  // than an answer. It asks the walk now, which is the mechanism that already exists rather
  // than a fourth place to teach the same parenthesis — and the gap the comment above
  // `GROUPED` admitted, nested parentheses, closes with it.
  // A transparent call's parenthesis is one of these too: `Object.freeze(unsafe)[k]` holds
  // what `unsafe` holds, and the walk answers that the moment it is let in. The fourth place
  // the transparency is needed, and the one round 36 left — it taught the *literal* form,
  // `Object.freeze({ … })[k]`, in the rule below.
  const grouped = [];
  for (const m of [...code.matchAll(new RegExp(`(?:${GROUPED}|${THROUGH}\\s*)`, "gu"))].filter(inCode)) {
    const { holds, at } = readInitialiser(m.index + m[0].length, true, !!throughAt(m[0]));
    if (!holds.length || code[at] !== ")") continue;
    const tail = new RegExp(`((?:${STEPS})*)${INDEX}`, "yu");
    tail.lastIndex = at + 1;
    const after = tail.exec(code);
    if (!after || constantKey(tail.lastIndex - 1)) continue;
    grouped.push({ holds, steps: segmentsOf(after[1]) });
  }
  const indexedGroup = new Set(grouped.filter((g) => !g.steps.length).flatMap((g) => g.holds));

  // Both floors below count what was *built*. This counts what was *read*: how many of the
  // file's variable-keyed index sites have a root this analysis can resolve to a binding at
  // all. An unresolvable root yields nothing, so silence and safety look the same from
  // outside — and a refactor that moved the tables behind factories would take the reach to
  // zero while leaving both other floors satisfied and the success line green.
  const INDEXED = new RegExp(`${rooted(`(${ID})`)}${INDEX}`, "gu");
  const sites = [...code.matchAll(INDEXED)].filter(computed);
  const resolved = sites.filter((m) => bindingsOf(m[1] !== undefined ? m[1] : m[2]).length).length;

  // `name[k]` — the binding itself, read with a key that is not a literal.
  for (const [name, bindings] of bound) {
    if (!bindings.some((b) => hasPrototype(b.opens))) continue;
    const by = [...spread(name, holders)].find(indexedByAVariable);
    if (!by) continue;
    for (const b of bindings) {
      if (!hasPrototype(b.opens)) continue;
      const built = b.opens === "{" ? "without table()" : `with ${b.opens.replace(/\s+/g, "")}…) and not passed through table()`;
      const how = by === name ? "is indexed by a variable somewhere" : `is indexed by a variable somewhere as \`${by}\``;
      // Names here are file-wide: there are no scopes, so every binding of a name answers
      // for every index of it. app.js binds fourteen names more than once — `headers`
      // thirteen times, in five different functions — and one unrelated `headers[k]` would
      // report all thirteen. Telling them apart needs scope resolution, which is a parser's
      // job and not this file's; saying so turns a future wall of mystery reports into an
      // explained one, which is the part that can be done without one.
      const shared = bindings.length > 1 ? `, one of ${bindings.length} bindings of that name, which this cannot tell apart` : "";
      note("bare-table", b.at, name, `${name} ${how} but built ${built}${shared}`);
    }
  }
  // `name[k]` where the name holds a *path* — `var lookup = source.inner; lookup[k]`. The
  // rule above walks out from a binding to the names holding it, and a path is not one of
  // those edges: it is a reading of something inside a binding, not another name for it. So
  // this asks the other way round, from the name that was written down to what its path
  // reaches. `source.inner[k]` written in one go is the rule below; this is the same read
  // with a name in the middle of it.
  // What the path reaches is asked before who indexes the name, because the second question
  // is a scan of the file and the first is a walk of a literal: most paths reach nothing, and
  // the rule above has read them in that order since it was written.
  for (const [name, paths] of heldPaths) {
    const hits = [];
    for (const p of paths.values()) {
      for (const k of throughPath(p)) if (hasPrototype(k.opens)) hits.push({ k, held: `${spelled(p)}.${p.path.join(".")}` });
    }
    if (!hits.length) continue;
    const by = [...spread(name, holders)].find(indexedByAVariable);
    if (!by) continue;
    const how = by === name ? "is indexed by a variable somewhere" : `is indexed by a variable somewhere as \`${by}\``;
    for (const { k, held } of hits) {
      note("bare-table", k.at, name, `${name} ${how} and holds ${held}, which is an object with a prototype`);
    }
  }
  // …and a rest element, which is the one part of a pattern that needs no path at all:
  // `var { ...rest } = source` builds a *new* object with `Object.prototype`, whatever
  // `source` was, so it is a hazard by construction. Spreading a `dict()` makes an ordinary
  // object too, which is why this asks nothing about what it came from.
  for (const r of restBinds) {
    const by = [...spread(r.name, holders)].find(indexedByAVariable);
    if (!by) continue;
    const how = by === r.name ? "is indexed by a variable somewhere" : `is indexed by a variable somewhere as \`${by}\``;
    note("bare-table", r.at, r.name, `${r.name} ${how} but is a rest element, which is a new object with a prototype`);
  }
  // `root.a.b[k]` — the value at the end of the path, not the root at the start of it.
  // `t.status[k]` and `t["status"][k]` are the same read, so a constant bracket segment is
  // a path segment like any other. Only a *constant* one: `t[name][k]` is a key this cannot
  // know, and it is the same boundary as a root bound to a call.
  // Each step starts with its own punctuation — `.`, `?.` or `[`. Writing the dot as
  // optional let a step match a bare name, and `(?:…)+` over that is the textbook
  // catastrophic backtrack: the gate stopped finishing at all rather than answering wrong,
  // which `check-checks` would have called a killed gate rather than a failing one.
  const PATH = new RegExp(
    `${rooted(`(${ID})`)}((?:${STEPS})+)${INDEX}`,
    "gu"
  );
  const reads = [...code.matchAll(PATH)].filter(computed)
    .map((m) => ({ roots: [m[1] !== undefined ? m[1] : m[2]], path: segmentsOf(m[3]) }))
    // …and a path read off a parenthesised expression, `(a || t).s[k]`, whose roots the walk
    // has already worked out. The same rule, one shape wider.
    .concat(grouped.filter((g) => g.steps.length).map((g) => ({ roots: g.holds, path: g.steps })));
  for (const { roots, path } of reads) {
    for (const root of roots) {
      const subject = `${root}.${path.join(".")}`;
      for (const k of reached(root, path)) {
        if (hasPrototype(k.opens)) note("bare-table", k.at, subject, `${subject} reaches an object with a prototype`);
      }
    }
  }
  // And a literal indexed on the spot, `{ a: "all", … }[k]`, which has no name at all —
  // when the brace closes a literal. A block ends with the same character, and
  // `if (true) { run(); } [value].forEach(run)` is then an array literal rather than an
  // index, which the lexer has known all along.
  for (const m of [...code.matchAll(/\}\s*\[/g)].filter(computed)) {
    if (closes.get(m.index) !== "literal") continue;
    note("bare-table", m.index, "(anonymous)", ON_THE_SPOT);
  }
  // …and the same literal with grouping parentheses around it, `({ … })[k]`, which the
  // adjacency above cannot see. Codex found it (#9, round 22). Walked forward from a
  // grouping `(` that opens a literal rather than matched, because the literal in between
  // is whatever it is: `f({ … })[k]` is excluded by the lookbehind, since there the
  // parenthesis belongs to the call and what is indexed is the call's answer.
  for (const m of [...code.matchAll(new RegExp(`(?:${GROUPED}|${THROUGH}\\s*)(?=\\{)`, "gu"))].filter(inCode)) {
    const body = bodyOf(m.index + m[0].length);
    if (!body) continue;
    let i = skip(body.at + body.text.length + 1);
    // The literal may be the first of several arguments — `Object.defineProperty({ … }, "x",
    // d)[k]` — and what follows it is not what is indexed. Only for a transparent call: in
    // grouping parentheses that comma is the sequence operator, and `({ … }, x)[k]` indexes
    // `x`.
    if (code[i] === "," && throughAt(m[0])) i = restOfCall(i);
    if (code[i] !== ")") continue;
    i++;
    // `INDEX` itself, rather than a hand-spelling of it that would not learn the next shape
    // it grows — it grew `?.` once already.
    const end = indexAt(i);
    if (end < 0 || constantKey(end - 1)) continue;
    note("bare-table", m.index, "(anonymous)", ON_THE_SPOT);
  }

  const wrapped = [...bound.values()].flat().filter((b) => b.opens === "table(").length;
  const dicts = [...code.matchAll(/\bdict\(\)/g)].filter(inCode).length;
  return { notes, wrapped, dicts, resolved, reads: sites.length, code, mask };
}

// The matcher against text written for it, before it is turned on the file. Each line is
// a spelling and its answer; the ones that must be reported are named in `REPORTED`, and
// every other line is here because it must *not* be. Twenty rounds of review found
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
  'var G1 = { a: 1 }; var G2 = G1; G2[k];', //                           indexed under another name
  'var G3 = { b: { a: 1 } }; var G4 = G3; G4.b[k];', //                  …and a path from the alias
  'var G7 = { a: 1 }; var G8; G8 = G7; G8[k];', //                       an alias with no keyword either
  'var T1 = { now: 1 }; var s3 = `${T1[k]}`;', //                        code inside a template
  'var T3 = { c: 1 }; var s5 = `a${ `b${T3[k]}` }c`;', //                …and inside a nested one
  'var T2 = table({ a: 1 }); var s4 = `x${T2[k]}y`;', //                 safe — wrapped, in a template
  'var B1 = table({ s: { a: 1 } }); B1["s"][k];', //                     a constant bracket segment
  'var B2 = { valueOf: function () { return 1; } } / (B3 = { now: 1 }, B3[k]) / 2;', // division, not a regex
  'function f11(k) { var n = 1, P1; return n++ / (P1 = { now: 1 }, P1[k]) / 2; }', // after a postfix update
  'var C1 = table({ "a-b": { x: 1 } }); C1["a-b"][k];', //               a key no identifier could spell
  'var C3 = table({ "a\\"b": { x: 1 } }); C3["a\\"b"][k];', //             …and one with an escape in it
  'var D1; var d1 = function () {} / (D1 = { now: 1 }, D1[k]) / 2;', //  after a function expression
  'var E1 = { now: 1 }; (E1)[k];', //                                    grouping parens before the index
  'var E2 = { s: { a: 1 } }; (E2).s[k];', //                             …and around a path's root
  'var H1 = { now: 1 }; H1?.[k];', //                                    an optional computed index
  'var H2 = { s: { a: 1 } }; H2?.s[k];', //                              …and an optional step in a path
  'var K1 = ({ now: 1 }); K1[k];', //                                    parens around the initializer
  'var K2 = ((table({ a: 1 }))); K2[k];', //                             safe — still wrapped through them
  'var K3 = ident({ a: 1 }); K3[k];', //                                 safe — an argument, not a binding
  'var L1 = flag ? { now: 1 } : { next: 2 }; L1[k];', //                 either branch of a conditional
  'var L2 = other || { a: 1 }; L2[k];', //                               …or the right of a fallback
  'var L3 = [{ a: 1 }]; L3[k];', //                                      safe — an element, not the binding
  'var L4 = function (a) { return a; }; L4[k];', //                      safe — a body, not a map
  'var get = 1, M1; var m1 = get / (M1 = { now: 1 }, M1[k]) / 2;', //     a contextual keyword as a name
  'var O1 = (sideEffect(), { now: 1 }); O1[k];', //                      a comma inside grouping parens
  'var O2 = (a, b); O2[k];', //                                          safe — no literal in it at all
  'var Q0 = { now: 1 }; var Q1 = table({ s: Q0 }); Q1.s[k];', //         a property whose value is a name
  'var Q2 = dict(); var Q3 = table({ s: Q2 }); Q3.s[k];', //             safe — that name holds a dict
  'function rl(x) { switch (x) { case 1: /{}/.test(""); } }', //         safe — a regex after a label
  'var R0 = { yield: 1 }, R1; var r0 = R0.yield / (R1 = { now: 1 }, R1[k]) / 2;', // a keyword as a property
  'function rp(k, R2 = { now: 1 }) { return R2[k]; }', //                a literal in a default parameter
  'function rq(a) { return a; } var R3 = { x: 1 }; R3.x;', //            safe — an ordinary body still is one
  'var U0 = dict(); U0.tbl = { now: 1 }; U0.tbl[k];', //                 a table assigned onto a property
  'var U1 = dict(); U1.tbl = { now: 1 }; var U2 = table({ tbl: dict() }); U2.tbl[k];', // safe — a namesake, indexed elsewhere
  'var U3 = dict(); U3["tbl"] = { now: 1 }; U3["tbl"][k];', //            …and the same path spelled with brackets
  'var V0 = { now: 1 }; var V1 = dict(); V1.tbl = V0; V1.tbl[k];', //     a *name* assigned onto a property
  'var V2 = { now: 1 }; var V3 = dict(); V3.tbl = V2; var V4 = table({ tbl: dict() }); V4.tbl[k];', // safe — a namesake again, this time an alias
  'var V5 = { now: 1 }; var V6 = dict(); V6["tbl"] = V5; V6["tbl"][k];', // …and a name onto a bracket-spelled path
  'var V7 = dict(); ident(V7).tbl = { now: 1 }; var V8 = table({ tbl: dict() }); V8.tbl[k];', // safe — a receiver no name can resolve
  'var W0 = { now: 1 }; var W1 = (W0); W1[k];', //                       an alias inside grouping parentheses
  'var W2 = { now: 1 }; var W3 = flag ? W2 : dict(); W3[k];', //         …and one that is a branch of a conditional
  'var W4 = { now: 1 }; var W5 = other || W4; W5[k];', //                …and the right of a fallback
  'var W6 = { now: 1 }; var W7 = (sideEffect(), W6); W7[k];', //         …and the last of a sequence
  'var W8 = { now: 1 }; var W9 = ident(W8); W9[k];', //                  safe — a call’s answer, not the name
  'var WA = { now: 1 }; var WB = WA.inner; WB[k];', //                   safe — that property is not in it
  'var WC = { now: 1 }; var WD = n + WC; WD[k];', //                     safe — an operand, not the value
  'var WE = { now: 1 }; var WF = WE[0]; WF[k];', //                     safe — that element is not in it
  'var WG = { now: 1 }; var WH = n + (m || WG); WH[k];', //             safe — an operand still, inside parentheses
  'var WI = { now: 1 }; var WJ = (WI.inner); WJ[k];', //                safe — and a property still, inside them
  'var WK = { now: 1 }; var WL = WK || dict(); WL[k];', //              the left of a fallback, which an object wins
  'var WM = { now: 1 }; var WN = WM && dict(); WN[k];', //              safe — the left of an `&&`, which it never does
  'function wb() { if (true) { wb(); } [k].forEach(wb); }', //          safe — a block’s brace, then an array
  'var WO = { now: 1 }; var WP = (WO || dict()).slice; WP[k];', //      safe — a call on the parenthesis, not the name
  'var WQ = { now: 1 }; var WR = WQ ?? dict(); WR[k];', //              the left of a nullish fallback, which an object also wins
  'var WT; WT ||= { now: 1 }; WT[k];', //                               a literal put there by a logical assignment
  'var WU = { now: 1 }; var WV; WV ??= WU; WV[k];', //                  …and a name put there by one
  'var WW = { now: 1 }; var WX = 0; WX += WW; WX[k];', //               safe — a sum is not the thing added to it
  'var XA = { now: 1 }; var XB, XC; XC = XB = XA; XC[k];', //           a chain of assignments, worth its right-hand side
  'var XD = { now: 1 }; var XE = (n != XD); XE[k];', //                 safe — the `=` of a comparison is not one
  'var XF = { now: 1 }; var XG = function () { return XF; }; XG[k];', // safe — a function, not what it returns
  'var XH; (XH) = { now: 1 }; XH[k];', //                               a target inside grouping parentheses
  'var XI = dict(); (XI).tbl = { now: 1 }; XI.tbl[k];', //              …around the root of a path
  'var XJ = dict(); (XJ.tbl) = { now: 1 }; XJ.tbl[k];', //              …and around the whole of one
  'var XN = dict(); XN[i].tbl = { now: 1 }; var XO = table({ tbl: dict() }); XO.tbl[k];', // safe — a computed receiver resolves to nothing
  'var tbl = dict(); tbl[k];', //                                       safe — and a real variable of that name, which none of those is
  'function xt(x, k, flag) { switch (x) { case flag ? 1 : { now: 1 }[k]: break; } }', // a literal behind a case expression’s ternary
  'var café = { now: 1 }; café[k];', //                               a name JavaScript allows and ASCII does not
  'var ÖVER = { now: 1 }; ÖVER[k];', //                               …and one that starts with such a letter
  'var ÖH = { now: 1 }; var YG = ÖH; YG[k];', //                     …and one held under an ASCII alias
  'var naïve = table({ tabelle: { a: 1 } }); naïve.tabelle[k];', //     …and the same alphabet in a path
  'var YA = { now: 1 }; YA[1e3];', //                                  safe — an exponent is a constant key
  'var YB = { now: 1 }; YB[0x10];', //                                 safe — so is hexadecimal
  'var YC = { now: 1 }; YC[-1];', //                                   safe — and a negative one
  'var YD = { now: 1 }; YD[1_000];', //                                safe — and one with separators
  'var YE = { now: 1 }; YE[1 - n];', //                                a computed key that merely starts with a digit
  'var ZA = table({ a: { z: 1 }, b: { z: 1 } }); ZA.b[k];', //          a key after a nested literal, which depth lost
  'var ZB = table({ a: { z: { q: 1 } } }); ZB.z[k];', //                safe — a nested key is not the parent’s
  'var $ZC = { now: 1 }; $ZC[k];', //                                   a name spliced into a pattern, where `$` anchors
  'var ZD$ = { now: 1 }; ZD$[k];', //                                   …and at the end of one, where it also does
  'var ZE = table(parsedZE); var ZF = { q: { deep: 1 } }; ZE.q[k];', // safe — a wrapped name opens no literal here
  'var ZG = { r: 1 }; var ZH = table({ ZG: dict() }); ZH.ZG[k];', //     safe — a property is not the variable it is spelled like
  'var ZI = { now: 1 }; ZI = { later: 2 }; ZI[k];', //                  a name bound twice, which this cannot tell apart
  'var ZJ = { now: 1 }; ((ZJ))[k];', //                                 a name indexed through nested parentheses
  'var ZK = { now: 1 }; (other || ZK)[k];', //                          …and through a fallback
  'var ZL = { now: 1 }; (sideEffect(), ZL)[k];', //                     …and through a sequence
  'var ZM = { now: 1 }; (flag ? ZM : dict())[k];', //                   …and through a conditional
  'var ZN = table({ s: { a: 1 } }); (flag ? ZN : dict()).s[k];', //     …and a path read off one
  'var ZO = dict(); (flag ? ZO : dict())[k];', //                       safe — every branch is a dict
  'var ZP = { now: 1 }; ident(ZP)[k];', //                              safe — a call’s answer, not the name in it
  'var ZQ = { now: 1 }; var ZR = table({ ZQ }); ZR.ZQ[k];', //           a shorthand property, which is its own value
  'var ZS = { now: 1 }; var ZT = { a: 1, ZS }; ZT.ZS[k];', //            …beside a key that is spelled out
  'var ZU = dict(); var ZV = table({ ZU }); ZV.ZU[k];', //               safe — a shorthand holding a dict
  'var ZW = table({ m() {} }); ZW.m[k];', //                            safe — a method is not a shorthand property
  'var AA = Object.freeze({ now: 1 }); AA[k];', //                      a literal handed back by the call that froze it
  'var AB = Object.seal({ now: 1 }); AB[k];', //                        …and by the one that sealed it
  'var AC = Object.preventExtensions({ now: 1 }); AC[k];', //           …and by the third of them
  'var AD = Object.freeze(dict()); AD[k];', //                          safe — freezing a dict leaves a dict
  'var AE = table({ s: Object.freeze({ a: 1 }) }); AE.s[k];', //        …and one frozen inside a property
  'Object.freeze({ now: 1 })[k];', //                                   …and one frozen and indexed on the spot
  'var S1 = { now: 1 }; S1["" + k];', //                                 a computed key that starts as a string
  'var S2 = { now: 1 }; S2["now"];', //                                  safe — a sole string is a constant key
  'var S3 = { now: 1 }; S3[0];', //                                      safe — so is a sole number
  '({ now: 1 })[k];', //                                                 an inline literal inside parens
  'ident({ now: 1 })[k];', //                                            safe — the call's answer, not the literal
  'async function rw() { await /{}/.test(""); }', //                     safe — a regex after a keyword
  'var E3 = { a: 1 }; outer: {} E3.a;', //                               safe — so is a labelled block
  'var J1; var j1 = async function () {} / (J1 = { now: 1 }, J1[k]) / 2;', // async before the keyword
  'async function jd() {} var J2 = { a: 1 }; J2.a;', //                  safe — still a declaration
  'var D2 = { m: function () {} }; D2.m;', //                            safe — an empty body, not a map
  'function pA() { try { pA(); } catch {} }', //                         safe — an empty block, not a map
  'class Empty {}', //                                                   safe — so is a class body
  'var B4 = table({ s: { a: 1 } }); B4["s"]["a"];', //                   safe — every key is a literal
  'function rt() { if (true) /{}/.test(""); }', //                       safe — a regex, not division
  'var G5 = table({ a: 1 }); var G6 = G5; G6[k];', //                    safe — the alias holds a table
  'var m = table({ n: dict() }); m.n[k];', //                            safe — the value is a dict
  'var o = table({ p: 1 }); o[k];', //                                   safe — the table is wrapped
  'var q = { r: 1 }; q["r"];', //                                        safe — a literal key
  'var s2 = { t: 1 }; s2.t;', //                                         safe — not indexed at all
  'var c2 = { d2: 1 }; // c2[k] here is a comment, not code', //         safe — a comment
  'var e2 = { f2: 1 }; var g2 = "e2[k] here is a string";', //           safe — a string
  'var AF = Object.defineProperty({ a: 1 }, "x", { value: 1 }); AF[k];', // a call that hands back its first argument
  'var AG = Object.defineProperties({ a: 1 }, { x: { value: 1 } }); AG[k];', // …and its plural
  'var AH = Object.defineProperty(dict(), "x", { value: 1 }); AH[k];', // safe — the descriptor is not the value
  'var AI = Object.assign(dict(), src); AI[k];', //                      safe — assign hands back its target, a dict
  'var AJ = { a: 1 }; var AK = Object.assign(AJ, src); AK[k];', //       …and when the target is a name, the name
  'var AL = { a: 1 }; var AM = Object.freeze(AL); AM[k];', //            an alias through a wrapper is an alias
  'var AN = { a: 1 }; var AO = n + Object.freeze(AN); AO[k];', //        safe — an operand, wrapper and all
  'Object.defineProperty({ a: 1 }, "x", { value: 1 })[k];', //           indexed on the spot, arguments after it
  'var AP = { a: 1 }; Object.freeze(AP)[k];', //                         …and a name indexed on the spot through one
  'var AQ = dict(); Object.freeze(AQ)[k];', //                           safe — that name holds a dict
  'var AR = table({ s: Object.freeze({ a: 1 }), t: { b: 2 } }); AR.t[k];', // a key after a wrapped one is still a key
  'var AS = table({ s: Object.defineProperty({ a: 1 }, "x", { value: 1 }) }); AS.s[k];', // …and a value read through one
  'var AT = table({ s: Object.defineProperty(dict(), "value", { value: { a: 1 } }) }); AT.s[k]; AT.value[k];', // safe — a descriptor's keys are not the literal's
  'var AU = myObject.freeze({ a: 1 }); AU[k];', //                       safe — somebody else's freeze answers what it likes
  'var AV = { now: 1 }; var AW = table({ ["lookup"]: AV }); AW.lookup[k];', // a computed constant key
  'var AX = { now: 1 }; var AY = table({ [\'lookup\']: AX }); AY.lookup[k];', // …however it is quoted
  'var AZ = table({ ["a-b"]: { now: 1 } }); AZ["a-b"][k];', //           …and one no identifier could spell
  'var BA = table({ ["s"]: dict() }); BA.s[k];', //                      safe — a computed key holding a dict
  'var BB = table({ [nameBB]: { now: 1 } }); BB.x[k];', //               safe — a key this cannot know reaches nothing
  'var BC = [{ a: 1 }][0]; BC[k];', //                                   an element selected out of an array
  'var BD = [{ a: 1 }][i]; BD[k];', //                                   …however the element is chosen
  'var BE = [dict()][0]; BE[k];', //                                     safe — that element is a dict
  'var BF = { a: 1 }; var BG = [BF][0]; BG[k];', //                      …and a name selected out of one
  'var BH = [{ a: 1 }].slice(); BH[k];', //                              safe — a call's answer, not an element
  'var BI = [dict(), { a: 1 }][0]; BI[k];', //                           one element of two, either of which it may be
  'var BP = { a: 1 }; var BQ = [BP, dict()][0]; BQ[k];', //              …and the element before a comma is one too
  'var BR = { inner: { now: 1 } }; var BS = BR.inner; BS[k];', //        a property path on the right
  'var BT = { inner: dict() }; var BU = BT.inner; BU[k];', //            safe — that property is a dict
  'var BV = table({ inner: { now: 1 } }); var BW = BV["inner"]; BW[k];', // …however the path is spelled
  'var BX = { inner: { now: 1 } }; var BY = BX.inner(); BY[k];', //      safe — a call's answer, not the property
  'var BZ = { inner: { now: 1 } }; var CA = n + BZ.inner; CA[k];', //    safe — an operand, not the property
  'var CB = { inner: { now: 1 } }; var CC = (flag ? CB.inner : dict()); CC[k];', // …and a path in a branch is a branch
  'var CD = { now: 1 }; var { lookup: CE } = table({ lookup: CD }); CE[k];', // a name a pattern binds
  'var CF = { inner: { now: 1 } }; var { inner: CG } = CF; CG[k];', //   …out of a name
  'var CH = { inner: { now: 1 } }; var { inner } = CH; inner[k];', //    …written as a shorthand
  'var CI = { a: { b: { now: 1 } } }; var { a: { b: CJ } } = CI; CJ[k];', // …and a pattern inside a pattern
  'var CK = { inner: dict() }; var { inner: CL } = CK; CL[k];', //       safe — that name holds a dict
  'var CM = { inner: { now: 1 } }; var { ["inner"]: CN } = CM; CN[k];', // a computed key binds too
  'var CO = { inner: { now: 1 } }; var { "inner": CP } = CO; CP[k];', // …and a quoted one
  'var { CQ = { now: 1 } } = src; CQ[k];', //                            a default value is a value
  'var { CR = dict() } = src; CR[k];', //                                safe — …and a dict default is a dict
  'var CS = dict(); var { ...CT } = CS; CT[k];', //                      a rest element is a new ordinary object
  'var CU = { inner: { now: 1 } }; ({ inner: CV } = CU); CV[k];', //     a pattern without a keyword binds
  'var [CW] = [{ now: 1 }]; CW[k];', //                                  an array pattern takes an element
  'var [CX] = [dict()]; CX[k];', //                                      safe — …and that element is a dict
  'var CY = { inner: { now: 1 } }; var { missing: CZ } = CY; CZ[k];', // safe — a key that is not there reaches nothing
  'function fd({ DA }) { return DA[k]; }', //                            safe — a parameter is nobody's path
  'var DB = { inner: { now: 1 } }; var { inner: DC } = DB; var DD = DC; DD[k];', // …and the alias of a bound name
  'var DE = { a: { inner: { now: 1 } } }; var { inner: DF } = DE.a; DF[k];', // …out of a path
  'var DG = { inner: { now: 1 } }; var DH = dict(); DH.lookup = DG.inner; DH.lookup[k];', // a path assigned onto a path
  'var DI = { x: DJ }; var DJ = DI.x; DJ[k];', //                        safe — a circle, which must end rather than answer
  'var DK = table({ 0: { now: 1 } }); DK[0][k];', //                     a numeric key, reached by a numeric step
  'var DL = table({ 0: dict() }); DL[0][k];', //                         safe — that element is a dict
  'var DM = table({ 16: { now: 1 } }); DM[0x10][k];', //                 …and the key a number denotes, not its spelling
  'var DN = table({ "0": { now: 1 } }); DN[0][k];', //                   …which a quoted one denotes too
  'var DO = table({ [0]: { now: 1 } }); DO[0][k];', //                   …and a computed one
  'var DP = table({ Infinity: { now: 1 } }); DP[1e999][k];', //          …as far as the conversion goes
  'var DQ = { a: { 0: { now: 1 } } }; var DR = DQ.a[0]; DR[k];', //      a numeric step on the value side
  'var DS = { 0: { now: 1 } }; var { 0: DT } = DS; DT[k];', //           …and a numeric key in a pattern
  'var DU = table({ 0: { now: 1 } }); DU[n][k];', //                     safe — a step that is not constant reaches nothing
  'var DV = table({ 0.5: { now: 1 } }); DV[.5][k];', //                  …and a fraction is a key as much as an integer
  'var BL = { a: 1 }; BL[.5];', //                                       safe — a number may begin with its point
  'var BM = { a: 1 }; BM[-.5];', //                                      safe — …and with a sign in front of that
  'var BN = { a: 1 }; BN[.5e3];', //                                     safe — …and carry on as any number does
  'var BO = { a: 1 }; BO[.5 + n];', //                                   a sum that starts with one is not a constant
].join("\n");
const REPORTED = ["A", "bee", "cee", "e", "f.g", "h.i.j", "u.bad", "v.w", "y.z", "F1", "F2", "F3", "G1", "G4.b", "G7", "T1", "T3", "B1.s", "B3", "P1", "C1.a-b", 'C3.a"b', "D1", "E1", "E2.s", "H1", "H2.s", "J1", "K1", "L1", "L2", "M1", "O1", "Q1.s", "R1", "R2", "S1", "U0.tbl", "U3.tbl", "V1.tbl", "V6.tbl", "W0", "W2", "W4", "W6", "WK", "WQ", "WT", "WU", "XA", "XH", "XI.tbl", "XJ.tbl", "caf\u00e9", "\u00d6VER", "\u00d6H", "na\u00efve.tabelle", "YE", "ZA.b", "$ZC", "ZD$", "ZI", "ZJ", "ZK", "ZL", "ZM", "ZN.s", "ZR.ZQ", "ZT.ZS", "AA", "AB", "AC", "AE.s", "AF", "AG", "AJ", "AL", "AP", "AR.t", "AS.s", "AW.lookup", "AY.lookup", "AZ.a-b", "BC", "BD", "BF", "BI", "BP", "BO", "BS", "BW", "CC", "CE", "CG", "inner", "CJ", "CN", "CP", "CQ", "CT", "CV", "CW", "DC", "DF", "DH.lookup", "DK.0", "DM.16", "DN.0", "DO.0", "DP.Infinity", "DR", "DT", "DV.0.5", "(anonymous)"];
// The empty-literal rule gets its own two lines, because what they assert is a `bare` note
// rather than a `bare-table` one, and the list above is about subjects. `case { a: {} }.a:`
// is the shape that made a case label swallow a property colon — the nested literal was then
// read as a block and the ban on empty object literals quietly did not apply inside it.
const EMPTY_FIXTURE = [
  'function ms(x) { switch (x) { case { a: {} }.a: break; } }', // 1 — inside a case expression
  'function mt(x) { switch (x) { case 1: {} default: {} } }', //  ·   case arms are blocks
  'function rd({}) {}', //                                        ·   an empty binding pattern
  'function rc() { try { rd(); } catch ({}) {} }', //             ·   …and a catch's pattern
  'var { t1 } = { t1: 1 };', //                                   ·   a declaration's pattern
  'ident({});', //                                                6 — an argument really is a literal
  'function rt2(a = {}) { return a; }', //                        7 — and so is a default value
  '({} = src);', //                                               ·   a destructuring assignment
  '({ a: {} } = src);', //                                        ·   …and one nested inside a pattern
  '[{}] = arr;', //                                               ·   …and one inside an array pattern
  'var ar = ({}) => 1;', //                                       ·   an arrow's parameter
  'var na = (a, {}) => a;', //                                    ·   …and one beside a named parameter
  'class Me { m({}) {} }', //                                     ·   a method's parameter
  'var sh = { m({}) {} };', //                                    ·   …and a shorthand method's
  'if ({}) { ar(); }', //                                        15 — a condition is not a parameter list
  'for ({} of rows) { ident(); }', //                             ·   a for-of target
  'for ({} in src) { ident(); }', //                              ·   …and a for-in one
  'for ([{}] of rows) { ident(); }', //                           ·   …and one inside an array pattern
  'for (var {} of rows) { ident(); }', //                         ·   …and one the keyword already answered
  'async function fa() { for await ({} of rows) { ident(); } }', // ·  …and one in an await head
  'async function fw() { for await (const x of y) /{}/.test(x); }', // · a regex in that head's body
  'function np({ value: {} }) {}', //                             ·   a pattern inside a pattern
  'function nq([{}]) {}', //                                      ·   …and one inside an array pattern
  'function nr({ a: [{}] }) {}', //                               ·   …and one inside both
  'var ns = ({ a: {} }) => 1;', //                                ·   …and one in an arrow's
  'function nt({ a: { b: {} } }) {}', //                          ·   …three levels down
  'function nu({ a = {} }) {}', //                               27 — a default value in a pattern is a value
  'function nv(a = [1, {}]) {}', //                              28 — …and so is one in an array
  'function nw(a = b ? c : {}) {}', //                           29 — …and one after a colon that binds nothing
  'function nx(x) { switch ({}) { case 1: break; } }', //        30 — a switch head is not a parameter list
  'function ny(a = 1, { b: {} }) {}', //                          ·   the comma that ends a default
  'function nz(a = { x: `${y}`, z: {} }) {}', //                 32 — a substitution is a value too
].join("\n");
const empties = survey(EMPTY_FIXTURE).notes;
const bares = empties.filter((n) => n.check === "bare").map((n) => n.line);
if (bares.join(",") !== "1,6,7,15,27,28,29,30,32") {
  fail("fixture", `the empty-literal rule reports on line(s) ${bares.join(", ") || "none"} of its fixture, where it should report on 1, 6, 7, 15, 27, 28, 29, 30 and 32`);
}
for (const n of empties.filter((n) => n.check !== "bare")) {
  fail("fixture", `the empty-literal fixture also produced ${n.check} on line ${n.line}: ${n.what}`);
}

const fixture = survey(FIXTURE);
// Distinct subjects, not distinct sites: a conditional binds the same name twice and both
// branches are reported, each at its own line, which is right and is not two findings for
// this list to care about.
const got = [...new Set(fixture.notes.filter((n) => n.check === "bare-table").map((n) => n.subject))].sort();
if (got.join(" ") !== REPORTED.slice().sort().join(" ")) {
  fail("fixture", `the matcher reports ${got.join(", ") || "nothing"} where it should report ${REPORTED.join(", ")}`);
}
// The list above is of *subjects*, and the anonymous rule's subject never varies, so a
// second report from it — a block's brace read as a literal's, say — would not show there at
// all. Its sites are counted instead. Codex's round-28 false positive was invisible to the
// fixture until this line existed, which makes it the same defect as the gate it guards.
// …and the same for what a note *says* rather than which subject it names: a name bound
// more than once has to carry that, or the day it reports thirteen sites nobody will know
// why.
const twice = fixture.notes.find((n) => n.subject === "ZI");
if (!twice || !/bindings of that name/.test(twice.what)) {
  fail("fixture", "the matcher does not say that ZI is one of several bindings of its name");
}
const anonymous = fixture.notes.filter((n) => n.subject === "(anonymous)").length;
if (anonymous !== 4) {
  fail("fixture", `the matcher reports ${anonymous} literal(s) indexed on the spot in its fixture, where it should report 4`);
}
for (const n of fixture.notes.filter((n) => n.check !== "bare-table")) {
  fail("fixture", `the matcher reports ${n.check} on line ${n.line} of a fixture that has none: ${n.what}`);
}

// A matcher that fails its own fixture has not earned the right to say anything about
// app.js, and scanning 663 KB to produce findings nobody will read is most of what
// `check-checks` spends its time on: 67 of this gate's claims trip the fixture, and each
// one paid 1.86 s for a survey whose output is discarded. Measured, that is about two
// minutes of the meta-check's CPU.
//
// It also decides which half speaks when a break trips both: the fixture names it and the
// judges below never run. One claim moved from `[lex]` to `[fixture]` for that reason, and
// it is the same defect caught by the earlier of the two checks that can see it.
report();

const { notes, wrapped, dicts, resolved, reads, code, mask } = survey(src);
for (const n of notes) fail(n.check, `app.js:${n.line} — ${n.what}`);

// The judge on the reading above: removing the comments from a file that parses leaves a
// file that parses. A blank cut through a string leaves it unterminated, and a regex read
// as a string swallows the comment after it — both are syntax errors, and neither is
// anything this file would otherwise notice. It is the same shape as the rest of the
// repository's checks: the thing that decides is a parser, not our own reading.
//
// What it does *not* catch is a misclassification that leaves the text valid — a regex
// read as division is exactly that, and Codex demonstrated it rather than arguing it. So
// the fixture carries that line too. A judge with its reach written down beats a judge
// described as though it settled the question.
// Two words above are treated as keywords although a sloppy script may legally use them as
// names, which is the trade round 19 made explicit. This is what pays for it: if app.js ever
// binds one, the reading of every `/` after it is wrong, and the gate says so instead of
// masking whatever follows.
// Every position a name can stand in, which is simply: anywhere but after a `.`. Listing
// the binding forms instead — `var`, `let`, `const`, `function`, `x =` — left the parameter
// position out, where `function f(await) { return await / 2; }` is exactly the hazard this
// is here to catch. And the scan read the whole file rather than its *code*, so the words
// inside a string counted: `var s = "var await = 1"` failed the gate. Both from
// `/code-review`. app.js contains neither word anywhere today, so the strong form costs
// nothing and has no list to keep.
for (const m of [...code.matchAll(new RegExp(`(?<![.\\p{ID_Continue}$])(${CONTEXTUAL.join("|")})(?![\\p{ID_Continue}$])`, "gu"))]) {
  if (mask[m.index]) continue;
  fail("lex", `app.js uses \`${m[1]}\` as a name, and the lexer reads it as a keyword — see RESERVED`);
}

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
if (resolved < 120) fail("coverage", `only ${resolved} of ${reads} variable-keyed reads have a root this resolves — the analysis has lost its reach`);

report();
// What the success line may say is the whole subject of this file's review history: six
// of the seven findings were a check claiming more than it held. So it names what was
// read — a literal, and the handful of platform factories above — rather than the file
// being clean of a thing no scan of text can see. A repo-local `makeThing()` with a
// `return { … }` in it is outside this, and saying so is the difference between a boundary
// and a blind spot.
// The half the fixture says to leave alone, which is where all thirteen red gates on valid
// code lived while the success line counted only the other half. It is counted, not
// asserted: a line that asserts *nothing* — neither listed in `REPORTED` nor marked safe —
// would still pass, because the `safe` markers are comments in this file and the fixture
// the matcher runs on is only the code. Making that checkable means the fixture carrying
// its verdicts as data rather than in a list beside it, which is a bigger change than this
// one and is written down as such.
const safeLines = FIXTURE.split("\n").length - new Set(fixture.notes.map((n) => n.line)).size;
console.log(
  `✓ lookups: the matcher sees all ${REPORTED.length} spellings its fixture says to report and leaves the ` +
    `${safeLines} it says not to, ${resolved} of ${reads} variable-keyed reads in app.js have a root it resolves, ` +
    `app.js still parses with its comments ` +
    `blanked, and in it ${wrapped} tables and ${dicts} maps are built with no prototype, no empty object literal is ` +
    `written at all, and no object literal or Object.fromEntries/JSON.parse/new Object/Object.create({…}) — ` +
    `on its own or handed back by Object.${THROUGH_CALLS.join("/")}, whose first argument is what they answer — ` +
    `that a variable indexes — under its own name, under a name it was assigned to — in parentheses, as a branch ` +
    `of a conditional, as the last of a sequence, as either side of a fallback or as an element selected out ` +
    `of an array literal — under a name read out of one by a property path or by a destructuring — or ` +
    `through a property path, ` +
    `which a name may have been assigned onto — is left ` +
    `with a prototype`
);
