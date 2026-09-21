---
title: "Review the shell: URL, saved views, Sync now, boot"
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 60
---

## Goal

**app.js 932–1141, 7220–7400, 8821–9320, 9532–9607 — 1 003 lines.** The frame
around the board.

- 932–1141 `the URL: the query's third face`
- 7220–7305 `sidebar folding`
- 7306–7400 `the view switcher: the title is the control`
- 8821–9028 `saved views`
- 9029–9320 `Sync now: ask CI for a fresher harvest`
- 9532–9581 `boot`
- 9582–9607 `mobile drawer`

**Done looks like:** every URL parameter round-trips, a saved view means the same
thing as the link that produced it, and `Sync now` is read as what it is — an
outward call from a static page.

## Research

The URL is where #9's reachable crashes arrived from: `?sort=constructor` killed
the board and `?view=constructor` blanked it silently. The tables behind those are
fixed; this slice reads the parameter handling itself, and the parameter list is
long — `q`, `view`, `group`, `layout`, `sort`, `done`, `empty`, `collapsed`, and
`#<repo>/<slug>` — all of it strings from outside.

`Sync now` drives `workflow_dispatch` against `sync.yml`. It is the only outward
call the board makes, and the design note beside it is explicit that this is meant
to stay one GitHub primitive with no relay and no always-on service. Worth reading
as an exposure, not just as a feature.

`board.config.json` holds the saved views and is configuration rather than truth,
so a defect here cannot corrupt a puck — but it can commit.

## Open questions

- `?collapsed=` carries group keys that belong to whatever `?group=` is set to and
  are dropped when it changes. What happens to a link where the two disagree?
