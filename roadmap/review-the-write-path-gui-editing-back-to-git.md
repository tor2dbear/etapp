---
title: "Review the write path: GUI editing back to git"
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 30
---

## Goal

**app.js 9608–11793 — 2 186 lines.** The only place in the board where the browser
writes. Everything else reads.

- 9608–9960 `GUI editing: write pucks back to git from the browser`
- 9961–10355 `manual rank`
- 10356–10495 `date picker`
- 10496–10579 `parent`
- 10580–11793 `dependencies` — the largest single block

A defect in the scrollport gives an ugly view. A defect here writes the wrong
thing into somebody's repository, through a path the board's own convention says
must stay thin: a write is a commit, and there is to be no second source of truth.

**Done looks like:** every write this surface can make has been traced from the
control to the commit, against a real payload; each one either lands what it says
it lands or is reported.

## Research

The dependencies block is not the editor it sounds like — it is
`recomputeDeps()`, a **client-side re-derivation** of `blockedBy` / `blocks` /
`missingDepends`, so that an optimistic edit does not leave the two directions
disagreeing before the next harvest.

That makes it a second implementation of what `harvest.mjs` derives, which is
exactly the item PR #8 left open ("the derivation is still two implementations").
The two are the same finding seen from two ends, and this puck is where they
meet. Any divergence between them is a board that shows one thing and a harvest
that produces another.

Worth reading with the AGENTS.md invariants open: the hierarchy points up only,
`blocks` is derived and never authored, an unresolved reference keeps blocking.
Those are the claims the re-derivation has to honour.

## Open questions

- Is the client re-derivation testable against the harvest one directly — same
  fixture into both, compare — rather than by reading both and reasoning?
- Optimistic edits: what does the board show between the write and the next
  harvest if the write fails?
