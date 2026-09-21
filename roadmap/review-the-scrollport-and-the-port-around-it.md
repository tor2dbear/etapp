---
title: Review the scrollport and the port around it
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 50
---

## Goal

**app.js 2520–4445 — 1 926 lines.** The largest unread block in the file.

- 2520–2690 `one axis per drag`
- 2691–2843 `the chrome above the port is not a dead zone`
- 2844–2880 `overlay primitive`
- 2881–4445 `which box actually scrolls`

**Done looks like:** the scroll and drag behaviour is read against what actually
renders, in a browser, across the three payload sizes the other slices used
(138, 500, 2000 pucks) and on both desktop and mobile layouts.

## Research

`which box actually scrolls` at 1 565 lines is the single biggest section in
app.js and its title says why it is hard: which element owns the scroll depends
on layout, and the answer differs between the board and list layouts and between
desktop and mobile.

`cols: {}` at what was then app.js:4875 — the live prototype defect #9 closed —
was inside this region, and it was found by a quality pass rather than by the
check that was written to find it. That is the only part of this surface anyone
has looked at closely.

## Open questions

- Does any of this have a CI-checkable claim at all, or is it browser-only like
  the behavioural half of #9? If browser-only, say so in the success line rather
  than leaving it implied.
