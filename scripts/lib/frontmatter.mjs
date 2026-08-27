// Minimal, dependency-free YAML-frontmatter parser.
// Handles exactly the subset the roadmap convention uses:
//   scalars (quoted or bare), integers, dates, and inline arrays [a, b, c].
// The body is everything after the closing `---`.

function parseScalar(raw) {
  let v = raw.trim();
  if (v === "") return "";
  // Quoted forms come first, and that order is the point: a quoted value that happens
  // to open with `[` is a string, not a list.
  //
  // Double-quoted is JSON-decoded because that is what the writer produces —
  // `formatValue` in the CLI quotes a title via `JSON.stringify`. Reading it back with
  // a plain slice left the escapes in the value, so a title with a quote in it came
  // back corrupted and got written corrupted the next time. The round trip has to
  // close on the same rules at both ends.
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  // Single-quoted: YAML's only escape inside is '' → '.
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  // Inline array: [a, b, c] — only for genuinely unquoted values.
  if (v[0] === "[" && v[v.length - 1] === "]") {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s !== "");
  }
  // Bare scalar: strip a trailing YAML comment. A `#` only opens a comment when
  // whitespace precedes it, so `C# tips` and a bare `#123` survive intact — without
  // that rule the fix would quietly eat half the values it was meant to protect.
  const c = v.search(/\s#/);
  if (c !== -1) v = v.slice(0, c).trim();
  return v;
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
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    data[key] = parseScalar(line.slice(idx + 1));
  }
  return { data, body: body.trim() };
}
