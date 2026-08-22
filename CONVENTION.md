# The roadmap convention — one standard for every repo

This is the **canonical, cross-repo standard** for how a roadmap looks inside any
of the projects. It is the contract the aggregator in this repo reads. Adopt it
in a project and its roadmap shows up here natively — no adapter, full fidelity.

The truth is plain markdown files **in each project's own repo**. Readable in an
editor, greppable by an agent (`cat`/`grep`), and harvested by the aggregator for
the visual board. No lock-in — it is just files.

> **The field names and the status values below are an interface.** Tools read
> them, so keep them **exactly** as specified and in English. The body text you
> write freely, in any language.

See [`templates/`](templates/) for a drop-in `roadmap/README.md` + `puck.md`, and
any repo already using `pucks` for real examples.

---

## One item = one file

A roadmap item is called a **puck** ("one thing we want to build"). Each puck
lives in its own file under `roadmap/`:

```
roadmap/
  README.md            ← this convention, copied into the repo (not a puck)
  grep-context.md      ← a puck
  cloud-sync.md        ← a puck
```

**The filename (the slug) is the puck's stable ID and anchor link.** Don't rename
it without reason. Use short, descriptive, hyphenated slugs. Skip number prefixes
(`001-`) — ordering is the `order` field's job, not the filename's.

When a puck needs **attachments** (sketches, images, several docs), promote it
from a file to a folder with the same slug:

```
roadmap/
  nano-multibuffer/
    README.md          ← the puck itself (same format as a file-puck)
    layout-sketch.png
```

The rule the aggregator follows: **a puck is either `roadmap/<slug>.md` or
`roadmap/<slug>/README.md`.** Nothing else changes when you promote one.
(`roadmap/README.md` at the top is the convention doc, not a puck — it is
skipped.)

---

## Frontmatter (the interface)

Every puck opens with YAML frontmatter:

```markdown
---
title: "nano: multi-buffer"
status: next
tags: [editor]
updated: 2026-07-17
issue: 42
order: 10
---
```

| Field     | Required | Meaning |
|-----------|----------|---------|
| `title`   | yes      | Short heading for the board. Quote it if it contains a `:`. |
| `status`  | yes      | One of `inbox`, `now`, `next`, `later`, `done`, `cancelled`. See lifecycle. |
| `priority`| no       | One of `urgent`, `high`, `medium`, `low`. Omit for "no priority". Orthogonal to `status` — *when* vs *how much it matters*. Renders as a signal badge; the board can sort by it. |
| `updated` | yes      | `YYYY-MM-DD`, last touched. The aggregator sorts and shows freshness on it. |
| `created` | no       | `YYYY-MM-DD`. Usually omit — the aggregator derives it from the file's first commit. `roadmap new` stamps it for you. Set it by hand only to override that. |
| `target`  | no       | `YYYY-MM-DD` — the horizon: roughly when this should land. Omit for "no horizon" (most pucks). Orthogonal to `status` and `priority`: *when* in the calendar, not *when* in the queue. The board shows it coarsely ("Nov 2026") and flags it once it has passed. Set with `roadmap target <slug> <date>` — a bare month (`2026-11`) means the end of that month. |
| `tags`    | no       | Areas, e.g. `[editor]`, `[auth]`. Inline array. Used for filtering. |
| `issue`   | no       | The working issue number in the repo, when the puck is in progress. |
| `order`   | no       | Manual order **within** a status column (lower = higher up). Falls back to `updated`. |
| `parent`  | no       | The etapp this puck belongs to: another puck's slug in the same repo, or `owner/repo#slug` anywhere on the board. One line pointing **up** — the level above is a puck with children, not a new file type. Set with `roadmap parent <slug> <parent-slug>` (`--clear` to take it out). |
| `depends` | no       | Inline array of the pucks this one is blocked by — a slug in the same repo, or `owner/repo#slug` anywhere on the board, e.g. `[deploy-simplification, tor2dbear/pia-terminal#vfs]`. The board shows ⛔ until every listed puck is settled. Set with `roadmap depends <slug> +<ref> -<ref>`. |
| `owner`   | no       | GitHub handle of the owner, e.g. `octocat`. Renders as an avatar on the card and a profile link in the modal. A field, not an assignee database. |
| `agent`   | no       | Discipline this puck is routed to (`backend`, `design`, `research`, …) — the PO-layer's routing state. A handle, not an orchestrator: a runner reads it from git and picks the matching `agents/<name>.md` profile. Set with `roadmap agent <slug> <name>`. |

---

## Body

Free markdown under the frontmatter. Recommended skeleton — drop what you don't
need:

```markdown
## Goal
One sentence on why this puck exists.

## Research
Links, options weighed, decisions and why. The stuff that is otherwise homeless.

## Open questions
- ...

## Delivered
What shipped, and what was consciously left out. (Fill this in when `status: done`.)
```

The point of one file per puck: **the research lives in the puck from day one**
instead of cluttering a shared file. A puck can be as thick as it likes without
disturbing any other.

---

## Lifecycle (`status`)

```
inbox  →  now / next / later  →  done
                              ↘  cancelled
```

- **`inbox`** — raw material and research that is not yet a decision. Put
  pre-research here directly; the aggregator shows `inbox` muted in its own
  column. Nothing here is a promise.
- **`now`** — actively in progress right now. Keep it short.
- **`next`** — up next, decided.
- **`later`** — want to do, not soon.
- **`done`** — shipped. The aggregator collapses/archives it. Keep the file as
  history; don't delete it.
- **`cancelled`** — decided against ("won't do"). A terminal state like `done`:
  hidden from the active board (shown via the same "show done & cancelled"
  toggle), struck through, exempt from drift/staleness. Keep the file so the
  decision stays on record; use it instead of deleting when the reasoning is
  worth keeping (delete is for genuine junk).

A puck usually starts in `inbox`, is promoted to `now/next/later` once it is an
actual decision, and lands in `done`. Update `updated` every time you touch the
status or the content.

### Priority (`priority`)

Optional and orthogonal to `status`: `status` says *when* (now/next/later),
`priority` says *how much it matters* (`urgent` › `high` › `medium` › `low`).
Omit the field entirely for "no priority" — most pucks won't need one. Set it
with `roadmap priority <slug> <level>` (`--clear` to remove).

### The four axes, in one place

They overlap in conversation but never in the data. Written down so nobody has to
guess which one to reach for:

| Field | Answers | Shape |
|---|---|---|
| `status` | *Which column?* | the ladder: `inbox → now/next/later → done`/`cancelled` |
| `order`  | *Where in that column?* | a number, lower = higher up; unset = below every ranked puck |
| `priority` | *How much does it matter?* | a label you filter and sort by — **not** the default ordering |
| `target` | *Roughly when in the calendar?* | a date, optional; a horizon, not a deadline |

`order` is the manual rank. Set it by saying where a puck goes relative to another —
`roadmap move <slug> --before <other>` — or by dragging a card to a position on the
board while the ordering is **Manual**. Any other ordering derives the position from
a field, so hand-placing is switched off there rather than silently ignored.

Gaps are sparse (10, 20, 30 …) so a move can slot between two neighbours by writing
**one** file. When a gap closes the midpoint goes decimal; `roadmap renumber` tidies
a column back to round numbers in one local pass.

### The horizon (`target`)

A third, independent axis: `status` is *when in the queue*, `priority` is *how much
it matters*, `target` is *roughly when in the calendar*. Omit it for "no horizon" —
most pucks have none, and that is the normal case.

It is stored as an exact date so it sorts and compares (`target:<=2026-11-30`), but
the board shows it coarsely — "Nov 2026", or a countdown once it's close — because a
horizon is not a deadline promise. When the date passes and the puck isn't `done`,
the board flags it (⚠) so a human moves the horizon or lands the work; nothing is
ever rewritten for you.

This is deliberately *not* sprints, story points or capacity planning — those stay
off the roadmap. It is one optional field that answers "when, roughly?".

### Dependencies (`depends`)

`depends:` is the sequencing axis: *what has to land before this one can start.*
Same reference form as `parent` — a slug at home, `owner/repo#slug` across repos,
which is the whole point of a cross-repo board:

```yaml
depends: [deploy-simplification, tor2dbear/pia-terminal#vfs]
```

Only the blocked puck stores anything. The harvester resolves the list into
`blockedBy` — everything declared that isn't settled yet, so **empty means ready** —
and the reverse edge `blocks` (what this puck holds up), which is its exact mirror.
There is deliberately no `blocks:` field to author: two fields pointing at each other
is a second source of truth in miniature. A `done` or `cancelled` puck waits for
nothing and holds nothing up, so its edges count in neither direction.

A dependency that names nothing keeps blocking and is flagged `depends-missing`.
That matters: dropping it would call the puck ready while its author believes it is
blocked — an unknown blocker is not a finished one. A loop is flagged
`dependency-cycle` on every puck in it; unlike an etapp parent, no single link can be
cut to fix it, so the edges stand and a human decides. A puck depending on itself is
the same error with one node, kept rather than quietly discarded.

Set it with `roadmap depends <slug> +<ref> -<ref>` (`--clear` empties it), or from
the puck's **Blocked by** row on the board, which offers a searchable list of pucks
and writes the reference form for you — a loop or a duplicate isn't in the list to
begin with.

### The level above (`parent`)

Linear has projects *and* issues; here there is one shape. A puck that other pucks
point at **is** the etapp — the level above is a relationship, not a second record
type. That keeps the rule intact: one file per item, and no field that has to agree
with a field somewhere else.

```yaml
# roadmap/logga-in.md
parent: auth          # a slug in this repo …
parent: tor2dbear/pia-terminal#auth   # … or a puck anywhere on the board
```

Only the child stores anything. `children` and the rollup ("3/7 done") are derived
at harvest from the `parent:` lines pointing at a puck — a stored `children:` list
could disagree with them, and two truths is the one thing this product doesn't do.
The rollup counts children's real statuses, so an etapp can't claim progress its
pucks don't have.

Depth isn't limited, but two levels is the point: an etapp with its pucks. A link
that names a puck that doesn't exist, or that closes a loop, is flagged (⚠) and
ignored rather than half-applied — the board never rewrites your file to fix it.

On the board it's a grouping like any other: **Display → Grouping → Etapp** turns the
columns into etapps, and dragging a card between them writes that one `parent:` line.
The **Etapp** row picks from a searchable list rather than asking you to spell a slug;
a puck that would close a loop is left out of it.

---

## Authoring helper

You never have to write frontmatter by hand. From a project repo:

```bash
roadmap new "Title" --tags area   # create a puck in inbox
roadmap start|next|later|done <slug>
roadmap tag <slug> +add -remove
roadmap priority <slug> <level>    # urgent|high|medium|low (--clear to remove)
roadmap target <slug> 2026-11      # the horizon; a month = its last day
roadmap parent <slug> <etapp-slug> # put it in an etapp (--clear to take it out)
roadmap depends <slug> +a -b       # edit blockers (--clear to remove all)
roadmap list                       # overview
roadmap install-hook               # auto-bump `updated` on every commit
```

Every command sets `updated` for you; the hook keeps it fresh even for hand
edits. See the aggregator's README for install. Agents can call the same
commands.

## For agents

- Working on a specific puck? Open `roadmap/<slug>.md` — everything about it
  (goal, research, open questions) is there.
- Want the whole picture for the repo? `ls roadmap/` and read the frontmatter.
- Starting a puck: set `status: now`, link the `issue:` if there is one, and
  update `updated`. When shipped: `status: done` and fill in `## Delivered`.
- New undecided ideas go in `inbox`, not in `now/next/later`.

---

## Adopting this in a project (migration)

Until a repo adopts pucks, the aggregator best-effort **adapts** whatever it
finds (a `## Roadmap` checklist, a `## Vidare`/"Next" prose section) and marks
those cards `adapted`. To get full fidelity:

1. Copy [`templates/roadmap-README.md`](templates/roadmap-README.md) to the
   repo's `roadmap/README.md`.
2. For each roadmap item, create `roadmap/<slug>.md` from
   [`templates/puck.md`](templates/puck.md). Map existing states:
   shipped/`✅` → `status: done`; committed → `next`; wishlist → `later`;
   rough idea → `inbox`.
3. Point the repo's entry in [`sources.json`](sources.json) at the new folder:
   set `"adapter": "pucks"` and `"path": "roadmap"` (drop `section`).
4. Re-run the harvest. The cards flip from `adapted` to native automatically.

No source-repo change is required for the board to work — this migration only
upgrades an `adapted` source to native.
