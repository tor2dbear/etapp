---
title: Review search, command palette and keyboard
status: later
tags: [review, ui]
updated: 2026-09-21
created: 2026-09-21
parent: read-the-board-surface-by-surface
order: 100
---

## Goal

**app.js 8008–8509 — 502 lines.**

- 8008–8222 `search + title suggestions`
- 8223–8267 `⌘K command palette (holds the search input)`
- 8268–8374 `keyboard shortcuts (Linear-inspired)`
- 8375–8509 `shortcut help overlay ("?")`

**Done looks like:** the shortcut table and the help overlay agree, and free-text
search behaves the same whether it arrives from the palette or from a `?q=` link.

## Research

⌘K's tag counts were one of the three reachable crashes #9 found — `tag: toString`
died there the same way the sidebar did. The tables are fixed; what this slice
reads is the surface above them.

The help overlay and the shortcut handler are two lists that must agree with
nothing enforcing it — the same shape as the judge tags / expect strings problem
called out in #7, and a candidate for a gate rather than a reading.

## Open questions

- Is the shortcut list derivable from the handler, so the overlay cannot drift?
