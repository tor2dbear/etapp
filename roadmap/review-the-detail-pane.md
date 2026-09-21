---
title: Review the detail pane
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 70
---

## Goal

**app.js 2391–2519 and 4446–5164 — 848 lines.** What opens when a puck is opened.

- 2391–2429 `deep links: #<item.id> opens that puck's modal`
- 2430–2456 `detail modal`
- 2457–2519 `detail: a side pane on desktop, a modal overlay on mobile`
- 4446–4492 `tabs: Overview · Activity · Discussion`
- 4493–4649 `Overview: properties rail, in sections`
- 4650–5164 `Contains: the parent's members, as rows`

**Done looks like:** every field the pane displays is traced from the puck to the
pixel, including the derived ones (`children`, `progress`, `blockedBy`,
`signals`), and the deep-link path is exercised with references that resolve to
nothing.

## Research

`Contains: the parent's members, as rows` (515 lines) renders derived data —
`children[]` and `progress` are computed at harvest from the children's `parent:`
lines, never stored. A parent whose `parent:` closes a loop is flagged
`parent-cycle` and ignored, never repaired. What the pane does with a flagged or
unresolved parent is the interesting question.

The deep-link path (`#<repo>/<slug>`) takes a string straight out of the URL —
the same class of input that produced #9's bug on `?sort=` and `?view=`.

## Open questions

- Does the Activity tab reach git history from the browser, and if so through
  what? A read of someone else's repository is a different exposure than a read
  of the harvested payload.
