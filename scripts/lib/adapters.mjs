// Adapters turn a source repo's roadmap — however it is written — into a flat
// list of normalized items. Each item:
//   { slug, title, status, tags, updated, created, issue, order, body,
//     sourcePath, sourceUrl, adapter, native }
//
// `native: true`  → a real puck authored in the convention (source of truth).
// `native: false` → adapted from a looser format (a checklist, a prose section);
//                    fidelity is best-effort until the repo adopts real pucks.

import { parseFrontmatter } from "./frontmatter.mjs";
import { blobUrl } from "./repo.mjs";

export const STATUSES = ["now", "next", "later", "inbox", "done"];
const VALID = new Set(STATUSES);

// Priority is an optional, ordered interface field (highest → lowest). Absence
// of the field means "no priority" (null), never a value — so the payload only
// carries a priority when a puck actually declares one.
export const PRIORITIES = ["urgent", "high", "medium", "low"];
const VALID_PRIORITY = new Set(PRIORITIES);

function normalizePriority(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return VALID_PRIORITY.has(v) ? v : null;
}

export function slugify(s) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

// Strip the markdown that would otherwise leak into a plain-text title.
function stripInlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatus(raw, fallback) {
  const v = String(raw || "").trim().toLowerCase();
  return VALID.has(v) ? v : fallback;
}

// ── pucks: the native convention (roadmap/<slug>.md | roadmap/<slug>/README.md) ──
async function pucksAdapter(repo, branch, source) {
  const base = source.path || "roadmap";
  const entries = await repo.list(base);
  const items = [];

  for (const entry of entries) {
    let relPath = null;
    let slug = null;

    if (entry.type === "file" && entry.name.endsWith(".md")) {
      if (entry.name.toLowerCase() === "readme.md") continue; // the convention doc
      slug = entry.name.replace(/\.md$/, "");
      relPath = `${base}/${entry.name}`;
    } else if (entry.type === "dir") {
      slug = entry.name;
      relPath = `${base}/${entry.name}/README.md`;
    } else {
      continue;
    }

    const text = await repo.readFile(relPath);
    if (text == null) continue;
    const { data, body } = parseFrontmatter(text);

    // Creation date: an explicit `created:` wins; otherwise derive it from git
    // (first commit that added the file) so it needs no hand upkeep.
    const created = data.created ? String(data.created) : await repo.firstCommitDate(relPath);

    items.push({
      slug,
      title: data.title ? String(data.title) : slug,
      status: normalizeStatus(data.status, "inbox"),
      // Optional priority (urgent/high/medium/low) or null when unset.
      priority: normalizePriority(data.priority),
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [],
      updated: data.updated ? String(data.updated) : "",
      created: created || null,
      issue: data.issue != null && data.issue !== "" ? Number(data.issue) : null,
      order: data.order != null && data.order !== "" ? Number(data.order) : null,
      // Same-repo slugs this puck is blocked by; the harvester resolves them.
      depends: Array.isArray(data.depends)
        ? data.depends.map(String)
        : data.depends ? [String(data.depends)] : [],
      // GitHub handle of the owner (thin collaboration — a field, not a store).
      owner: data.owner ? String(data.owner).replace(/^@/, "") : null,
      body,
      sourcePath: relPath,
      sourceUrl: blobUrl(repo.repo, branch, relPath),
      adapter: "pucks",
      native: true,
    });
  }
  return items;
}

// Pull the bullet lines out of one "## <section>" block of a markdown file.
// Wrapped/indented continuation lines are folded into the preceding bullet.
// Returns [{ text, subsection }] in document order.
function bulletsInSection(text, section) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const bullets = [];
  let inSection = false;
  let subsection = "";
  let current = null;

  const flush = () => {
    if (current) bullets.push(current);
    current = null;
  };

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      const title = stripInlineMd(h2[1]);
      inSection = title.toLowerCase().startsWith(section.toLowerCase());
      subsection = "";
      continue;
    }
    if (!inSection) continue;
    if (h3) {
      flush();
      subsection = stripInlineMd(h3[1]);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      current = { text: bullet[1].trim(), subsection };
    } else if (current && line.trim() && !/^\s*#/.test(line)) {
      current.text += " " + line.trim(); // continuation of the current bullet
    } else if (!line.trim()) {
      flush();
    }
  }
  flush();
  return bullets;
}

// Split a bullet into a short title and the remaining detail.
function titleAndBody(raw) {
  const trimmed = raw.trim();
  // A leading bold run — "**Title.** rest" — is an explicit title.
  const bold = /^\*\*(.+?)\*\*/.exec(trimmed);
  if (bold) {
    const t = stripInlineMd(bold[1]).replace(/[.:—–\s]+$/, "");
    if (t.length >= 3 && t.length <= 80) return { title: t, body: trimmed };
  }
  const clean = stripInlineMd(trimmed);
  // Otherwise take a lead clause before the first ". "/" — "/": — but only if it
  // reads like a title (multi-word, not a stub like "Optional").
  const m = /^(.+?)([.—–:])\s+(.+)$/.exec(clean);
  if (m && m[1].includes(" ") && m[1].trim().length >= 12 && m[1].length <= 70) {
    return { title: m[1].trim(), body: trimmed };
  }
  const title = clean.length <= 80 ? clean : clean.slice(0, 77).trimEnd() + "…";
  return { title, body: trimmed };
}

// ── checklist: "- ✅ done" / "- [x] done" / "- open" under a "## Roadmap" heading ──
async function checklistAdapter(repo, branch, source) {
  const text = await repo.readFile(source.path);
  if (text == null) return [];
  const bullets = bulletsInSection(text, source.section || "Roadmap");
  const items = [];
  let i = 0;

  for (const { text: rawFull, subsection } of bullets) {
    let raw = rawFull;
    let done = false;
    const doneMark = /^(✅|✓|\[[xX]\]|☑)\s*/.exec(raw);
    const openMark = /^(⬜|☐|\[ \]|○)\s*/.exec(raw);
    if (doneMark) {
      done = true;
      raw = raw.slice(doneMark[0].length);
    } else if (openMark) {
      raw = raw.slice(openMark[0].length);
    }
    // Skip pure meta/aside bullets like "*(Also shipped, not listed: …)*".
    if (/^\*?\(/.test(raw.trim())) continue;

    const { title, body } = titleAndBody(raw);
    // Tag items nested under an h3 only when the heading slugs to something short
    // and clean — a whole sentence ("Candidates that add a backend…") is dropped
    // rather than turned into a monster tag.
    const subTag = subsection ? slugify(subsection) : "";
    const tags = subTag && !subTag.includes("-") && subTag.length <= 14 ? [subTag] : [];
    items.push({
      slug: slugify(title),
      title,
      status: done ? "done" : "later",
      priority: null,
      tags,
      updated: "",
      created: null,
      depends: [],
      owner: null,
      issue: null,
      order: i * 10,
      body,
      sourcePath: source.path,
      sourceUrl: `${blobUrl(repo.repo, branch, source.path)}#${slugify(source.section || "Roadmap")}`,
      adapter: "checklist",
      native: false,
    });
    i += 1;
  }
  return items;
}

// ── prose: bullet items under a "## Vidare"/future section of a README ──
async function proseAdapter(repo, branch, source) {
  const text = await repo.readFile(source.path);
  if (text == null) return [];
  const bullets = bulletsInSection(text, source.section || "Vidare");
  return bullets.map(({ text: raw }, i) => {
    const { title, body } = titleAndBody(raw);
    return {
      slug: slugify(title),
      title,
      status: "later", // future/"sharp version" ideas — explicitly not committed
      priority: null,
      tags: [],
      updated: "",
      created: null,
      depends: [],
      owner: null,
      issue: null,
      order: i * 10,
      body,
      sourcePath: source.path,
      sourceUrl: `${blobUrl(repo.repo, branch, source.path)}#${slugify(source.section || "Vidare")}`,
      adapter: "prose",
      native: false,
    };
  });
}

const ADAPTERS = {
  pucks: pucksAdapter,
  checklist: checklistAdapter,
  prose: proseAdapter,
};

export async function harvestSource(repo, branch, source) {
  const fn = ADAPTERS[source.adapter];
  if (!fn) throw new Error(`Unknown adapter "${source.adapter}" for ${source.repo}`);
  return fn(repo, branch, source);
}
