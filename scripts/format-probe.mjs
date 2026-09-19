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
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { encodeItem, encodeScalar, encodeNumber, parseFrontmatter, setField, removeField, replaceBody } from "./lib/frontmatter.mjs";

// format.js has to be two things at once, and only one of them was ever checked.
//
// Node reads it as an ES module — `package.json` says `type: module`, so `node --check`
// parses it in the module goal, where `export` is perfectly legal. index.html reads the
// same bytes as a *classic* script, where a top-level `export` is a SyntaxError. Add one
// and: `node --check` passes, check-bundle passes, the query and markdown judges pass,
// the board renders byte-identically — and `globalThis.__PUCK_FORMAT__` is undefined, so
// every write throws "format.js did not load". Measured, all five gates green.
//
// That dual nature is the entire argument the file exists on (see its header, and #2).
// It was the one property nothing held it to.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertServedAsClassicScript() {
  const src = fs.readFileSync(path.join(ROOT, "format.js"), "utf8");
  // The real test: does a classic-script parser accept it? `vm.Script` uses the script
  // goal, which is what a browser uses for `<script src>`.
  try {
    new vm.Script(src, { filename: "format.js" });
  } catch (e) {
    throw new Error(
      "format.js no longer parses as a classic script — a browser would refuse it and " +
        "every board write would throw. " + e.message
    );
  }
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const tag = /<script\b[^>]*\bsrc=["']format\.js["'][^>]*>/i.exec(html);
  if (!tag) {
    throw new Error("index.html no longer loads format.js — the board would have no spelling rules");
  }
  if (/\btype\s*=\s*["']module["']/i.test(tag[0])) {
    throw new Error("index.html loads format.js as a module — it does not load at all from file://");
  }
  // The script *tags*, not the first mention of each name: app.js is named in three
  // comments above the tags, so comparing `indexOf` on the filenames said the order was
  // wrong on a file whose order is right. Checking a proxy for the thing is how this
  // check would have failed for a reason that has nothing to do with the property.
  const appTag = /<script\b[^>]*\bsrc=["']app\.js["'][^>]*>/i.exec(html);
  if (!appTag) throw new Error("index.html no longer loads app.js");
  if (tag.index > appTag.index) {
    throw new Error("index.html loads format.js after app.js — the global is read before it is written");
  }
}

assertServedAsClassicScript();

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

// What `setField` writes, field by field. The encoders above answer "how is this value
// spelled"; this answers "which spelling does *this key* get", which is the half that
// was missing from the owner and therefore missing from the board. Every one of these
// was measured wrong before the writer moved here: `parent: release #1` read back as
// `release`, `agent: true` as a boolean, and two of them produced a file PyYAML
// refuses outright — committed, by the board, to somebody else's repo.
//
// `type` is what a YAML parser must hand back, not merely what the characters look
// like. That distinction is the whole point: `owner: 2026-01-01` is a *string* field
// holding something date-shaped, and `order: 10.5` is a number that must not arrive as
// one. A puck with a BOM is here because the board refused to edit one at all.
const BOM = "\uFEFF";
const BASE = "---\ntitle: A puck\nstatus: now\n---\n\nbody\n";
const WRITES = [
  { key: "parent", value: "release #1", type: "str" },
  { key: "parent", value: "a: b", type: "str" },
  { key: "parent", value: "owner/repo#slug", type: "str" },
  { key: "agent", value: "true", type: "str" },
  { key: "agent", value: "yes", type: "str" },
  { key: "owner", value: "no", type: "str" },
  { key: "owner", value: "2026-01-01", type: "str" },
  { key: "owner", value: "123dev", type: "str" },
  { key: "priority", value: "@urgent", type: "str" },
  { key: "title", value: "123", type: "str" },
  { key: "title", value: "", type: "str" },
  { key: "status", value: "next", type: "str" },
  { key: "order", value: 10, type: "num" },
  { key: "order", value: 10.5, type: "num" },
  { key: "order", value: 5e-7, type: "num" },
  { key: "issue", value: 42, type: "num" },
  { key: "target", value: "2026-11-30", type: "date" },
  { key: "updated", value: "2026-09-18", type: "date" },
  { key: "tags", value: ["ui", "release #1", "a, b"], type: "list" },
  { key: "depends", value: ["owner/repo#slug", "a b"], type: "list" },
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
  writes: WRITES.map((w) => ({ ...w, file: setField(BASE, w.key, w.value) })),
  // The same writer over a puck that starts with a BOM, and a removal. Both are things
  // the board's own copy could not do: it returned null on the BOM and refused the edit.
  bom: setField(BOM + BASE, "status", "next"),
  bomRemoved: removeField(BOM + BASE, "status"),
  noFrontmatter: setField("just a body\n", "status", "next"),
  // The body edit, which asks the same fence question and used to answer it alone.
  body: replaceBody(BASE, "a new body"),
  bodyBom: replaceBody(BOM + BASE, "a new body"),
  bodyNoFrontmatter: replaceBody("just a body\n", "x"),
}, null, 2));
