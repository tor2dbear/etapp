#!/usr/bin/env node
// What the board's markdown renderer produces, as JSON for check-markdown.py to
// judge with a real HTML parser.
//
// Two questions, and only the second one matters for safety:
//
//   1. Does the documented subset render? CONVENTION names it exactly — `##`–`####`
//      headings, bold, italic, code, fences, nested lists, links, blockquotes, GFM
//      tables — and promises that anything *outside* it "is shown as you typed it,
//      on its own line", never folded into the paragraph around it. That promise is
//      the reason the fixture exists; CONVENTION has named `tests/markdown.fixture.md`
//      as the text that holds the renderer to it since before the file existed.
//   2. Can a body turn into markup the renderer did not write? Puck bodies come from
//      *other people's* repos and GitHub issue bodies from anyone who can comment,
//      and both land in `innerHTML` on the origin that holds the GitHub token. The
//      renderer's whole safety property is that it escapes first and then emits a
//      fixed whitelist of tags — so the judge checks the output with a parser that
//      has never heard of this codebase, the way check-format.py uses PyYAML.
//
// The renderer is not imported, because it does not live in a module: it is a fenced
// region of app.js, which is a classic script the browser loads whole. The region is
// lifted between two whole-line markers and evaluated here, so what is judged is the
// bytes the browser runs. A missing marker is a hard failure, never a silent skip.
//
// Node builtins only, like the rest of scripts/.
import fs from "node:fs";
import path from "node:path";
import { liftRegion, ROOT } from "./lib/region.mjs";

function loadRenderer() {
  const { region } = liftRegion("app.js", "md");
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict";${region};return { renderMd: renderMd };`)().renderMd;
}

const renderMd = loadRenderer();

// Things a body might say that are *meant* as text. Every one of these has to come
// back out of a real HTML parser with no element the renderer did not write.
// Keyed by the *kind* of hostility, not by position, so the judge can say which kind
// stopped being covered. A bare list lets a deletion narrow the check while the count
// in the success line moves quietly along with it.
const HOSTILE = {
  "raw tag": "<img src=x onerror=alert(1)>",
  "script element": "<script>alert(1)</script>",
  "svg event handler": "<svg onload=1>",
  "html comment": "<!-- hidden -->",
  "attribute break-out in a link href": '[x](https://a"onmouseover="alert(1))',
  "javascript: scheme": "[x](javascript:alert(1))",
  "javascript: scheme, mixed case": "[x](JaVaScRiPt:alert(1))",
  "javascript: behind a permitted scheme": "[x](https:javascript:alert(1))",
  "attribute break-out in a bare URL": 'https://x.com/a"onmouseover="alert(1)',
  "style injection": '[x](https://x.com/#" style="position:fixed;inset:0)',
  "inside a code span": "`</code><img onerror=1>`",
  "entity-encoded tag": "&lt;img src=x onerror=1&gt;",
  "numeric-entity tag": "&#x3c;img onerror=1&#x3e;",
  "inside a blockquote": "> <img onerror=1>",
  "inside a list item": "- <img onerror=1>",
  "inside a heading": "## <svg onload=1>",
  "inside a table cell": "| <img onerror=1> | b |\n|---|---|\n| c | d |",
  "inside a fence": "```\n<img onerror=1>\n```",
  "unterminated comment after a link": "[a](https://x.com)<!--",
  // The renderer parks finished HTML on NUL while it works. A body that carries one
  // must not be able to reach into that hold.
  "a bare NUL placeholder": "\u0000 0 \u0000",
  "a NUL placeholder aimed at a real hold": "[x](https://x.com)\u00000\u0000",
  "a NUL placeholder in front of a tag": "\u00000\u0000<img onerror=1>",
};

// Structure the judge asserts one by one: [name, markdown].
const SUBSET = [
  ["h2", "## Heading"],
  ["h3", "### Heading"],
  ["h4", "#### Heading"],
  ["bold", "**bold**"],
  ["italic", "*italic*"],
  ["bold-with-italic-inside", "**bold with *italic* inside**"],
  ["code", "`code`"],
  ["fence", "```\nliteral *text*\n```"],
  ["ul", "- one\n- two"],
  ["ol", "1. one\n2. two"],
  ["ol-start", "3. three\n4. four"],
  ["nested", "- one\n  - deeper\n- two"],
  ["nested-ol-in-ul", "- one\n  1. a\n  2. b"],
  ["link", "[label](https://example.com/x)"],
  ["bare-url", "See https://example.com/x here"],
  ["blockquote", "> quoted"],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |"],
  ["table-align", "| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |"],
];

// Lines outside the subset. CONVENTION's one hard promise is that each is shown as
// typed *on its own line* — never folded into the sentence around it. The judge
// checks the neighbouring prose ends up in its own block, which is the half that
// actually regressed: under CRLF every one of these folded.
const UNSUPPORTED = [
  ["raw-html", "before\n<div>raw</div>\nafter"],
  ["image", "before\n![alt](https://example.com/i.png)\nafter"],
  ["rule", "before\n---\nafter"],
  ["stars-rule", "before\n***\nafter"],
  ["lone-pipe", "before\n| not | a table |\nafter"],
  // CONVENTION's subset is `##`–`####`, so these two headings are outside it, and
  // footnotes are in its list by name. All three were folding into the neighbouring
  // sentence until the block-break set learned them — which this list missed because
  // every case in it happened to be one that already worked.
  ["h1", "before\n# Title\nafter"],
  ["h5", "before\n##### Five\nafter"],
  ["footnote", "before\n[^1]: a footnote\nafter"],
];

const fixture = fs.readFileSync(path.join(ROOT, "tests", "markdown.fixture.md"), "utf8");

// The same text with every line ending rewritten. A GitHub issue body, a puck
// authored on Windows and a file a formatter has touched do not agree on what ends a
// line, and the reader either does or does not care. Both other line-by-line readers
// in this repo normalize before parsing; this asserts the renderer joins them.
const ENDINGS = {
  lf: fixture.replace(/\r\n?/g, "\n"),
  crlf: fixture.replace(/\r\n?|\n/g, "\r\n"),
  cr: fixture.replace(/\r\n?|\n/g, "\r"),
};

process.stdout.write(
  JSON.stringify(
    {
      hostile: Object.entries(HOSTILE).map(([kind, src]) => ({ kind, src, html: renderMd(src) })),
      subset: SUBSET.map(([name, src]) => ({ name, src, html: renderMd(src) })),
      unsupported: UNSUPPORTED.map(([name, src]) => ({ name, src, html: renderMd(src) })),
      endings: Object.fromEntries(Object.entries(ENDINGS).map(([k, v]) => [k, renderMd(v)])),
      fixture: renderMd(fixture),
    },
    null,
    1
  )
);
