# CLAUDE.md

This is an **Etapp** board — a read-only aggregator. Roadmap truth lives in each
source repo as plain-markdown pucks (`roadmap/*.md`); this repo harvests them into
`data/roadmap.json` + `ROADMAP.md` and renders the board. **Generated files are
never hand-edited.**

Operating the roadmap as an agent: see [`AGENTS.md`](AGENTS.md) — the read/write
contract (find what's ready via `blockedBy`, update pucks via the `roadmap` CLI).

## Before opening a pull request

Run `/code-review` and then `/simplify` over the PR's **whole range**
(`<base>..HEAD`), fix what they find, and only then open it. Not the last commit —
the range. The defect that cost this repo the most review rounds was correct-looking
code whose premise about a *different file* was wrong, and a per-commit review cannot
see that.

Before, not after, because opening the PR is what triggers Codex. A round of Codex
findings applied on top of an unreviewed diff means Codex's review is now stale and
has to be re-requested by hand, which is two waits instead of none.

They do not make Codex redundant and Codex does not make them redundant — they find
different things. Measured over the seven review PRs: Codex came back clean on #1 and
`/code-review` then found four, including the worst one in the PR; on #7 Codex found
three and `/code-review` then found ten more. Codex is good at enumeration and
platform detail (quoted filenames, `git status` shapes); the skills are good at claims
that are not actually proven.

Skip both only for a diff that cannot change behaviour — prose, a comment, a version
bump. Each skill spawns four parallel agents, which is the wrong price for a typo.
