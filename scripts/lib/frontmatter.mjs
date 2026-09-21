// Reading a puck's frontmatter. The subset the roadmap convention uses: scalars
// (quoted or bare), integers, dates, inline arrays [a, b, c], and the block-sequence
// spelling of the same list (`key:` then `  - item` lines). The body is everything
// after the closing `---`.
//
// How a value is *spelled* — comments, quoting, list separators, what may be written
// bare — lives in format.js at the repo root, because the board needs those answers
// too and `scripts/` is not published. This file is the reader built on top, and it
// re-exports what it imports so existing callers need not know where the line falls.
import "../../format.js";

// Imported for its side effect, not for named exports: format.js carries none, so
// that index.html can load the same file as a classic script and the board keeps
// working from file://. See the header there.
const {
  encodeItem,
  encodeNumber,
  encodeScalar,
  fieldSpan,
  formatLine,
  formatValue,
  frontmatterRange,
  itemKey,
  parseList,
  refFor,
  refKey,
  removeField,
  replaceBody,
  setField,
  splitText,
  stripComment,
  stripQuotes,
} = globalThis.__PUCK_FORMAT__;

export {
  encodeItem, encodeNumber, encodeScalar, fieldSpan, formatLine, formatValue, frontmatterRange,
  itemKey, parseList, refFor, refKey, removeField, replaceBody, setField, splitText,
  stripComment, stripQuotes,
};

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

  // No prototype: the keys here are field names written in someone else's puck, so an
  // ordinary object answers for `constructor` and swallows `__proto__` entirely — the
  // field would be silently dropped rather than carried or refused. Nothing downstream
  // reads a field by one of those names today, which makes the immunity an accident; the
  // harvester's own indexes are all `Map`s for the same reason.
  const data = Object.create(null);
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
