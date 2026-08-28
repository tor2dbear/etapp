# Etapp

**Roadmap-as-code.** Your roadmap lives in each repo as plain-markdown *pucks* that
both you and your AI agents read and write — aggregated into one **zero-backend
board**. No SaaS, no lock-in, no second source of truth.

> git-native · agent-readable · deploy-your-own

## Why not Linear / GitHub Projects?

They're team-PM tools; Etapp is a roadmap **layer in your code**. The difference
is structural, not featural:

| | Linear / Projects | **Etapp** |
|---|---|---|
| Truth lives | their cloud / GitHub | **in each repo, in git** |
| Format | proprietary / issues | **plain markdown** |
| Backend | SaaS | **none (static)** |
| Multi-repo | clunky | **core** |
| Agent read/write | via API + keys | **direct (md + JSON + CLI)** |
| Lock-in | yes | **none** |

Etapp deliberately **cedes** real-time co-editing, notifications, sprints, and a
comment feed — that's Linear's turf. Building them would need a second database and
make a worse Linear. The moat is being **git-native and agent-native**.

## How it works

```
each repo (roadmap/*.md)  ──harvest──▶  data/roadmap.json · ROADMAP.md
                                              │
                                              ▼
                          index.html + app.js + styles.css  → the board
```

## Deploy your own — only GitHub needed

1. **Use this template** (or fork).
2. `sources.json` — list your repos.
3. `board.config.json` — title, description, source link.
4. **Settings → Pages → Source: "GitHub Actions".**

That's it. The included workflow harvests your repos hourly (and on every push) and
publishes to GitHub Pages — no other account, no secrets, nothing to run. A
**custom domain** (optional, free) goes under Settings → Pages.

**Prefer Cloudflare Workers?** Deploy with `npm run deploy` (`wrangler.jsonc`) —
the npm script runs the bundle guard first, a bare `wrangler deploy` does not
and disable the Pages workflow — the board is the same static bundle either way.

## The convention & the agents

- [`CONVENTION.md`](CONVENTION.md) — the puck standard (one markdown file per item).
- [`AGENTS.md`](AGENTS.md) — how an agent reads and updates the roadmap (no backend,
  no keys): find what's ready (`blockedBy` empty), write via the `roadmap` CLI.

## Author pucks

```bash
npm link                              # → global `roadmap` command
roadmap new "Title" --tags area       # new puck (inbox)
roadmap start|next|later|done <slug>  # move it
```
