#!/usr/bin/env python3
"""Do the two implementations of `depends:` derive the same thing, and the right thing?

One field is authored — `depends:`, on the blocked puck. Two are derived from it:
`blockedBy`, whose emptiness is the whole read contract ("what can I start?"), and
`blocks`, its mirror. The harvester derives them for the payload and the board derives
them again after an optimistic edit, because a board that waited for the next harvest
would show the two directions disagreeing between renders.

Two implementations of one rule is this repository's recurring defect, so the probe
lifts both out of the files that ship and runs them side by side. That alone would only
prove they are the same, though — including the same mistake — so this judge derives the
answer a third time, here, in Python, from the convention's own wording:

  * a bare slug names a puck in my repo; `owner/repo#slug` names one anywhere
  * the same reference written two ways is one reference
  * a settled puck waits for nothing and holds up nothing
  * a reference that names nothing is not a settled one: it stays, as written
  * a loop is a loop whatever the pucks' states; every puck on it is flagged

Nothing here imports the code under test, and the two languages disagree about enough
(dictionary ordering, truthiness, what `""` is) that a shared assumption is unlikely to
survive both.

Run: python3 scripts/check-dependencies.py
"""
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent

TERMINAL = {"done", "cancelled"}
SEP = "\u0000"

failures = []


def fail(check, detail):
    failures.append((check, detail))


# What JavaScript's `trim()` removes, spelled out. Python's `str.strip()` is a different
# set — it takes U+001C…U+001F and U+0085 and leaves U+FEFF — so a reference padded with
# a BOM would have been trimmed on one side of this comparison and not the other, and the
# judge would have reddened the gate over correct code.
JS_TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007" \
          "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def key(ref, from_repo):
    """What a reference is, before asking whether anything answers to it."""
    s = str(ref).strip(JS_TRIM)
    at = s.find("#")
    return (from_repo + SEP + s) if at == -1 else (s[:at] + SEP + s[at + 1:])


def derive(items):
    """blockedBy, blocks and missingDepends, from the authored graph alone."""
    by_key = {it["repo"] + SEP + it["slug"]: it for it in items}
    edges, missing = {}, {}
    for it in items:
        seen, deps, gone = set(), [], []
        for ref in it["depends"]:
            k = key(ref, it["repo"])
            if k in seen:
                continue
            seen.add(k)
            d = by_key.get(k)
            (deps if d else gone).append(d if d else ref)
        edges[it["id"]], missing[it["id"]] = deps, gone

    out = {it["id"]: {"id": it["id"], "blockedBy": [], "blocks": [], "missingDepends": missing[it["id"]]}
           for it in items}
    for it in items:
        if it["status"] in TERMINAL:
            continue
        live = [d for d in edges[it["id"]] if d["status"] not in TERMINAL]
        out[it["id"]]["blockedBy"] = [d["id"] for d in live] + missing[it["id"]]
        for d in live:
            out[d["id"]]["blocks"].append(it["id"])
    for row in out.values():
        row["blocks"].sort()
    return [out[it["id"]] for it in items], edges


def loops(items, edges):
    """Every puck that can reach itself.

    Kosaraju, and deliberately not the algorithm the harvester uses. The first version of
    this walked back edges exactly as the harvester did, agreed with it perfectly, and
    both were wrong the same way: in `r → a → u → r` with a second way round, `r → v → u`,
    the puck `v` waits for itself and neither flagged it. A judge that transliterates the
    code it judges is not a second opinion. Two passes over the graph and its reverse
    answer the same question by a different route, and a component of more than one puck
    is exactly a set of pucks that all wait for each other.

    Iterative, because a probe should not be able to end a judge with a stack overflow.
    """
    ids = [it["id"] for it in items]
    out = {i: [d["id"] for d in edges[i]] for i in ids}
    rev = {i: [] for i in ids}
    for i in ids:
        for j in out[i]:
            rev[j].append(i)

    order, seen = [], set()
    for start in ids:
        if start in seen:
            continue
        seen.add(start)
        stack = [(start, iter(out[start]))]
        while stack:
            node, walk = stack[-1]
            nxt = next(walk, None)
            if nxt is None:
                order.append(node)
                stack.pop()
            elif nxt not in seen:
                seen.add(nxt)
                stack.append((nxt, iter(out[nxt])))

    found, assigned = set(), set()
    for root in reversed(order):
        if root in assigned:
            continue
        assigned.add(root)
        group, stack = [], [root]
        while stack:
            node = stack.pop()
            group.append(node)
            for back in rev[node]:
                if back not in assigned:
                    assigned.add(back)
                    stack.append(back)
        if len(group) > 1:
            found.update(group)
        elif root in out[root]:
            found.add(root)
    return found


def main():
    # The probe runs the two implementations; a graph walk that does not terminate would
    # otherwise read as "still running" until the runner's own limit kills the job with
    # no name on the failure.
    try:
        probe = subprocess.run(
            ["node", str(HERE / "dep-probe.mjs")],
            capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired:
        print("✗ dep-probe.mjs did not finish in 120s — a derivation is not terminating")
        return 1
    if probe.returncode != 0:
        print("✗ dep-probe.mjs failed:\n" + (probe.stderr.strip() or "(no output)"))
        return 1
    cases = json.loads(probe.stdout)["cases"]
    if not cases:
        print("✗ the probe produced no cases — this check just stopped checking anything")
        return 1

    # Anti-vacuity: the shapes this judge exists for have to be in the corpus, and a
    # count of cases so a corpus that collapses is a failure rather than a quiet pass.
    # Counted from this file's own derivation, inside the loop that already has it — the
    # first version was a second pass that rebuilt the resolution rule and drifted from
    # it the moment ids changed shape, which is the defect this whole gate is about.
    shapes = {"loop": 0, "two-spellings": 0, "unknown": 0, "settled-blocker": 0, "cross-repo": 0}

    for case in cases:
        name = case["name"]
        expected, edges = derive(case["items"])
        by_id = {it["id"]: it for it in case["items"]}

        for it, row in zip(case["items"], expected):
            keys = [key(r, it["repo"]) for r in it["depends"]]
            if len(keys) != len(set(keys)):
                shapes["two-spellings"] += 1
            if row["missingDepends"]:
                shapes["unknown"] += 1
            if any(d["status"] in TERMINAL for d in edges[it["id"]]):
                shapes["settled-blocker"] += 1
            if any(k.split(SEP, 1)[0] != it["repo"] for k in keys):
                shapes["cross-repo"] += 1

        for side in ("board", "harvest"):
            got = case[side]
            if len(got) != len(expected):
                fail(side, f"{name}: {len(got)} rows for {len(expected)} pucks")
                continue
            for want, have in zip(expected, got):
                for field in ("blockedBy", "blocks", "missingDepends"):
                    if want[field] != have[field]:
                        fail(side, f"{name}: {have['id']}.{field} is {have[field]!r}, not {want[field]!r}")

        if case["board"] != case["harvest"]:
            fail("agree", f"{name}: the board and the harvester derive different graphs")

        for row, signals in zip(case["board"], case["boardSignals"]):
            item = by_id[row["id"]]
            if len(set(row["blockedBy"])) != len(row["blockedBy"]):
                fail("duplicate", f"{name}: {row['id']}.blockedBy repeats itself: {row['blockedBy']!r}")
            if len(set(row["blocks"])) != len(row["blocks"]):
                fail("duplicate", f"{name}: {row['id']}.blocks repeats itself: {row['blocks']!r}")
            if item["status"] in TERMINAL and (row["blockedBy"] or row["blocks"]):
                fail("terminal", f"{name}: settled {row['id']} still has edges")
            # The mirror, stated the other way round from how either implementation
            # builds it: x holds up y exactly when y waits for x.
            for other in case["board"]:
                mine = other["id"] in row["blocks"]
                theirs = row["id"] in other["blockedBy"]
                if mine != theirs:
                    fail("mirror", f"{name}: {row['id']}.blocks and {other['id']}.blockedBy disagree")
            for ref in row["missingDepends"]:
                if ref not in row["blockedBy"] and item["status"] not in TERMINAL:
                    fail("unknown", f"{name}: {row['id']} dropped the unresolved {ref!r} from blockedBy")
            # The board's own note, which the harvester decides elsewhere: it has to move
            # with the list it is built from, or the puck says "depends on , which
            # doesn't exist" with the name missing from the complaint.
            has = "depends-missing" in signals
            if has != bool(row["missingDepends"]):
                fail("signal", f"{name}: {row['id']} says depends-missing={has} with {row['missingDepends']!r}")
            if signals.count("depends-missing") > 1:
                fail("signal", f"{name}: {row['id']} carries the note twice")

        # What the modal draws and what the ✕ leaves behind, held to the same rule as the
        # derivation: one entry per reference, and a removal that reaches every spelling.
        for it, shown, after in zip(case["items"], case["dependRefs"], case["afterRemovingFirst"]):
            keys = [key(r, it["repo"]) for r in it["depends"]]
            drawn = [key(r, it["repo"]) for r in shown]
            if len(drawn) != len(set(drawn)):
                fail("chips", f"{name}: {it['id']} would draw {len(drawn)} chips for {len(set(drawn))} blockers")
            if set(drawn) != set(keys):
                fail("chips", f"{name}: {it['id']} draws {sorted(set(drawn))}, declared {sorted(set(keys))}")
            if it["depends"]:
                gone = key(it["depends"][0], it["repo"])
                left = [key(r, it["repo"]) for r in after]
                if gone in left:
                    fail("remove", f"{name}: {it['id']} still lists {it['depends'][0]!r} after removing it")
                if set(left) != set(keys) - {gone}:
                    fail("remove", f"{name}: {it['id']} lost more than the one reference removed")

        want_loops = loops(case["items"], edges)
        if want_loops:
            shapes["loop"] += 1
        if set(case["cycles"]) != want_loops:
            fail("cycle", f"{name}: flagged {sorted(case['cycles'])}, expected {sorted(want_loops)}")


    # After the loop, not before it: the shapes are counted from the same derivation the
    # comparisons use. A floor rather than "more than none", because the fuzz is what
    # catches the cross-edge loop this gate was written for and it catches it in five
    # graphs out of a thousand — a corpus trimmed to a couple of hundred would have
    # shipped that bug green, and nothing but a floor would have said so.
    if len(cases) < 500:
        fail("coverage", f"only {len(cases)} graphs in the corpus — the rare shapes need the fuzz")
    for shape, n in shapes.items():
        if n == 0:
            fail("coverage", f"no case in the corpus has {shape} — that claim is being made about nothing")
    if shapes["loop"] < 50:
        fail("coverage", f"only {shapes['loop']} graphs contain a loop — too few to hold the cycle claim")

    if failures:
        print(f"✗ dependencies: {len(failures)} failure(s)\n")
        for check, detail in failures[:40]:
            print(f"  [{check}] {detail}")
        if len(failures) > 40:
            print(f"  … and {len(failures) - 40} more")
        print("\n  The graph is derived three times: by the harvester, by the board, and here.")
        return 1

    pucks = sum(len(c["items"]) for c in cases)
    print(
        "✓ dependencies: %d graphs and %d pucks derive the same blockedBy, blocks and "
        "missingDepends in the board and the harvester, each matching a third derivation "
        "here; the mirror holds, no edge is counted twice, settled pucks wait for nothing, "
        "an unresolved reference survives, and %d loops are flagged exactly"
        % (len(cases), pucks, sum(1 for c in cases if c["cycles"]))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
