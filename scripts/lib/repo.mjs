// Reads files from a source repo through one of two backends:
//   - fs   : a local checkout under ROADMAP_LOCAL_ROOT/<repo-name> (CI clones the
//            repos, dev points it at existing clones) — no network, no rate limit.
//   - http : the GitHub REST + raw endpoints, unauthenticated or with GITHUB_TOKEN.
// The fs backend wins whenever the checkout exists; otherwise it falls back to http.

import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const LOCAL_ROOT = process.env.ROADMAP_LOCAL_ROOT || "";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a local checkout dir for `owner/repo`, or "" if none is usable. */
async function localDir(repo) {
  if (!LOCAL_ROOT) return "";
  const short = repo.split("/").pop();
  for (const candidate of [path.join(LOCAL_ROOT, repo), path.join(LOCAL_ROOT, short)]) {
    if (await pathExists(candidate)) return candidate;
  }
  return "";
}

async function ghJson(url) {
  const headers = { "User-Agent": "roadmap-aggregator", Accept: "application/vnd.github+json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}

async function ghRaw(repo, branch, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  const headers = { "User-Agent": "roadmap-aggregator" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw ${res.status} for ${url}`);
  return res.text();
}

/**
 * A handle for reading one source repo.
 * @param {string} repo    "owner/name"
 * @param {string} branch  git ref
 */
export async function openRepo(repo, branch) {
  const dir = await localDir(repo);
  const backend = dir ? "fs" : "http";

  return {
    repo,
    branch,
    backend,

    /** Read a UTF-8 file at `relPath`, or null if it does not exist. */
    async readFile(relPath) {
      if (backend === "fs") {
        const abs = path.join(dir, relPath);
        if (!(await pathExists(abs))) return null;
        return readFile(abs, "utf8");
      }
      return ghRaw(repo, branch, relPath);
    },

    /**
     * List entries directly under `relDir`.
     * @returns {Promise<Array<{ name: string, type: "file"|"dir" }>>} (empty if missing)
     */
    async list(relDir) {
      if (backend === "fs") {
        const abs = path.join(dir, relDir);
        if (!(await pathExists(abs))) return [];
        const entries = await readdir(abs, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      }
      const json = await ghJson(
        `https://api.github.com/repos/${repo}/contents/${relDir}?ref=${branch}`,
      );
      if (!Array.isArray(json)) return [];
      return json.map((e) => ({ name: e.name, type: e.type === "dir" ? "dir" : "file" }));
    },

    /**
     * Creation date (YYYY-MM-DD) of a file — the first commit that touched it.
     * Derived from git so it needs no hand-maintained field. Best-effort: null on
     * the http backend, or when history is unavailable (e.g. a shallow clone).
     */
    async firstCommitDate(relPath) {
      if (backend !== "fs") return null;
      try {
        // Newest commit that *added* the path — for a puck added once (then only
        // edited) that's its creation. `-1` stops early, so this stays cheap even
        // over full history.
        const { stdout } = await execFileP(
          "git",
          ["-C", dir, "log", "-1", "--diff-filter=A", "--format=%as", "--", relPath],
          { maxBuffer: 1 << 20 },
        );
        const date = stdout.trim();
        return date || null;
      } catch {
        return null;
      }
    },
  };
}

/** Public web URL for a file in a repo, for linking cards back to source. */
export function blobUrl(repo, branch, filePath) {
  return `https://github.com/${repo}/blob/${branch}/${filePath}`;
}
