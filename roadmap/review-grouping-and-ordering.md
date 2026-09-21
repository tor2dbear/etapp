---
title: Review grouping and ordering
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 40
---

## Goal

**app.js 5165–5462 and 6514–6944 — 729 lines.**

- 5165–5462 `grouping`
- 6514–6944 `the ordering is a chain`

**Done looks like:** every grouping field produces columns that partition the
pucks — each puck in exactly one column, no puck lost — and the ordering chain is
read as a chain, with each link's tie-break stated.

## Research

This is where PR #9's deferred behavioural half lands: CI has no browser, so
"every puck lands in exactly one column whatever its agent is called" was measured
by hand rather than by a gate. The design for closing it is written in #9's
description — `groupsOf` takes its grouping as a parameter instead of reaching for
`activeGroup()`, and then a fence around it, `presentKeys` and `GROUPS` lifts
cleanly, with the probe supplying a fixture payload rather than a stub.

That work belongs to this puck. It is the reason this slice is worth more than its
729 lines suggest: it is the one that can turn a hand measurement into a gate.

The four orthogonal axes from AGENTS.md are the thing to hold onto while reading:
`status` is which column, `order` is the place in it, `priority` is how much it
matters, `target` is roughly when. They are never to be conflated, and an ordering
chain is exactly where they would be.

## Open questions

- `roadmap.mjs` once returned `NaN` from a comparator built out of
  `Object.fromEntries`; #9 fixed that one and the note beside it records paying for
  a NaN comparator before. Does the board's chain have the same shape anywhere?
