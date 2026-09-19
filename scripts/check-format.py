#!/usr/bin/env python3
"""Does this repo write valid YAML, and does it read a puck the way YAML does?

Both questions are asked of PyYAML rather than of our own parser, which is the whole
point. Our reader accepts things no YAML parser does — a bare `@frontend`, a trailing
colon, `5e-7` as a number — so "it round-trips for us" was never evidence that a puck
is a puck to anyone else. Pucks live in other people's repos and are read by other
people's tools.

Runs scripts/format-probe.mjs for the values, judges them here. Exits non-zero with
the failures named, so CI stops on the class of defect that cost this project ten
rounds of review to find by hand.

Needs PyYAML, which CI installs. Deliberately not a Node dependency: nothing about
this ships, and a second YAML implementation in the product would defeat the purpose.
"""
import datetime
import json
import pathlib
import subprocess
import sys

import yaml

HERE = pathlib.Path(__file__).resolve().parent
failures = []


def fail(check, detail):
    failures.append((check, detail))


def load(line):
    """Parse one `key: value` line, or raise."""
    return list(yaml.safe_load(line).values())[0]


def normalize(x):
    """A parsed value as the text a puck would carry, for comparing readers."""
    if isinstance(x, (datetime.date, datetime.datetime)):
        return x.isoformat()
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, list):
        return [normalize(i) for i in x]
    if x is None:
        return ""
    return str(x)


probe = json.loads(subprocess.run(
    ["node", str(HERE / "format-probe.mjs")],
    capture_output=True, text=True, check=True,
).stdout)

# 1. Every string must come back a string, with the same characters, in both the
#    scalar position and inside a flow array. The type is half the check: a bare
#    `true` is valid YAML and the wrong value.
for row in probe["strings"]:
    for where, line in (("scalar", f"title: {row['scalar']}"), ("item", f"tags: [{row['item']}]")):
        try:
            got = load(line)
            if where == "item":
                got = got[0]
        except yaml.YAMLError as e:
            fail(f"string/{where}", f"{row['value']!r} wrote {line!r} — {type(e).__name__}")
            continue
        if not isinstance(got, str):
            fail(f"string/{where}", f"{row['value']!r} wrote {line!r} — read back as {type(got).__name__} {got!r}")
        elif got != row["value"]:
            fail(f"string/{where}", f"{row['value']!r} wrote {line!r} — read back as {got!r}")

# 2. A whole list at once: an item that survives alone can still be broken by how its
#    neighbour was quoted.
try:
    got = load(probe["listLine"])
    want = [r["value"] for r in probe["strings"]]
    if got != want:
        wrong = [(w, g) for w, g in zip(want, got) if w != g]
        fail("list-line", f"{len(wrong)} of {len(want)} items differ, first: {wrong[0] if wrong else '-'}")
except yaml.YAMLError as e:
    fail("list-line", f"{type(e).__name__}: {probe['listLine'][:80]}…")

# 3. Numbers must come back numbers of equal value. `order` is compared, never
#    displayed, so a rank written as a string sorts against its neighbours wrongly.
for row in probe["numbers"]:
    line = f"order: {row['written']}"
    try:
        got = load(line)
    except yaml.YAMLError as e:
        fail("number", f"{row['value']!r} wrote {line!r} — {type(e).__name__}")
        continue
    if isinstance(got, bool) or not isinstance(got, (int, float)):
        fail("number", f"{row['value']!r} wrote {line!r} — read back as {type(got).__name__} {got!r}")
    elif float(got) != float(row["value"]):
        fail("number", f"{row['value']!r} wrote {line!r} — read back as {got!r}")

# 4. Dates must come back dates. The convention writes them bare and means it.
for row in probe["dates"]:
    line = f"updated: {row['written']}"
    got = load(line)
    if not isinstance(got, datetime.date):
        fail("date", f"{row['value']!r} wrote {line!r} — read back as {type(got).__name__} {got!r}")
    elif got.isoformat() != row["value"]:
        fail("date", f"{row['value']!r} wrote {line!r} — read back as {got.isoformat()}")

# 5. Our reader against a real one. Where they disagree, a puck's board entry says
#    something its own frontmatter does not.
#
#    One disagreement is allowed and deliberate: input YAML rejects outright, which
#    this parser reads leniently rather than dropping the puck from the board. That
#    is lenient on read, strict on write — the encoder never produces such a line, as
#    checks 1–4 above are what guarantee.
for row in probe["lines"]:
    try:
        theirs = normalize(load(row["line"]))
    except yaml.YAMLError:
        continue  # invalid input: leniency is the documented behaviour
    ours = normalize(row["read"])
    if ours != theirs:
        fail("reader", f"{row['line']!r} — ours {ours!r}, YAML {theirs!r}")

# 6. The CLI's own output, because the checks above reach the encoder directly and
#    miss the step in front of it. `formatValue` decides which *fields* may write a
#    bare number or date, and getting that wrong writes `title: 123` as an integer
#    where the author typed three characters — a defect that reached review once
#    already and that checks 1-5 cannot see. So this drives the real commands and
#    judges the files they leave behind.
import os
import tempfile

CLI = str(HERE / "roadmap.mjs")


def run(cwd, *args):
    r = subprocess.run(["node", CLI, *args], cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        fail("cli", f"`roadmap {' '.join(args)}` exited {r.returncode}: {r.stderr.strip()[:120]}")
    return r


def frontmatter_of(path):
    return yaml.safe_load(path.read_text(encoding="utf-8").split("---")[1])


with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)
    # A title that is digits, and one opening with a YAML indicator.
    run(tmp, "new", "123")
    run(tmp, "new", "@frontend refactor")
    run(tmp, "new", "Ranked", "--tags", "editor,ui")
    run(tmp, "issue", "ranked", "42")
    run(tmp, "target", "ranked", "2026-12-01")

    expectations = [
        ("123.md", "title", str, "123"),
        ("frontend-refactor.md", "title", str, "@frontend refactor"),
        ("ranked.md", "issue", int, 42),
        ("ranked.md", "target", datetime.date, datetime.date(2026, 12, 1)),
        ("ranked.md", "updated", datetime.date, None),
    ]
    for name, key, want_type, want in expectations:
        path = tmp / "roadmap" / name
        if not path.exists():
            fail("cli", f"{name} was not created")
            continue
        try:
            data = frontmatter_of(path)
        except yaml.YAMLError as e:
            fail("cli", f"{name} is not valid YAML — {type(e).__name__}")
            continue
        got = data.get(key)
        if not isinstance(got, want_type) or isinstance(got, bool) and want_type is not bool:
            fail("cli", f"{name} `{key}` read back as {type(got).__name__} {got!r}, wanted {want_type.__name__}")
        elif want is not None and got != want:
            fail("cli", f"{name} `{key}` read back as {got!r}, wanted {want!r}")

    # A rank landing between two neighbours has to stay a number.
    for slug, order in (("a", 10), ("b", 11)):
        (tmp / "roadmap" / f"{slug}.md").write_text(
            f"---\ntitle: {slug.upper()}\nstatus: next\norder: {order}\nupdated: 2026-09-01\n---\n{slug}\n",
            encoding="utf-8",
        )
    run(tmp, "status", "ranked", "next")
    run(tmp, "move", "ranked", "--after", "a")
    data = frontmatter_of(tmp / "roadmap" / "ranked.md")
    if not isinstance(data.get("order"), (int, float)) or isinstance(data.get("order"), bool):
        fail("cli", f"a fractional rank read back as {type(data.get('order')).__name__} {data.get('order')!r}")

    # And every puck the CLI produced has to parse at all.
    made = sorted((tmp / "roadmap").glob("*.md"))
    for path in made:
        try:
            yaml.safe_load(path.read_text(encoding="utf-8").split("---")[1])
        except yaml.YAMLError as e:
            fail("cli", f"{path.name} is not valid YAML — {type(e).__name__}")

if failures:
    print(f"✗ {len(failures)} format check(s) failed\n", file=sys.stderr)
    for check, detail in failures:
        print(f"  [{check}] {detail}", file=sys.stderr)
    print(
        "\nThese compare what this repo writes and reads against a real YAML parser."
        "\nA failure means a puck we produce, or the way we read one, differs from what"
        "\nevery other tool sees in the same file.",
        file=sys.stderr,
    )
    sys.exit(1)

print(
    f"✓ format clean — {len(probe['strings'])} strings round-trip as strings in both positions, "
    f"{len(probe['numbers'])} numbers as numbers, {len(probe['dates'])} dates as dates, "
    f"this parser agrees with PyYAML on {len(probe['lines'])} frontmatter lines, "
    f"and every puck the CLI writes parses clean"
)
