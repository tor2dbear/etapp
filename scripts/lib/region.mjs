// Lift a marked region out of a file, or fail loudly.
//
// Three checks evaluate a fenced region in Node — the markdown renderer, the query
// grammar, and the dependency graph, which lifts from `scripts/harvest.mjs` as well as
// from `app.js` — so that what is judged is the bytes that ship rather than a copy of
// them. The caller supplies the region's free names, and supplying the *real* ones (the
// dependency probe hands in `format.js`'s own reference rule) is the difference between
// a sandbox and a stub.
//
// The lifting itself is here because the first two checks had each written it out: read
// the file, find the two whole-line markers, the same three-clause validity test, the
// same error sentence. The copies had already started to differ cosmetically, which is
// the first symptom of the failure this whole review keeps finding. In `scripts/lib/`
// beside the other shared Node code — not in `format.js`, which needs no `fs` and ships
// to every visitor.
//
// Each caller keeps its own `new Function`: which names a region hands back is the
// probe's business, and the fence's business is only where the region begins and ends.
//
// Node builtins only, like the rest of scripts/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {string} file   path relative to the repo root
 * @param {string} name   marker name, e.g. "md" for `// md:begin` … `// md:end`
 * @returns {{ src: string, lines: string[], region: string }}
 */
export function liftRegion(file, name) {
  const begin = `// ${name}:begin`;
  const end = `// ${name}:end`;
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const lines = src.split("\n");
  // Every match, not the first. `findIndex` answers with the earliest one, so a second
  // `// q:begin` anywhere in 11k lines would have silently moved the fence and left the
  // check reading a region nobody meant. A duplicate marker is a mistake either way, so
  // it is reported rather than resolved.
  const at = (marker) => lines.reduce((acc, l, i) => (l.trim() === marker ? acc.concat(i) : acc), []);
  const from = at(begin);
  const to = at(end);
  const where = (hits) => (hits.length === 0 ? "none" : hits.map((i) => i + 1).join(", "));
  if (from.length !== 1 || to.length !== 1 || to[0] <= from[0]) {
    throw new Error(
      `${file} no longer carries exactly one ${begin} … ${end} fence ` +
        `(begin at ${where(from)}, end at ${where(to)}). ` +
        "Restore the markers or this check silently stops checking anything."
    );
  }
  return { src, lines, region: lines.slice(from[0] + 1, to[0]).join("\n") };
}
