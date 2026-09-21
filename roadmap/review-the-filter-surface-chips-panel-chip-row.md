---
title: "Review the filter surface: chips, panel, chip row"
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 80
---

## Goal

**app.js 872–931, 6945–7219, 8510–8820, 9321–9531 — 857 lines.** Four places that
edit one query.

- 872–931 `editing the filter`
- 6945–7219 `filter chips`
- 8510–8526 `Filter popover (view-header)`
- 8527–8820 `the filter panel`
- 9321–9531 `the chip row`

**Done looks like:** every control here produces a query the grammar in AGENTS.md
can name, and every query the grammar can name survives a round trip through the
controls without changing meaning.

## Research

The query grammar is the board's public surface — it is what a link carries, what
an agent writes, and what a saved view stores. #5 read the query *model*
(599–871); this slice reads the four editors on top of it.

The round trip is the claim worth testing, because it is the one that can quietly
lose a term: a query typed by hand, rendered as chips, edited by one chip, and
read back. Negation (`-`), value lists (`a,b`), `has:` and the derived `is:`
namespace are each a way for that trip to lose something.

## Open questions

- `-has:agent` is the only way to name an absence. Can the chip row express it, or
  does a round trip through the UI drop it?
