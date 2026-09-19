# The board's markdown, held to its contract

CONVENTION names this file as "the text that holds all of this to it". `scripts/md-probe.mjs`
renders it with the board's own renderer — lifted out of `app.js` between the `md:` markers, so
what runs here is the code the browser runs — and `scripts/check-markdown.py` judges the result
with a real HTML parser. Two questions are asked of it: does the documented subset render, and
can a body turn into markup the renderer did not write.

The line above is an `#` heading, which is *outside* the subset. It is here on purpose: the
promise is that an unsupported line is shown as you typed it, on its own line.

## Headings

### Third level

#### Fourth level

##### Fifth level is outside the subset

## Emphasis and code

Plain text with **bold**, *italic*, **bold with *italic* inside**, and `inline code`.

A code span may hold characters that would otherwise be markup: `<div>`, `&amp;`, `"quoted"`.

```
A fenced block. *Nothing* in here is markdown.
<img src=x onerror=alert(1)>
| not | a table |
```

## Lists

- A bullet.
- A bullet whose text is soft-wrapped in the source and should fold
  back into one item.
- A bullet with children:
  - nested by indentation
  - and a second child
    - three deep
- Back at the top level.

1. A numbered item.
2. A second.
   - A bullet nested inside a numbered item.
3. A third.

A list that resumes an author's numbering:

7. Seven.
8. Eight.

## Links

An explicit [link with a label](https://example.com/a), a [**formatted** label](https://example.com/b),
a [`code` label](https://example.com/c), and a bare URL: https://example.com/d — with the sentence's
punctuation left outside it.

A path with asterisks in it must survive whole: https://example.com/a*b*c

## Blockquotes

> A quotation.
> A second line of the same quotation.

## Tables

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Short heading for the board. |
| `status` | yes | One of the lifecycle values. |

Alignment is honoured:

| left | center | right |
|:--|:-:|--:|
| 1 | 2 | 3 |

## Outside the subset

Each of these is shown as typed, on its own line, and never folded into the sentence
around it. That is the one promise CONVENTION singles out.

Before the raw HTML.
<div class="raw">Raw HTML is not interpreted.</div>
After the raw HTML.

Before the image.
![An image is not interpreted](https://example.com/i.png)
After the image.

Before the rule.
---
After the rule.

Before the lone pipe.
| a row with no delimiter row is not a table |
After the lone pipe.

## Text that is meant as text

A body comes from someone else's repo, and an issue body from anyone who can comment.
None of the following may become markup: <script>alert(1)</script>, <img src=x onerror=1>,
&lt;b&gt;, &#x3c;b&#x3e;, and a URL with a quote in it —
https://example.com/x"onmouseover="alert(1)
