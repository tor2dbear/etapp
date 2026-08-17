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
| `status`  | yes      | One of `inbox`, `now`, `next`, `later`, `done`. See lifecycle. |
| `priority`| no       | One of `urgent`, `high`, `medium`, `low`. Omit for "no priority". Orthogonal to `status` — *when* vs *how much it matters*. Renders as a signal badge; the board can sort by it. |
| `updated` | yes      | `YYYY-MM-DD`, last touched. The aggregator sorts and shows freshness on it. |
| `created` | no       | `YYYY-MM-DD`. Usually omit — the aggregator derives it from the file's first commit. `roadmap new` stamps it for you. Set it by hand only to override that. |
| `tags`    | no       | Areas, e.g. `[editor]`, `[auth]`. Inline array. Used for filtering. |
| `issue`   | no       | The working issue number in the repo, when the puck is in progress. |
| `order`   | no       | Manual order **within** a status column (lower = higher up). Falls back to `updated`. |
| `depends` | no       | Inline array of same-repo puck slugs this one is blocked by, e.g. `[deploy-simplification]`. The board shows ⛔ until every listed puck is `done`. |
| `owner`   | no       | GitHub handle of the owner, e.g. `octocat`. Renders as an avatar on the card and a profile link in the modal. A field, not an assignee database. |

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
```

- **`inbox`** — raw material and research that is not yet a decision. Put
  pre-research here directly; the aggregator shows `inbox` muted in its own
  column. Nothing here is a promise.
- **`now`** — actively in progress right now. Keep it short.
- **`next`** — up next, decided.
- **`later`** — want to do, not soon.
- **`done`** — shipped. The aggregator collapses/archives it. Keep the file as
  history; don't delete it.

A puck usually starts in `inbox`, is promoted to `now/next/later` once it is an
actual decision, and lands in `done`. Update `updated` every time you touch the
status or the content.

### Priority (`priority`)

Optional and orthogonal to `status`: `status` says *when* (now/next/later),
`priority` says *how much it matters* (`urgent` › `high` › `medium` › `low`).
Omit the field entirely for "no priority" — most pucks won't need one. Set it
with `roadmap priority <slug> <level>` (`--clear` to remove).

---

## Authoring helper

You never have to write frontmatter by hand. From a project repo:

```bash
roadmap new "Title" --tags area   # create a puck in inbox
roadmap start|next|later|done <slug>
roadmap tag <slug> +add -remove
roadmap priority <slug> <level>    # urgent|high|medium|low (--clear to remove)
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
