<!--
Copy this file to your project as roadmap/README.md.
It documents the shared roadmap convention for this repo and points contributors
(and agents) at the canonical spec. Do not edit the field/status names — they are
the interface the cross-repo aggregator reads.
-->

# Roadmap

Planned work lives here as one markdown file per item (a **puck**), each with YAML
frontmatter (`title`, `status`, `updated`, optional `tags` / `issue` / `order`)
and a free-form body for goal, research and open questions. Status flows
`inbox → now / next / later → done`, with `cancelled` as the second terminal
state for work decided against.

- **One puck = one file:** `roadmap/<slug>.md` (or `roadmap/<slug>/README.md`
  when it needs attachments). The slug is the stable ID — don't rename casually.
- **Starting a puck:** set `status: now`, link the `issue:`, bump `updated`.
- **Shipped:** set `status: done` and write a `## Delivered` section. Keep the
  file as history.
- **Decided against:** set `status: cancelled` and write down why. Terminal like
  `done` — kept as history, hidden from the active board by the same toggle. Not
  the same as deleting the file, which loses the decision.
- **New undecided ideas:** put them in `inbox`.
- **A puck is a promise about the future.** If nobody could ever pick it up — because
  it is already done — it is not a puck. Fixed in the session you are in? The commit
  message carries it. Found and *not* fixing now? That is a puck.

The truth is these plain files — readable in an editor, greppable by an agent, and
harvested by the multi-repo roadmap board.

**Full spec & field reference:**
https://github.com/tor2dbear/etapp/blob/main/CONVENTION.md
**Starter template:**
https://github.com/tor2dbear/etapp/blob/main/templates/puck.md
