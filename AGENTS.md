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
target, issue, issueState, order, depends[], blockedBy[], parent, parentRef,
children[], progress, signals[], sourceUrl, … }`.

- `signals[]` — drift flags (`stale` / `issue-closed` / `issue-open` /
  `target-passed` / `parent-missing` / `parent-cycle`): the declared status
  disagrees with reality.
- `blockedBy[]` — same-repo dependencies not yet `done`. **Empty = unblocked.**
- `parent` — the etapp as *written* (`slug`, or `owner/repo#slug`); `parentRef` is
  it resolved to an id, or `null` when it doesn't resolve. `children[]` and
  `progress` (`{done,total}`) are derived from the children's `parent:` lines —
  a puck with children **is** the etapp.

**"What should I work on?"** — unblocked active pucks:

```bash
node -e "const d=require('./data/roadmap.json'); \
console.log(d.items.filter(i=>['now','next'].includes(i.status) && !(i.blockedBy||[]).length).map(i=>i.id).join('\n'))"
```

**"What needs attention?"** — items where `signals.length > 0`.

## Query grammar

The board reads the same query language, so you can answer with a **link** instead
of a list: `<board-url>/?q=<query>`. Terms are ANDed; values inside one term are
ORed; `-` negates.

```
status:now,next        field match — a value list means "or"
-status:done           negation
repo:pia-terminal      short name, owner/name or display name all work
tag:ui  label:ui       tags (aliases: label, labels, tags)
agent:backend          discipline routing (alias: discipline)
owner:tor2dbear        the owner field
priority:high          urgent | high | medium | low
issue:42               the linked issue number
target:<=2026-11-30    the horizon (updated/created take the same operators)
parent:auth            the etapp — slug, id or owner/repo#slug (alias: etapp)
"grep context"         free text over title, body, tags and repo name
```

`is:` is the namespace for states that are **derived**, not stored — giving each a
field of its own would invent a second truth:

| Term | True when |
|---|---|
| `is:ready` | `status` is `now`/`next` **and** `blockedBy` is empty |
| `is:blocked` | `blockedBy` is non-empty |
| `is:flagged` | the puck has any drift signal |
| `is:stale` | its signals include `stale` |
| `is:adapted` | the source isn't native pucks |
| `is:done` | `done` **or** `cancelled` (the archive) |
| `is:etapp` | the puck has children — it *is* an etapp |
| `is:orphan` | neither a parent nor children: outside every etapp |

The board's own views are just queries — `Ready` is `is:ready`, `Needs attention`
is `is:flagged` — so anything a view shows, a query can name.

URL parameters: `?q=` is the filter, `?view=` names a built-in view (`all`/`ready`/
`inbox`/`attention`), `?group=` the column field, `?layout=` board or list, `?sort=`
the ordering, `?done=1` shows the archive, `?empty=0` hides empty columns, and
`#<repo>/<slug>` opens one puck. They compose:
`?q=agent:backend+repo:pia-terminal&view=ready&group=target`.

**Saved views** are the same parameters, named, in `board.config.json` — the board
lists them in its sidebar. That file is configuration, not truth, so this adds no
second source; the pucks remain the only data:

```jsonc
{ "views": [
  { "name": "This month", "q": "target:<=2026-11-30 -status:done", "group": "target", "sort": "target" },
  { "name": "Ready for AI", "q": "is:ready agent:backend" }
] }
```

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
roadmap target <slug> 2026-11       # horizon: a date, or a month = its last day
roadmap move <slug> --before <slug> # manual rank within the status column
roadmap renumber [--status now]     # tidy order back to 10, 20, 30 …
roadmap parent <slug> <etapp-slug>  # put it in an etapp (--clear to take it out)
roadmap agent <slug> <discipline>   # route to a discipline agent (--clear to remove)
roadmap list [--status now]         # overview
```

Or edit `roadmap/<slug>.md` directly — the `install-hook` pre-commit hook bumps
`updated` on hand edits too. Then commit; the aggregator re-harvests on schedule.

## Dependencies

Declare `depends: [slug, …]` (same-repo slugs) in frontmatter. The board shows ⛔
until every listed puck is `done`; agents read the resolved `blockedBy[]` to know
what's ready. Use it to sequence work.

## Etapps (the level above)

`parent: <slug>` (or `owner/repo#slug`) puts a puck in an etapp. Only the child
stores anything — the etapp is just the puck being pointed at, and its
`children[]`/`progress` are derived at harvest. So there is no epic record to create,
nothing to keep in sync, and a whole etapp of work is `?q=parent:<slug>`.

A `parent:` that names nothing, or that closes a loop, is flagged
(`parent-missing` / `parent-cycle`) and ignored — never silently repaired.

## Closing gaps the right way (GitHub primitives, not new stores)

- **Discussion** → the linked `issue:` (GitHub comments/notifications).
- **Ownership** → an `owner:` frontmatter field, not an assignee database.
- **Permissions** → git/PR review; a write is a commit.

## Invariants — don't break these

- Never hand-edit `data/roadmap.json`, `data/roadmap.js`, `ROADMAP.md`.
- Never add a second source of truth.
- The hierarchy points **up only**: a child names its `parent`. Never write a
  `children:` field — it's derived, and a stored copy could disagree.
- Four orthogonal axes, never conflated: `status` = which column (`inbox →
  now/next/later → done`), `order` = the place in it (manual rank, lower first,
  unset sinks to the bottom), `priority` = how much it matters (a label to filter
  and sort by, not the default ordering), `target` = roughly when in the calendar
  (a horizon, not a deadline). `CONVENTION.md` has the table.
