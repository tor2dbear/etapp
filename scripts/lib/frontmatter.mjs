// Minimal, dependency-free YAML-frontmatter parser.
// Handles exactly the subset the roadmap convention uses:
//   scalars (quoted or bare), integers, dates, inline arrays [a, b, c], and the
//   block-sequence spelling of the same list (`key:` then `  - item` lines).
// The body is everything after the closing `---`.

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
export function stripComment(raw) {
  const v = raw.trim();
  let quote = "";
  let prev = ""; // last non-space character seen outside a quoted run
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
    if ((c === '"' || c === "'") && (prev === "" || prev === "[" || prev === ",")) {
      quote = c;
      continue;
    }
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

function parseScalar(raw) {
  const v = stripComment(raw);
  if (v === "") return "";
  // Quoted forms come first, and that order is the point: a quoted value that happens
  // to open with `[` is a string, not a list.
  //
  // Double-quoted is JSON-decoded because that is what the writer produces —
  // `formatValue` in the CLI quotes a title via `JSON.stringify`. Reading it back with
  // a plain slice left the escapes in the value, so a title with a quote in it came
  // back corrupted and got written corrupted the next time. The round trip has to
  // close on the same rules at both ends.
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return stripQuotes(v);
  }
  // Inline array: [a, b, c] — only for genuinely unquoted values, which is why it
  // comes after the quoted forms. parseList is the one definition of what a list
  // decodes to; writing the same four steps out here again is how the two spellings
  // of a list would drift apart, which is the thing this file exists to prevent.
  if (v[0] === "[" && v[v.length - 1] === "]") return parseList(v);
  // Bare scalar. The comment is already gone.
  return v;
}

// Used for the items inside an inline array, which are quoted by the same writer and
// so need the same decoding as a scalar.
export function stripQuotes(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * @param {string} text  full markdown file contents
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function parseFrontmatter(text) {
  // Strip a leading UTF-8 BOM before the fence check. With one in place the file does
  // not start with `---`, so the whole frontmatter block was returned as body and the
  // puck lost every field it had — silently, and only for editors that emit one.
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { data: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { data: {}, body: normalized };
  }
  const block = normalized.slice(4, end);
  // Body starts after the closing fence line.
  const afterFence = normalized.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : normalized.slice(afterFence + 1);

  const data = {};
  // The key a block sequence would continue: set when a key line carries no inline
  // value, cleared by any key that does. Only such a key can collect `- item` lines,
  // so the two spellings of a list never mix into one another.
  let seqKey = null;
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // A block sequence item, tested before the `key:` split: `- owner/repo#slug` has
    // no colon and used to be skipped outright, which is how `depends:` written the
    // ordinary YAML way became the empty string. Downstream that reads as falsy — so
    // the puck published as *ready* while its author had declared blockers, with no
    // flag anywhere. Silent, and in the one direction that matters.
    if (seqKey !== null) {
      const seq = /^\s*-\s+(.*)$/.exec(line);
      if (seq) {
        if (!Array.isArray(data[seqKey])) data[seqKey] = [];
        const item = stripQuotes(stripComment(seq[1]));
        if (item !== "") data[seqKey].push(item);
        continue;
      }
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    data[key] = parseScalar(line.slice(idx + 1));
    seqKey = data[key] === "" ? key : null;
  }
  return { data, body: body.trim() };
}

// A list field, decoded into its items — the inverse of what encodeItem writes, and
// the same steps parseScalar takes on an inline array. The CLI reads lists through
// this so that a tag is compared as the value it denotes rather than as the spelling
// it happens to carry: `- "ui"` and `- ui` are the same tag, and a set that held the
// quotes let `roadmap tag x -ui` report success while removing nothing, and
// `+ui` write the tag a second time for the board to show twice.
export function parseList(raw) {
  const inner = String(raw == null ? "" : raw).trim().replace(/^\[|\]$/g, "");
  return splitList(inner).map((s) => stripQuotes(s.trim())).filter((s) => s !== "");
}

// Writing a value so that it is still YAML — and still this value — when read back.
//
// The round trip alone was the wrong test. It asks "does *our* reader return what we
// put in", which `@frontend` passes: this parser has no notion of YAML's reserved
// indicators, so it reads a bare `@frontend` happily and the check declared it safe.
// Anything else opening the same puck disagrees — `tags: [@frontend, new]` is not
// YAML at all. These files are plain markdown that other tools read; a file only our
// own reader can parse is how a format stops being a format.
//
// So the rule is YAML's: a plain scalar may not open with an indicator, may not carry
// `: ` or ` #`, and may not lead or trail whitespace. The round trip stays as the last
// clause, because it still catches what is specific to us (a value that looks quoted).
const YAML_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_UNSAFE = /: |\s#|^\s|\s$/;

function encodable(s) {
  return s !== "" && !YAML_INDICATOR.test(s) && !YAML_UNSAFE.test(s) && stripQuotes(stripComment(s)) === s;
}

// A list item, which sits inside `[...]`, so the flow indicators matter too: a comma
// would end it and a bracket or brace would open something else.
export function encodeItem(value) {
  const s = String(value);
  return encodable(s) && !/[,[\]{}]/.test(s) ? s : JSON.stringify(s);
}

// A scalar after `key:`, where a comma is ordinary text — `title: Hello, world` needs
// no quotes and should not get them.
export function encodeScalar(value) {
  const s = String(value);
  return encodable(s) ? s : JSON.stringify(s);
}
