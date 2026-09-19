#!/usr/bin/env python3
"""Does the board's markdown renderer keep the contract CONVENTION writes down?

Two questions, asked of a parser that has never heard of this codebase — the same
arrangement as check-format.py and PyYAML, and for the same reason. The renderer's
safety property is that it escapes everything first and then emits a fixed whitelist
of tags; "our own reader gets the tags back" would not be evidence of that, because
the thing being tested is precisely what a *browser's* parser makes of the output.

  1. Can a body become markup the renderer did not write? Puck bodies come from other
     people's repos and issue bodies from anyone who can comment, and both land in
     `innerHTML` on the origin that holds the GitHub token.
  2. Does the documented subset render, and is everything outside it "shown as you
     typed it, on its own line"? That last clause is the one promise CONVENTION
     singles out, and it is the half that regressed: under CRLF line endings every
     block rule missed by one character and the lines folded into the paragraph
     around them.

html.parser is stdlib, so unlike the YAML judge this step installs nothing.

Run: python3 scripts/check-markdown.py
"""
import json
import pathlib
import subprocess
import sys
from html.parser import HTMLParser

HERE = pathlib.Path(__file__).resolve().parent

# Everything the renderer is allowed to emit. Not "everything that is safe" — the
# point of a whitelist is that it is the list the code was written to produce, so a
# new tag has to arrive with a decision rather than with a diff.
TAGS = {
    "p", "a", "strong", "em", "code", "pre", "blockquote",
    "h2", "h3", "h4", "ul", "ol", "li",
    "div", "table", "thead", "tbody", "tr", "th", "td",
}
ATTRS = {"href", "target", "rel", "style", "start", "class"}
STYLES = {"text-align:center", "text-align:right"}

failures = []


def fail(check, detail):
    failures.append((check, detail))


class Walk(HTMLParser):
    """Collects the shape of a fragment: its tags, its attributes, its top-level blocks."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.stack = []
        self.tags = []
        self.attrs = []          # (tag, name, value)
        self.blocks = []         # text of each top-level element, in order
        self.mismatch = None

    def handle_starttag(self, tag, attrs):
        if self.depth == 0:
            self.blocks.append("")
        self.tags.append(tag)
        for name, value in attrs:
            self.attrs.append((tag, name, value or ""))
        self.stack.append(tag)
        self.depth += 1

    def handle_endtag(self, tag):
        if not self.stack:
            self.mismatch = self.mismatch or f"</{tag}> with nothing open"
            return
        open_tag = self.stack.pop()
        self.depth -= 1
        if open_tag != tag:
            self.mismatch = self.mismatch or f"expected </{open_tag}>, got </{tag}>"

    def handle_data(self, data):
        if self.blocks:
            self.blocks[-1] += data

    def handle_comment(self, data):
        fail("comment", f"an HTML comment reached the output: {data!r}")


def walk(html):
    w = Walk()
    w.feed(html)
    w.close()
    return w


def check_whitelist(where, src, html):
    """Nothing outside the whitelist, and nothing left open."""
    w = walk(html)
    for tag in w.tags:
        if tag not in TAGS:
            fail("tag", f"{where}: <{tag}> from {src!r} -> {html!r}")
    for tag, name, value in w.attrs:
        if name not in ATTRS:
            fail("attribute", f"{where}: {name}= on <{tag}> from {src!r} -> {html!r}")
        if name == "href":
            v = value.strip().lower()
            if not (v.startswith("http:") or v.startswith("https:")):
                fail("href-scheme", f"{where}: href={value!r} from {src!r}")
        if name == "style" and value.replace(" ", "") not in STYLES:
            fail("style", f"{where}: style={value!r} from {src!r}")
        if name == "class" and tag != "div":
            fail("class", f"{where}: class on <{tag}> from {src!r}")
    if w.mismatch:
        fail("balance", f"{where}: {w.mismatch} from {src!r} -> {html!r}")
    if w.stack:
        fail("balance", f"{where}: never closed {', '.join(w.stack)} from {src!r} -> {html!r}")
    return w


def main():
    # A timeout, because the failure this guards against is not an exception. The
    # renderer's placeholder pass used to spin forever if `esc()` ever stopped
    # stripping NUL, and a CI step that hangs reads as "still running", not as a
    # defect: the job dies on the runner's own limit, minutes later, with no name on
    # it. Reproduced before the loop was bounded.
    try:
        probe = subprocess.run(
            ["node", str(HERE / "md-probe.mjs")],
            capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        print("✗ md-probe.mjs did not finish in 120s — the renderer is not terminating")
        return 1
    if probe.returncode != 0:
        print("✗ md-probe.mjs failed:\n" + (probe.stderr.strip() or "(no output)"))
        return 1
    data = json.loads(probe.stdout)

    # ── 1. Nothing a body says becomes markup ────────────────────────────────────
    # Anchored by kind, not by count. A list of cases the judge merely iterates can be
    # shortened without anything saying so, and the success line's "N hostile bodies"
    # moves along with the deletion — the check narrows and still reads as a pass.
    HOSTILE_KINDS = {
        "raw tag", "script element", "svg event handler", "html comment",
        "attribute break-out in a link href", "attribute break-out in a bare URL",
        "javascript: scheme", "javascript: scheme, mixed case",
        "javascript: behind a permitted scheme", "style injection",
        "inside a code span", "inside a blockquote", "inside a list item",
        "inside a heading", "inside a table cell", "inside a fence",
        "entity-encoded tag", "numeric-entity tag",
        "unterminated comment after a link", "a bare NUL placeholder",
        "a NUL placeholder aimed at a real hold", "a NUL placeholder in front of a tag",
    }
    for case in data["hostile"]:
        check_whitelist("hostile/" + case["kind"], case["src"], case["html"])
    covered = {c["kind"] for c in data["hostile"]}
    for kind in sorted(HOSTILE_KINDS - covered):
        fail("hostile", f"the probe no longer covers {kind!r}")

    # ── 2. The documented subset renders ─────────────────────────────────────────
    # `must` is what has to appear in the output; the point is that each named piece
    # of CONVENTION's list is actually produced, not merely not-unsafe.
    expected = {
        "h2": ["<h2>Heading</h2>"],
        "h3": ["<h3>Heading</h3>"],
        "h4": ["<h4>Heading</h4>"],
        "bold": ["<strong>bold</strong>"],
        "italic": ["<em>italic</em>"],
        "bold-with-italic-inside": ["<strong>bold with <em>italic</em> inside</strong>"],
        "code": ["<code>code</code>"],
        "fence": ["<pre><code>literal *text*</code></pre>"],
        "ul": ["<ul>", "<li>one", "<li>two"],
        "ol": ["<ol>", "<li>one", "<li>two"],
        "ol-start": ['<ol start="3">'],
        "nested": ["<ul>", "<li>one", "<ul>", "<li>deeper"],
        "nested-ol-in-ul": ["<ul>", "<ol>", "<li>a"],
        "link": ['<a href="https://example.com/x" target="_blank" rel="noopener">label</a>'],
        "bare-url": ['<a href="https://example.com/x"'],
        "blockquote": ["<blockquote>quoted</blockquote>"],
        "table": ["<table>", "<th>a</th>", "<td>1</td>"],
        "table-align": ['<th style="text-align:center">c</th>', '<th style="text-align:right">r</th>'],
    }
    seen = set()
    for case in data["subset"]:
        check_whitelist("subset/" + case["name"], case["src"], case["html"])
        seen.add(case["name"])
        for needle in expected.get(case["name"], []):
            if needle not in case["html"]:
                fail("subset", f"{case['name']}: {needle!r} missing from {case['html']!r}")
    for name in expected:
        if name not in seen:
            fail("subset", f"{name} is asserted here but the probe no longer renders it")

    # ── 3. An unsupported line keeps its own line ────────────────────────────────
    # The probe feeds "before / <the unsupported line> / after". CONVENTION's promise
    # is that the middle line is shown as typed and never folded into its neighbours,
    # so the three have to land in three different top-level blocks.
    UNSUPPORTED_NAMES = {
        "raw-html", "image", "rule", "stars-rule", "lone-pipe", "h1", "h5", "footnote",
    }
    for name in sorted(UNSUPPORTED_NAMES - {c["name"] for c in data["unsupported"]}):
        fail("own-line", f"the probe no longer feeds an unsupported {name!r} line")
    for case in data["unsupported"]:
        w = check_whitelist("unsupported/" + case["name"], case["src"], case["html"])
        blocks = w.blocks
        where = {}
        for i, text in enumerate(blocks):
            for word in ("before", "after"):
                if word in text:
                    where.setdefault(word, i)
        if "before" not in where or "after" not in where:
            fail("own-line", f"{case['name']}: lost the surrounding prose -> {case['html']!r}")
        elif where["after"] - where["before"] < 2:
            fail(
                "own-line",
                f"{case['name']}: the unsupported line was folded into its neighbours "
                f"-> {case['html']!r}",
            )

    # ── 4. A line ending is not a dialect ────────────────────────────────────────
    lf = data["endings"]["lf"]
    for name in ("crlf", "cr"):
        if data["endings"][name] != lf:
            fail("line-endings", f"the fixture renders differently with {name.upper()} endings")
    if "\r" in lf:
        fail("line-endings", "a carriage return survived into the output")

    # ── 5. The fixture itself ────────────────────────────────────────────────────
    html = data["fixture"]
    check_whitelist("fixture", "tests/markdown.fixture.md", html)
    for needle, why in [
        ("<h2>Headings</h2>", "an `##` heading"),
        ("<h3>Third level</h3>", "an `###` heading"),
        ("<h4>Fourth level</h4>", "an `####` heading"),
        ('<ol start="7">', "an author's starting number"),
        ("<blockquote>", "a blockquote"),
        ("<pre><code>", "a fenced block"),
        ('<th style="text-align:right">right</th>', "a right-aligned table cell"),
        # One needle per claim. There were two for `#` and two for `#####` — the
        # fixture's title line and its "Outside the subset" line say the same thing,
        # and the sandwiched ones are what the promise is actually about, so those
        # are the ones kept.
        ("<p># A first-level heading is outside the subset</p>",
         "an `#` heading on its own line, with prose immediately above and below it"),
        ("<p>##### A fifth-level heading is outside the subset</p>",
         "an `#####` heading on its own line, with prose immediately around it"),
        ("<p>[^1]: A footnote definition is not interpreted.</p>",
         "a footnote definition on its own line, with prose immediately around it"),
        ("https://example.com/a*b*c</a>", "a URL with asterisks in its path, linked whole"),
    ]:
        if needle not in html:
            fail("fixture", f"{why} is missing ({needle!r})")

    if failures:
        print(f"✗ markdown renderer: {len(failures)} failure(s)\n")
        for check, detail in failures:
            print(f"  [{check}] {detail}")
        return 1

    counts = (len(data["hostile"]), len(data["subset"]), len(data["unsupported"]))
    print(
        "✓ markdown: %d hostile bodies produced no markup the renderer does not write, "
        "%d documented forms render, %d unsupported lines kept their own line, "
        "and the fixture renders identically with LF, CRLF and CR endings" % counts
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
