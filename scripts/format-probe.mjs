#!/usr/bin/env node
// What this repo's frontmatter writer produces, and what its reader returns, as JSON
// for check-format.py to judge with a real YAML parser.
//
// Split in two on purpose. The writer's own round trip cannot answer whether a puck
// is valid YAML — it only answers whether *we* read back what we wrote, and those
// are different questions. Every defect this corpus covers was found by asking the
// second one and losing: a bare `@frontend` that our reader accepts and no YAML
// parser does, a `5e-7` that YAML reads as text, a `"true"` that comes back a
// boolean. So the values are generated here, where the encoder lives, and judged
// over there, by something that has never heard of this codebase.
//
// Node builtins only, like the rest of scripts/.
import { encodeItem, encodeScalar, encodeNumber, parseFrontmatter } from "./lib/frontmatter.mjs";

// Strings. Every one of these must come back from a YAML parser as the *same
// string* — the type matters as much as the characters, which is how `true` and
// `123` got through the first time.
const STRINGS = [
  "ui", "infra", "@frontend", "release,one", "release #1", "acme/repo#vfs", "C# tips",
  "#123", "*star", "- dash", "Hello, world", "Hello: world", "foo:", ":lead", " pad ",
  '"q"', "it's", "|pipe", "%pct", "`tick`", "a[b]", "{x}", "true", "True", "FALSE",
  "yes", "no", "on", "off", "null", "~", "y", "n", "123", "-5", "1.5", "10.5", "5e-7",
  "2026-09-18", "2026-9-8", "0x10", "a b c", "a  b", "tag_with_under", "dot.ted",
  "sl/ash", "dash-ed", "ÅÄÖ",
];

// Numbers, which the typed fields (`order`, `issue`) write bare. `move` halves the
// gap between neighbours, so the small ones are reachable, not hypothetical.
const NUMBERS = [10, 20, 0, -5, 10.5, 0.25, 5e-7, 1e21, 1 / 3, -5e-7, 1e-323];

// Dates, which `updated`/`created`/`target` write bare.
const DATES = ["2026-09-18", "2026-12-01"];

// Frontmatter lines, to compare this parser's reading against a real one. Anything
// they disagree about is a puck whose board entry differs from its own file.
const LINES = [
  'title: Alpha, "beta #1"', 'title: "a # b"', "title: C# tips", "title: it's x # n",
  "title: plain", "title: with trailing # note", 'title: "quoted" # note',
  "title: 'single' # note", "title: a,b,c", "title: #123",
  "tags: [a, b]", "tags: [a, b] # note", 'tags: ["b #1", c]', 'tags: ["release,one", x]',
  "tags: []", "tags: [a, acme/r#v]", "tags: ['x''y', z]", "tags: [ spaced , items ]",
  'depends: ["a, b", c]', "order: 10", "order: 10 # note", "updated: 2026-09-18",
];

console.log(JSON.stringify({
  strings: STRINGS.map((v) => ({ value: v, item: encodeItem(v), scalar: encodeScalar(v, false) })),
  numbers: NUMBERS.map((n) => ({ value: n, written: encodeNumber(n) })),
  dates: DATES.map((d) => ({ value: d, written: encodeScalar(d, true) })),
  // One line holding every string at once, because an item that survives alone can
  // still be broken by its neighbour's quoting.
  listLine: "tags: [" + STRINGS.map(encodeItem).join(", ") + "]",
  lines: LINES.map((line) => ({
    line,
    read: Object.values(parseFrontmatter(`---\n${line}\n---\n`).data)[0],
  })),
}, null, 2));
