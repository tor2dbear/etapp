---
title: "Review the view's shape: display memory, fields, Display panel"
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 90
---

## Goal

**app.js 1142–1489, 1695–2390, 7401–8007 — 1 613 lines.** Three places that decide
the same thing: what a view shows.

- 1142–1489 `the view's display memory`
- 1695–1826 `segmented control: one value out of a small closed set`
- 1827–2390 `which properties a view shows`
- 7401–7450 `theme`
- 7451–8007 `Display: layout · grouping · ordering · what's included wholesale`

**Done looks like:** the three are read together, and the question "where does
this setting actually live" has one answer per setting.

## Research

These are deliberately one slice rather than three. They are far apart in the
file and near each other in meaning — the display memory stores it, `which
properties a view shows` reads it, the Display panel writes it — and reading one
without the others is how a reader ends up confident about a premise that
belongs to a different part of the file.

`segmented control` is a shared primitive used by the panel, included here
because the panel is where its closed sets come from.

## Open questions

- Does display state persist per view, per browser, or in the URL? If more than
  one of those, which wins, and is that written down anywhere?
