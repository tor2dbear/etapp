---
title: Read the board surface by surface
status: later
tags: [review]
updated: 2026-09-21
created: 2026-09-21
order: 10
---

## Goal

app.js is 11 792 lines in one IIFE. Nine merged pull requests have read parts of
it, and the parts they read were almost all the **data path** — the harvest, the
format, the renderer, the query, the references. The **interaction surface** is
largely unread.

This puck is the parent. Its children are one surface each, sized so a review can
hold the whole surface in view at once — which is the point, and the lesson #9
paid for: the defect that costs the most review rounds is correct-looking code
whose premise about a *different part of the file* is wrong, and a reader who
only sees a fragment cannot see it.

**Done** when every child is done, or explicitly dropped with a reason.

## Research

What the nine merged PRs covered:

| | Surface |
|---|---|
| #1 | the harvest pipeline (`harvest.mjs`) |
| #2, #3 | CI, and `format.js` |
| #4 | the markdown renderer — app.js 350–598 |
| #5 | the query model — app.js 599–871 |
| #6 | puck writing (YAML) |
| #7 | the meta-check: can each gate actually fail? |
| #8 | references, blockers, cycles |
| #9 | the lookup tables (48–211) and the column surface (5463–6513) |

The coverage map for what is left, so no line is dropped silently:

| Lines | Size | Child |
|---|---|---|
| 9608–11793 | 2 186 | the write path |
| 2520–4445 | 1 926 | the scrollport and the port around it |
| 1142–1489, 1695–2390, 7401–8007 | 1 613 | the view's shape |
| 932–1141, 7220–7400, 8821–9320, 9532–9607 | 1 003 | the shell |
| 872–931, 6945–7219, 8510–8820, 9321–9531 | 857 | the filter surface |
| 2391–2519, 4446–5164 | 848 | the detail pane |
| 5165–5462, 6514–6944 | 729 | grouping and ordering |
| 8008–8509 | 502 | search, ⌘K and keyboard |

**Not slated, and why** — the distinction between "deliberately out of scope" and
"nobody looked" is one this board keeps having to make, so it is written down:

- `demo mode` (7–47) — a fixture, exercised by every browser run.
- `auto-status` (212–349) — reachable from the harvest side, read in #1.
- `the horizon` (1490–1550) — 61 lines of date arithmetic, covered by the format gate.
- `inline icons` (1551–1694) — static SVG paths, no logic.

## Open questions

- Order. The children are ranked by the risk argument rather than by size: the
  write path is a tenth of the scrollport and has far more to lose, because it is
  the only place in the board where the browser *writes*. That ranking is a
  recommendation, not a decision.
- Whether the gate review (`replace-the-hand-written-lexer-with-a-real-parser`)
  should come before the later children. It does not block any of them, but while
  the gate reads app.js with a hand-written lexer, every child that adds a table
  risks a round lost to a false red. That cost was paid 22 times in #9.
