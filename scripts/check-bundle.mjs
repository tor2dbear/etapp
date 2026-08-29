#!/usr/bin/env node
// Would anything unintended be published?
//
// The served bundle *is* the repo root — wrangler uploads the directory and
// `.assetsignore` names what to leave out. That makes it an exclusion list, which
// fails in the one direction nobody notices: a file nobody thought about is not
// left out, it is published. It has happened twice — the test suite itself, and a
// scratch probe — both caught in review rather than by anything running.
//
// So this turns the exclusion list around: every file has to be *either* something
// the board serves on purpose, or excluded. Anything else is reported.
//
// A plain script, not a test, on purpose. It runs from `predeploy` and from CI, and
// it is copied into the exported product — which has neither a test runner nor a
// browser. Node builtins only; nothing to install.
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// What the board serves, and what may live inside each of it. Patterns over *paths*,
// not a set of top-level names: `data` and `fonts` are directories, and a name-only
// rule passes anything dropped inside them — `data/notes.txt` publishes just as
// readily as a file in the root. Naming the contents is also the only way the list
// says what it means.
// Nothing here is required to exist: an instance without `_headers`, or a fresh
// checkout before the first harvest, is not broken. This asks what may ship, not
// what must.
export const SERVED = {
  "index.html": /^index\.html$/,
  "app.js": /^app\.js$/,
  "styles.css": /^styles\.css$/,
  _headers: /^_headers$/,
  "ROADMAP.md": /^ROADMAP\.md$/,
  data: /^data\/roadmap\.(json|js)$/,
  // LICENSE.md belongs in the bundle and is not an oversight: Geist is OFL-1.1,
  // which requires the licence to travel with the font files.
  fonts: /^fonts\/([\w.-]+\.woff2|LICENSE\.md)$/,
};
export const served = (rel) => Object.keys(SERVED).some((k) => SERVED[k].test(rel));

export const lines = (text) =>
  text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

// `.assetsignore` takes .gitignore-style patterns (Cloudflare's own migration guide
// writes `**/node_modules`), so a literal-name comparison answers only for some of
// them. Two forms are in use — a name and a `*` glob — and gitignore's rule that a
// slash-free pattern matches at any depth is what makes `roadmap` exclude
// `roadmap/x.md`.
export function matcher(pattern) {
  // gitignore's two shapes, and the difference is load-bearing. A pattern *without* a
  // slash matches at any depth — that is what makes `roadmap` exclude `roadmap/x.md`.
  // One anchored to the root is matched from the first segment down.
  //
  // Comparing an anchored pattern segment by segment, as this did at first, means it
  // can never match anything: `demo/data/build.mjs` is not equal to `demo`, `data` or
  // `build.mjs`. It went unnoticed here because no pattern in this repo has a slash —
  // the sibling site repo, whose `.assetsignore` does, is where the guard caught it.
  //
  // What anchors a pattern is a slash *anywhere*, including a leading one: `/scripts`
  // is root-anchored while `scripts` matches at any depth. The first fix read only for
  // an internal slash and left the leading one on the pattern, so it was compared
  // against a `rel` that never carries one and matched nothing at all — the guard would
  // then call a deliberately excluded file loose and fail the deploy.
  const rooted = pattern.startsWith("/");
  const p = pattern.replace(/^\//, "").replace(/^\*\*\//, "").replace(/\/$/, "");
  const anchored = rooted || p.includes("/");
  const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // Per segment, so a `*` never crosses a directory boundary.
  const parts = p.split("/").map((seg) => (seg.includes("*")
    ? { rx: new RegExp("^" + seg.split("*").map(esc).join("[^/]*") + "$") }
    : { lit: seg }));
  const hit = (i, part) => (parts[i].rx ? parts[i].rx.test(part) : parts[i].lit === part);
  if (!anchored) return (rel) => rel.split("/").some((part) => hit(0, part));
  // Anchored patterns match the path *or* a prefix of it at a directory boundary: a
  // pattern naming a directory has to answer for the files inside it too, since
  // `git ls-files` hands the audit whole paths and never the directory entry alone.
  return (rel) => {
    const segs = rel.split("/");
    if (segs.length < parts.length) return false;
    for (let i = 0; i < parts.length; i++) if (!hit(i, segs[i])) return false;
    return true;
  };
}

// Walks what wrangler would upload: everything under the root that is not excluded.
// Excluded directories are not descended into — `node_modules` is the reason, and it
// is also the honest model, since wrangler does not look inside them either.
async function walk(dir, excluded, prefix = "") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (rel === ".git" || excluded(rel)) continue;
    if (e.isDirectory()) out.push(...await walk(dir + e.name + "/", excluded, rel + "/"));
    else out.push(rel);
  }
  return out;
}

const read = async (f) => { try { return await readFile(f, "utf8"); } catch { return null; } };

// Three readings, because the git index and the directory wrangler uploads are not
// the same set of files:
//   tracked   what a clone would have — the CI deploy's whole world
//   onDisk    what is actually here — the only reading that sees a file which is
//             neither tracked nor gitignored, the state a scratch file is in
//   listGap   every .gitignore pattern must also be excluded from the bundle: a
//             gitignored file is invisible to `git ls-files` and still sits in the
//             working tree, so a local deploy publishes it
export async function auditBundle(root) {
  const ignoreText = await read(root + ".assetsignore");
  if (ignoreText == null) return { fatal: "no .assetsignore — every file in the repo would be published" };
  const patterns = lines(ignoreText);
  const match = patterns.map(matcher);
  const excluded = (rel) => match.some((m) => m(rel));

  let tracked = [];
  try {
    // stderr ignored, not inherited: an unzipped copy of the product is not a git
    // checkout, and `fatal: not a git repository` printed in the middle of a deploy
    // reads like the deploy broke. The on-disk reading answers there anyway.
    tracked = execFileSync("git", ["ls-files"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch { /* not a git checkout — the on-disk reading still answers */ }

  const gitignore = await read(root + ".gitignore");
  const norm = (p) => p.replace(/^\*\*\//, "").replace(/\/$/, "");
  const excludedNames = new Set(patterns.map(norm));

  return {
    patterns,
    tracked,
    looseTracked: tracked.filter((f) => !served(f) && !excluded(f)),
    looseOnDisk: (await walk(root, excluded)).filter((f) => !served(f)).sort(),
    listGap: gitignore ? lines(gitignore).map(norm).filter((p) => !excludedNames.has(p)) : [],
  };
}

export function report(a) {
  if (a.fatal) return ["✗ " + a.fatal];
  const out = [];
  if (a.looseTracked.length) out.push(`✗ tracked but neither served nor excluded: ${a.looseTracked.join(", ")}`);
  if (a.looseOnDisk.length) out.push(`✗ in the working tree and would be published: ${a.looseOnDisk.join(", ")}`);
  if (a.listGap.length) out.push(`✗ gitignored but not in .assetsignore: ${a.listGap.join(", ")}`);
  return out;
}

// Run directly (predeploy, CI) — as a module it is just the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = report(await auditBundle(root));
  if (problems.length) {
    console.error("Bundle check failed — these would be served at your Worker's domain:\n");
    problems.forEach((p) => console.error("  " + p));
    console.error("\nAdd them to .assetsignore, or remove them.");
    process.exit(1);
  }
  console.log("✓ bundle clean — nothing unintended would be published");
}
