# AGENTS.md — operating this roadmap as an agent

A stable contract for any AI agent to **read and update** the roadmap with no
backend and no API keys. The truth is plain markdown in git; you read the
markdown/JSON and write through the CLI or by editing files. This file is the
agent-agnostic entry point; `CLAUDE.md` adds Claude-Code-specific notes.

## The one rule

> **Write through to git/markdown. Never introduce a second source of truth.**

If a change would need a separate database (comments, assignees, realtime state),
it's the wrong shape — use a GitHub primitive instead (see below).

## Where things live

- **Per-project roadmap** → `roadmap/*.md` in each source repo — the truth. One
  markdown file per item (a *puck*) with YAML frontmatter. Spec: `CONVENTION.md`.
- **This repo (aggregator)** → harvests those into `data/roadmap.json`
  (machine-readable) + `ROADMAP.md` (digest). **Generated — never hand-edit.**

## Reading

`data/roadmap.json` = `{ generatedAt, config, statuses, counts, total, sources[],
items[] }`. Each item: `{ id, repo, slug, title, status, tags[], updated, created,
issue, issueState, order, depends[], blockedBy[], signals[], sourceUrl, … }`.

- `signals[]` — drift flags (`stale` / `issue-closed` / `issue-open`): the
  declared status disagrees with reality.
- `blockedBy[]` — same-repo dependencies not yet `done`. **Empty = unblocked.**

**"What should I work on?"** — unblocked active pucks:

```bash
node -e "const d=require('./data/roadmap.json'); \
console.log(d.items.filter(i=>['now','next'].includes(i.status) && !(i.blockedBy||[]).length).map(i=>i.id).join('\n'))"
```

**"What needs attention?"** — items where `signals.length > 0`.

## Writing

Do it **in the source repo**, via the CLI (it bumps `updated` for you) — never in
the generated files here:

```bash
roadmap new "Title" --tags area     # new puck (inbox)
roadmap start|next|later|done <slug> # move status
roadmap tag <slug> +a -b            # edit tags
roadmap issue <slug> 42             # link a working issue
roadmap owner <slug> <handle>       # set owner (--clear to remove)
roadmap priority <slug> <level>     # urgent|high|medium|low (--clear to remove)
roadmap agent <slug> <discipline>   # route to a discipline agent (--clear to remove)
roadmap list [--status now]         # overview
```

Or edit `roadmap/<slug>.md` directly — the `install-hook` pre-commit hook bumps
`updated` on hand edits too. Then commit; the aggregator re-harvests on schedule.

## Dependencies

Declare `depends: [slug, …]` (same-repo slugs) in frontmatter. The board shows ⛔
until every listed puck is `done`; agents read the resolved `blockedBy[]` to know
what's ready. Use it to sequence work.

## Closing gaps the right way (GitHub primitives, not new stores)

- **Discussion** → the linked `issue:` (GitHub comments/notifications).
- **Ownership** → an `owner:` frontmatter field, not an assignee database.
- **Permissions** → git/PR review; a write is a commit.

## Invariants — don't break these

- Never hand-edit `data/roadmap.json`, `data/roadmap.js`, `ROADMAP.md`.
- Never add a second source of truth.
- `status` is the *when* ladder (`inbox → now/next/later → done`); `order`
  fine-tunes within a column; the optional `priority` field is *how much it
  matters* (`urgent`/`high`/`medium`/`low`), orthogonal to status.
