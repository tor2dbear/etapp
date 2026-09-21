---
title: Replace the hand-written lexer with a real parser
status: later
tags: [ci, tooling]
updated: 2026-09-21
created: 2026-09-21
order: 20
---

## Goal

`scripts/check-lookups.mjs` asserts that app.js builds every lookup through
`table()` / `dict()`, and the central claim is a rule about the source: **an
empty object literal is not written in this file**. To check that, the gate has
to know what each `{` in app.js means — a literal, a block, a function body —
and it answers that with a lexer written by hand out of regular expressions:
brace-kind stacks, a regex-vs-division rule, an identifier alphabet, string and
comment masking. 2 223 lines, against 282 changed lines of app.js.

Replace the reading with a syntax tree. Then a literal is an `ObjectExpression`
and a block is a `BlockStatement` — two node types that cannot be confused,
because they never occur in the same position.

**Done looks like:** the same claims hold, made against a tree; the lexer, the
brace classifier and the comment-blanking floor are gone; reach goes from 287 of
334 variable-keyed reads to all of them; `check-checks.mjs` still breaks every
lookups claim on purpose and still catches each one by name.

Three altitude findings from the review fold into this and need no puck of their
own: scope resolution, a token stream, and the fixture carrying its verdicts as
data. All three are things a parser either gives outright or makes trivial.

## Research

Measured 2026-09-21, Node v22.22.2:

- Node bundles **acorn 8.15.0** at `internal/deps/acorn/acorn/dist/acorn`, but it
  is **not reachable without `--expose-internals`** — plain `require` gives
  `MODULE_NOT_FOUND`. It is an unsupported internal path that can change in a
  patch release.
- With the flag, `acorn.parse(app.js)` takes **93 ms** and finds **365 object
  literals, 0 of them empty** — the gate's central claim, reproduced by a nine-line
  tree walk, with the same answer the 2 223-line gate gives in 0.9 s.

Why this is worth doing rather than continuing: across 46 review rounds on PR #9,
**22 findings were the gate going red on valid code** (`if (true) /{}/`,
`class Empty {}`, `case 1: {}`, `await /{}/`, `({} = source)`, `lookup[1e3]`), and
exactly **one** finding was a live defect in app.js. Each round added one more
hand-written rule for one more spelling of JavaScript. That tail does not
converge. A parser has all of those cases solved already — ESLint is this same
idea (a rule about how code is written) and it delegates the reading to a fork of
acorn rather than doing it by hand.

Three ways in, and the middle one looks right:

| | Cost | Risk |
|---|---|---|
| `--expose-internals` | nothing added | unsupported API; can break on a Node upgrade; CI must pin the Node version |
| **Vendor acorn into `scripts/lib/`** | one third-party file in the repo | none of the kind the rule guards against: no install step, no lockfile, no build-time supply chain; MIT |
| devDependency + `npm ci` | a build step | this is what the zero-build rule actually forbids |

The repo rule is "zero-build and dependency-free, Node builtins only in
`scripts/`". Its purpose is that nobody has to install anything and there is no
supply chain to watch. A checked-in file breaks neither — the same reasoning by
which `format.js` is carried in the source instead of generated.

## Open questions

- **Vendor or `--expose-internals`?** The decision this puck is waiting on. Vendoring
  needs the dist file's actual size measured first, and a note in `CLAUDE.md`
  amending the dependency rule to say what is allowed and why.
- Does the 144/95 fixture survive as-is? Most of its lines exist to pin lexer
  behaviour that will no longer exist. The ones worth keeping are those that
  describe *the rule* rather than the reading.
- The gate currently states its boundaries in the success line ("cannot see
  through a call into a `return { … }`, cannot follow `a = b.c`, knows no
  scopes"). With a tree, two of those three go away; the line has to be rewritten
  to claim exactly what is then true, and not more.
