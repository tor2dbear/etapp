// The puck format: how a value is spelled in frontmatter, and what a spelling means.
//
// This file is served to the browser as well as imported by the CLI, which is the
// reason it exists apart from the parser. The board writes pucks back to git, the
// `roadmap` command writes the same pucks, and the harvester reads them — and for a
// while each of the three decided quoting for itself. They drifted, as three copies
// of a rule do: the CLI learned that a bare `@frontend` is not YAML while the board
// went on writing it, because `scripts/` is not published and app.js could not reach
// the answer. One served module is what stops that recurring.
//
// No `export`, and that is deliberate. The board must keep rendering from `file://`,
// where a module script does not load at all — so index.html takes this as a classic
// script, which cannot carry exports. A file of plain statements assigning to
// globalThis is *both*: a classic script to a browser, and an ES module with no
// exports to Node, which imports it for the side effect and reads the same global.
//
// Node builtins only, no imports, nothing browser-specific: it has to load in both.
//
// Wrapped in an IIFE because a classic script's top-level `function` and `const`
// land in the page's global scope. Fifteen of them did, which is one more name than
// the line below claims and fourteen more than the page needs: a future script
// declaring `parseList` at top level would have died with "already been declared".

(function () {
  // Strip a trailing YAML comment. Quote-aware, and it runs *before* anything asks
  // what shape a value has — which is the whole point of it being its own function.
  //
  // The checks in parseScalar recognise a form by its *last* character, so a trailing
  // comment hid every one of them: `depends: [a, b] # note` was not an array but the
  // string "[a, b]" (one unsatisfiable blocker instead of two real ones, and a
  // permanent depends-missing flag), and `title: "x" # note` came back with its quotes
  // still on. Stripping the comment afterwards, as this did, is too late by then.
  //
  // A `#` opens a comment when it starts the value or has whitespace before it, which
  // is YAML's own rule. `C# tips` and `owner/repo#slug` therefore survive — inside an
  // inline array too, which is where cross-repo refs live — while `depends: # blockers`
  // is an empty value, not the scalar "# blockers". Reading it as a scalar was worse
  // than losing a nicety: it cleared the sequence below and published an invented
  // blocker by that name. The nicety it costs, a bare `issue: #123`, resolved to null
  // anyway once normalizeNumber saw the NaN, so nothing downstream reads differently.
  // And a quote only opens a quoted run where a value can
  // start: at the beginning, or after an array's `[` or `,`. Anywhere else it is an
  // apostrophe in a bare scalar (`Torbjörn's board`), which must not swallow the
  // comment that follows it.
  function stripComment(raw) {
    const v = raw.trim();
    let quote = "";
    let prev = ""; // last non-space character seen outside a quoted run
    let depth = 0; // how deep inside `[...]`
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (quote) {
        if (quote === '"' && c === "\\" && i + 1 < v.length) { i++; continue; }
        if (c === quote) {
          if (quote === "'" && v[i + 1] === "'") { i++; continue; } // YAML's '' → '
          quote = "";
          prev = c;
        }
        continue;
      }
      if (c === "#" && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i).trim();
      // A quote delimits only where YAML lets it: at the start of the value, or at the
      // start of an item inside a flow array. After a comma in a *bare* scalar it is an
      // ordinary character — `title: Alpha, "beta #1"` is `Alpha, "beta` to YAML,
      // because the ` #` opens a comment, and treating the quote as a delimiter made us
      // keep the rest of a line the format says is a comment.
      if ((c === '"' || c === "'") && (prev === "" || (depth > 0 && (prev === "[" || prev === ",")))) {
        quote = c;
        continue;
      }
      if (c === "[") depth += 1;
      else if (c === "]" && depth > 0) depth -= 1;
      if (!/\s/.test(c)) prev = c;
    }
    return v;
  }

  // Split an inline array's interior on the commas that separate items, ignoring the
  // ones inside a quoted item. A plain `split(",")` tore `"release,one"` in half and
  // handed back `"release` and `one"` — the quoting is there precisely to say the comma
  // belongs to the value, and both readers went straight past it. The CLI shares this
  // so a list means the same thing whichever of them reads it.

  function splitList(inner) {
    const out = [];
    let cur = "";
    let quote = "";
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (quote) {
        cur += c;
        if (quote === '"' && c === "\\" && i + 1 < inner.length) { cur += inner[++i]; continue; }
        if (c === quote) {
          if (quote === "'" && inner[i + 1] === "'") { cur += inner[++i]; continue; } // YAML's '' → '
          quote = "";
        }
        continue;
      }
      if (c === "," ) { out.push(cur); cur = ""; continue; }
      // A quote opens an item only where one can start, which is the same rule
      // stripComment uses: an apostrophe mid-word is not a delimiter.
      if ((c === '"' || c === "'") && cur.trim() === "") quote = c;
      cur += c;
    }
    out.push(cur);
    return out;
  }


  // Used for the items inside an inline array, which are quoted by the same writer and
  // so need the same decoding as a scalar.
  function stripQuotes(s) {
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      try { return JSON.parse(s); } catch { return s.slice(1, -1); }
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
      return s.slice(1, -1).replace(/''/g, "'");
    }
    return s;
  }


  // A list field, decoded into its items — the inverse of what encodeItem writes, and
  // the same steps parseScalar takes on an inline array. The CLI reads lists through
  // this so that a tag is compared as the value it denotes rather than as the spelling
  // it happens to carry: `- "ui"` and `- ui` are the same tag, and a set that held the
  // quotes let `roadmap tag x -ui` report success while removing nothing, and
  // `+ui` write the tag a second time for the board to show twice.
  function parseList(raw) {
    const inner = String(raw == null ? "" : raw).trim().replace(/^\[|\]$/g, "");
    return splitList(inner).map((s) => stripQuotes(s.trim())).filter((s) => s !== "");
  }

  // Writing a value so that it is still YAML — and still this value — when read back.
  //
  // This is a whitelist, and that is the point. Three times now the rule was a list of
  // YAML's hazards, and three times the list was short one: the round trip alone missed
  // reserved indicators (`@frontend`), naming the indicators missed a terminal colon
  // (`foo:`), and neither noticed that a bare `true` comes back a boolean rather than
  // the string the file held. Enumerating what can go wrong in a format this old is
  // open at the wrong end. Enumerating what is plainly safe is closed, and its failure
  // mode is a pair of quotes nobody needed — which cannot corrupt a file.
  //
  // Plainly safe means: opens with a letter, holds nothing but letters, digits, spaces
  // and a few inert punctuation marks, never `<space>#` (a comment), and is not one of
  // the words YAML reads as a boolean or a null.
  const ITEM_PLAIN = /^[A-Za-z][A-Za-z0-9 _./#-]*$/;
  const SCALAR_PLAIN = /^[A-Za-z][A-Za-z0-9 _./#,-]*$/; // a comma is text outside `[...]`
  const COMMENT_OPENS = /\s#/;
  const YAML_WORD = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;

  // Two spellings the convention writes bare on purpose: an integer for `order` and
  // `issue`, an ISO date for `updated`/`created`/`target`. YAML reads them as a number
  // and a date rather than as strings, which is what the format means by them — quoting
  // them would rewrite every existing puck to say something it does not.
  //
  // But that is true of those *fields*, not of those characters. A title or a tag
  // reading `123` means the three characters, and writing it bare hands an external
  // reader the integer instead. So the exception is the caller's to declare: this
  // function only ever sees a value, and a value cannot know which field it is in.
  // A number, spelled so that YAML reads it back as one.
  //
  // This exists because `String()` does not. `move` halves the gap between neighbours
  // to slot a puck between them, and enough halvings give `5e-7` — which YAML 1.1 reads
  // as the *string* "5e-7", not as a number. Its canonical form wants a decimal point
  // in the mantissa, so `5.0e-7` parses and a bare `5e-7` does not.
  //
  // Passing the number through here rather than matching whatever String() produced is
  // the point. The pattern below has now been extended twice, once per spelling it had
  // not anticipated — integers, then decimals, then this. A number does not need to be
  // recognised; it needs to be written.
  function encodeNumber(n) {
    const s = String(n);
    const exp = /^(-?)(\d+)(e[+-]\d+)$/.exec(s);
    return exp ? `${exp[1]}${exp[2]}.0${exp[3]}` : s;
  }

  // Kept for a typed field that still arrives as text — a date does, and so would a
  // rank read back out of a file. It is deliberately the plain spellings only: anything
  // stranger is a number and belongs in encodeNumber above.
  const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
  const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function bareIsSafe(s, plain, typed) {
    if (s !== s.trim() || s === "") return false;
    if (typed && (PLAIN_NUMBER.test(s) || PLAIN_DATE.test(s))) return true;
    return plain.test(s) && !COMMENT_OPENS.test(s) && !YAML_WORD.test(s);
  }

  // A list item, which sits inside `[...]`, so a comma would end it and a bracket or
  // brace would open something else.
  // A list item. `tags` and `depends` hold strings and nothing else, so no field here
  // ever wants the number-or-date reading.
  function encodeItem(value) {
    const s = String(value);
    return bareIsSafe(s, ITEM_PLAIN, false) ? s : JSON.stringify(s);
  }

  // A scalar after `key:`, where a comma is ordinary text — `title: Hello, world` needs
  // no quotes and should not get them.
  // A scalar after `key:`, where a comma is ordinary text — `title: Hello, world` needs
  // no quotes. `typed` says the field's schema is a number or a date rather than a
  // string; see bareIsSafe.
  function encodeScalar(value, typed = false) {
    const s = String(value);
    return bareIsSafe(s, SCALAR_PLAIN, typed) ? s : JSON.stringify(s);
  }


  // Which lines a field occupies. A block sequence is one field written across several
  // lines, so anything editing a field has to see all of them — replacing the header
  // alone strands `- alpha` / `- beta` beneath a new inline value, where the parser
  // ignores them and the blockers vanish.
  //
  // Both writers share this. They each had their own copy, and the copies had already
  // begun to differ in how they tested emptiness; app.js still carried the older answer
  // after the CLI learned the newer one. `lines` is the file split on newlines, `start`
  // and `end` bound the frontmatter block, exclusive of the fences.
  function fieldSpan(lines, start, end, key) {
    for (let i = start; i < end; i++) {
      if (lines[i].indexOf(key + ":") !== 0) continue;
      // Items continue a key only while its own value is empty, which is the rule the
      // parser uses to decide the same thing — the two have to agree on where a field
      // ends. A comment counts as empty: `depends: # blockers` opens a sequence.
      const value = stripComment(lines[i].slice(key.length + 1));
      let last = i;
      if (value === "") {
        // A blank or comment line does not end a sequence — the parser skips it and
        // goes on collecting — so the span reaches past it to the last item, and no
        // further: a blank line before the next key belongs to that key, not this one.
        for (let j = i + 1; j < end; j++) {
          if (/^\s*-\s+/.test(lines[j])) { last = j; continue; }
          if (!lines[j].trim() || lines[j].replace(/^\s+/, "").charAt(0) === "#") continue;
          break;
        }
      }
      return { index: i, count: last - i + 1, value };
    }
    return null;
  }

  // The one name both sides reach for. `__ROADMAP__` next to it on the page is the
  // same idea: a global is what a classic script can offer.
  // ── which spelling a *field* gets, and how a field is edited in place ────────
  //
  // The half that was missing. This file owned how a *value* is spelled and stopped
  // there, so the decision one level up — which encoder a given key needs, and what a
  // frontmatter edit has to tolerate — stayed in `scripts/roadmap.mjs`, where the board
  // cannot reach it. It reached for the list encoder and wrote every scalar with
  // `String(value)` instead.
  //
  // Measured against PyYAML: seven of eight fields the board wrote came back wrong.
  // `parent: release #1` read as `release`, `agent: true` as a boolean, `owner: no` as
  // `false`, `owner: 2026-01-01` as a date — and `priority: @urgent` and `parent: a: b`
  // produced a file PyYAML refuses outright, committed to somebody else's repo. Every
  // one of those is a defect the CLI had already been fixed for, twice, in #1 and #2.

  // The fields whose schema is not a string: a number for the first two, a date for the
  // rest. Only these may write a digit string bare — everywhere else `123` is text.
  const TYPED_FIELDS = new Set(["order", "issue", "updated", "created", "target"]);

  function formatValue(key, value) {
    // Inline arrays (tags, depends) — one shape for every list field. Each item is
    // encoded rather than pasted in, so a value that needs quoting gets it back on the
    // way out instead of being written bare and read as something else next time.
    if (Array.isArray(value)) return `[${value.map(encodeItem).join(", ")}]`;
    if (key === "tags") return "[]";
    // A number is written as a number, without a detour through a string that something
    // then has to recognise as numeric again.
    if (typeof value === "number" && Number.isFinite(value)) return encodeNumber(value);
    return encodeScalar(value, TYPED_FIELDS.has(key));
  }

  // A BOM is dropped before the fence check and carried back out, because the parser
  // tolerates one and an editor that emits one otherwise makes a puck readable but not
  // editable. The CLI learned this in #1; the board's own copy never did, and refused
  // every edit to such a puck with "no frontmatter".
  function splitText(text) {
    const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    return { bom, nl, lines: text.slice(bom.length).replace(/\r\n/g, "\n").split("\n") };
  }

  function frontmatterRange(lines) {
    if (lines[0] !== "---") return null;
    for (let i = 1; i < lines.length; i++) if (lines[i] === "---") return [1, i];
    return null;
  }

  // Write one field, preserving the rest of the file byte for byte. `null` back means
  // the text carries no frontmatter; each caller says so in its own words.
  function setField(text, key, value) {
    const { bom, nl, lines } = splitText(text);
    const range = frontmatterRange(lines);
    if (!range) return null;
    const line = `${key}: ${formatValue(key, value)}`;
    const at = fieldSpan(lines, range[0], range[1], key);
    // The new value is the whole field, so a sequence's items go with the header.
    if (at) lines.splice(at.index, at.count, line);
    else lines.splice(range[1], 0, line); // insert before closing fence
    return bom + lines.join(nl);
  }

  function removeField(text, key) {
    const { bom, nl, lines } = splitText(text);
    const range = frontmatterRange(lines);
    if (!range) return null;
    const at = fieldSpan(lines, range[0], range[1], key);
    if (at) lines.splice(at.index, at.count); // a sequence's items go with its header
    return bom + lines.join(nl);
  }

  // Replace the body, keeping the frontmatter byte-identical. Here rather than in the
  // board because it asks the same question `setField` does — where does the
  // frontmatter end, and what is the file's BOM and line ending — and it answered it
  // separately for exactly as long as it took `setField` to move: a puck with a BOM
  // became field-editable and still refused "Edit body". The body is normalised the
  // way the board has always normalised it, so this is the same edit, not a new one.
  function replaceBody(text, newBody) {
    const { bom, nl, lines } = splitText(text);
    const range = frontmatterRange(lines);
    if (!range) return null;
    const head = lines.slice(0, range[1] + 1);
    const body = String(newBody).replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
    return bom + head.concat([""], body, [""]).join(nl);
  }

  globalThis.__PUCK_FORMAT__ = {
    stripComment,
    splitList,
    stripQuotes,
    parseList,
    encodeNumber,
    encodeItem,
    encodeScalar,
    fieldSpan,
    formatValue,
    setField,
    removeField,
    // Exported because the readers need the same fence the writers use. They had
    // private copies — `roadmap.mjs` for `getField`/`getList`, app.js for
    // `replaceBody` — and a copy of a rule is a rule that will disagree. It already
    // did: `replaceBody` kept the BOM-blind fence, so once `setField` learned to
    // tolerate one, a puck with a BOM became field-editable and still refused
    // "Edit body".
    splitText,
    frontmatterRange,
    replaceBody,
  };
})();
