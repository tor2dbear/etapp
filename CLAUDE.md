# CLAUDE.md

This is an **Etapp** board — a read-only aggregator. Roadmap truth lives in each
source repo as plain-markdown pucks (`roadmap/*.md`); this repo harvests them into
`data/roadmap.json` + `ROADMAP.md` and renders the board. **Generated files are
never hand-edited.**

Operating the roadmap as an agent: see [`AGENTS.md`](AGENTS.md) — the read/write
contract (find what's ready via `blockedBy`, update pucks via the `roadmap` CLI).
