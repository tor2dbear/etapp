#!/usr/bin/env node
// Every tracked JavaScript file parses.
//
// The cheapest gate: a file that does not parse fails everything after it, and app.js
// is 11k lines that nothing else compiles.
//
// A script rather than the shell loop it used to be in check.yml, for one reason:
// `scripts/check-checks.mjs` sabotages each gate and asserts it fails. A gate written
// inline in the workflow cannot be invoked by anything else, so the meta-check would
// have had to keep its own copy of the loop — a second implementation of the thing it
// is there to police.
//
// Asked of git rather than globbed. A hand-written list left format.js out in the
// commit that added it; the glob that replaced the list left out anything one
// directory deeper, and `data/roadmap.js` — generated, served, and the one JavaScript
// file here nobody writes by hand — was never in either. Both printed "✓ all
// JavaScript parses" while skipping a file.
//
// Node builtins only, like the rest of scripts/.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = execFileSync("git", ["ls-files", "*.js", "*.mjs"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

// An empty answer fails rather than passing vacuously: "nothing to check" and
// "everything checked" print the same tick otherwise.
if (!files.length) {
  console.error("✗ no JavaScript found — this check just stopped checking anything");
  process.exit(1);
}

const bad = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    bad.push(`${f}: ${String(e.stderr || "").trim().split("\n").find((l) => /Error/.test(l)) || "does not parse"}`);
  }
}

if (bad.length) {
  console.error(`✗ ${bad.length} file(s) do not parse\n`);
  for (const b of bad) console.error("  " + b);
  process.exit(1);
}
console.log(`✓ all JavaScript parses (${files.length} files)`);
