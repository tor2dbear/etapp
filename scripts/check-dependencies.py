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


def key(ref, from_repo):
    """What a reference is, before asking whether anything answers to it."""
    s = str(ref).strip()
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
            (deps if k in by_key else gone).append(by_key[k] if k in by_key else ref)
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
    """Every puck on a cycle of the authored graph. Iterative, since a probe should not
    be able to end a judge with a stack overflow."""
    colour, found = {}, set()
    for start in items:
        if start["id"] in colour:
            continue
        stack = [(start, iter(edges[start["id"]]))]
        path = [start]
        colour[start["id"]] = 1
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                stack.pop()
                path.pop()
                colour[node["id"]] = 2
                continue
            if colour.get(nxt["id"]) == 1:
                for back in reversed(path):
                    found.add(back["id"])
                    if back["id"] == nxt["id"]:
                        break
            elif nxt["id"] not in colour:
                colour[nxt["id"]] = 1
                path.append(nxt)
                stack.append((nxt, iter(edges[nxt["id"]])))
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

    # Anti-vacuity: the shapes this judge exists for have to be in the corpus. A run that
    # never saw a loop, or a reference written two ways, would pass on nothing at all —
    # the same failure the gates it sits beside were built to catch.
    shapes = {"loop": 0, "two-spellings": 0, "unknown": 0, "settled-blocker": 0, "cross-repo": 0}
    for case in cases:
        items, _ = case["items"], None
        by_id = {it["id"]: it for it in items}
        if case["cycles"]:
            shapes["loop"] += 1
        for it in items:
            keys = [key(r, it["repo"]) for r in it["depends"]]
            if len(keys) != len(set(keys)):
                shapes["two-spellings"] += 1
            for r, k in zip(it["depends"], keys):
                repo, slug = k.split(SEP, 1)
                target = repo + "#" + slug
                if target not in by_id:
                    shapes["unknown"] += 1
                elif by_id[target]["status"] in TERMINAL:
                    shapes["settled-blocker"] += 1
                if repo != it["repo"]:
                    shapes["cross-repo"] += 1
    for shape, n in shapes.items():
        if n == 0:
            fail("coverage", f"no case in the corpus has {shape} — that claim is being made about nothing")

    for case in cases:
        name = case["name"]
        expected, edges = derive(case["items"])
        by_id = {it["id"]: it for it in case["items"]}

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

        for row in case["board"]:
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

        want_loops = loops(case["items"], edges)
        if set(case["cycles"]) != want_loops:
            fail("cycle", f"{name}: flagged {sorted(case['cycles'])}, expected {sorted(want_loops)}")

        for row, signals in zip(case["board"], case["boardSignals"]):
            has = "depends-missing" in signals
            if has != bool(row["missingDepends"]):
                fail("signal", f"{name}: {row['id']} says depends-missing={has} with {row['missingDepends']!r}")
            if signals.count("depends-missing") > 1:
                fail("signal", f"{name}: {row['id']} carries the note twice")

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
