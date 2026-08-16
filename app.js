/* Roadmap aggregator UI. Reads window.__ROADMAP__ (from data/roadmap.js). */
(function () {
  "use strict";

  var DATA = window.__ROADMAP__;
  var board = document.getElementById("board");

  if (!DATA) {
    board.innerHTML =
      '<div class="banner">No data loaded. Run <code>node scripts/harvest.mjs</code> to' +
      " generate <code>data/roadmap.js</code>, then reload. When served over http this" +
      " page reads that file automatically.</div>";
    document.getElementById("subtitle").textContent = "No data";
    return;
  }

  var STATUS_LABEL = { now: "Now", next: "Next", later: "Later", inbox: "Inbox", done: "Done" };
  var state = {
    repos: new Set(), // empty = all
    tags: new Set(), // empty = all
    query: "",
    showDone: false,
    attention: false,
    view: "board", // "board" (kanban columns) | "list" (one column, grouped by status)
    sort: "default", // see SORTS below
  };
  var SORTS = ["default", "updated-asc", "created-desc", "created-asc", "title"];
  try {
    var savedView = localStorage.getItem("roadmap-view");
    if (savedView === "list" || savedView === "board") state.view = savedView;
    var savedSort = localStorage.getItem("roadmap-sort");
    if (SORTS.indexOf(savedSort) !== -1) state.sort = savedSort;
  } catch (e) {}

  // ── auto-status ──
  // The harvester computes the flags (item.signals, discrete types) so the JSON,
  // digest and board agree and an agent can read them. The board just renders
  // them, turning a `stale` flag into a live "N days" string for display.
  function daysSince(dateStr) {
    if (!dateStr) return null;
    var t = Date.parse(dateStr + "T00:00:00Z");
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }
  function isFlagged(item) { return (item.signals || []).length > 0; }
  // Resolve an item's blockedBy slugs to the actual (same-repo) puck objects.
  function blockerItems(item) {
    return (item.blockedBy || []).map(function (slug) {
      for (var i = 0; i < DATA.items.length; i++) {
        if (DATA.items[i].repo === item.repo && DATA.items[i].slug === slug) return DATA.items[i];
      }
      return null;
    }).filter(Boolean);
  }
  function signalMessages(item) {
    return (item.signals || []).map(function (s) {
      if (s.type === "stale") {
        var ds = daysSince(item.updated);
        return STATUS_LABEL[item.status] +
          (ds != null ? " for " + ds + " days without an update" : " without an update") +
          " — still active?";
      }
      if (s.type === "issue-closed") return "Issue #" + item.issue + " is closed — mark done?";
      if (s.type === "issue-open") return "Marked done but issue #" + item.issue + " is still open.";
      return s.type;
    });
  }

  // ── tiny, safe markdown (escape first, then a whitelist of inline + block bits) ──
  function esc(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function mdInline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function renderMd(src) {
    var out = [];
    var lines = esc(src).split("\n");
    var inList = false;
    var para = []; // buffer of wrapped lines that form one paragraph
    var inCode = false;
    var code = []; // buffer of lines inside a ``` fence
    function flushPara() {
      if (para.length) { out.push("<p>" + mdInline(para.join(" ")) + "</p>"); para = []; }
    }
    function closeList() {
      if (inList) { out.push("</ul>"); inList = false; }
    }
    function flushCode() {
      if (code.length) { out.push("<pre><code>" + code.join("\n") + "</code></pre>"); code = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        if (inCode) { flushCode(); inCode = false; }
        else { flushPara(); closeList(); inCode = true; }
        continue;
      }
      if (inCode) { code.push(line); continue; }
      var h = /^(#{2,4})\s+(.*)$/.exec(line);
      var li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        closeList();
        var lvl = Math.min(h[1].length, 4);
        out.push("<h" + lvl + ">" + mdInline(h[2]) + "</h" + lvl + ">");
      } else if (li) {
        flushPara();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + mdInline(li[1]) + "</li>");
      } else if (line.trim() === "") {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line.trim()); // fold wrapped lines into the current paragraph
      }
    }
    flushPara();
    closeList();
    if (inCode) flushCode();
    return out.join("\n");
  }

  function matches(item) {
    if (state.attention && !isFlagged(item)) return false;
    // In attention mode, flagged done items should surface even if "show done" is off.
    if (!state.attention && !state.showDone && item.status === "done") return false;
    if (state.repos.size && !state.repos.has(item.repo)) return false;
    if (state.tags.size) {
      var hit = item.tags.some(function (t) { return state.tags.has(t); });
      if (!hit) return false;
    }
    if (state.query) {
      var q = state.query.toLowerCase();
      var hay = (item.title + " " + item.body + " " + item.tags.join(" ") + " " + item.repoName).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Compact last-updated stamp for cards/list rows. Just the date — there's only
  // one on a card, and the modal + sort menu spell out which it is; a "Uppd."
  // label would only add clutter. The tooltip/aria keep it explicit.
  function dateEl(date, cls) {
    var d = el("span", cls || "card-date", date);
    d.title = "Last updated";
    d.setAttribute("aria-label", "Last updated " + date);
    return d;
  }

  // Owner: a GitHub avatar (loaded from github.com/<handle>.png, hidden if it
  // fails). opts.name adds "@handle"; opts.link wraps it in a profile link.
  function ownerEl(handle, opts) {
    opts = opts || {};
    var wrap = el(opts.link ? "a" : "span", "owner");
    if (opts.link) { wrap.href = "https://github.com/" + handle; wrap.target = "_blank"; wrap.rel = "noopener"; }
    wrap.title = "@" + handle;
    var img = document.createElement("img");
    img.className = "owner-avatar";
    img.src = "https://github.com/" + encodeURIComponent(handle) + ".png?size=40";
    img.alt = "@" + handle;
    img.loading = "lazy";
    img.addEventListener("error", function () { img.style.display = "none"; });
    wrap.appendChild(img);
    if (opts.name) wrap.appendChild(el("span", "owner-name", "@" + handle));
    return wrap;
  }

  // ⛔ badge for a puck waiting on unfinished dependencies (tooltip lists them).
  function blockBadge(item) {
    var b = el("span", "block-badge", "⛔");
    var names = blockerItems(item).map(function (x) { return x.title; });
    b.title = "Blocked by: " + (names.join(", ") || item.blockedBy.join(", "));
    b.setAttribute("aria-label", b.title);
    return b;
  }

  // A card is a compact summary; tapping it opens the full detail in a modal
  // (fullscreen on mobile) so long bodies don't blow up the column height.
  function card(item) {
    var sig = signalMessages(item);
    var c = el("div", "card" + (item.native ? "" : " adapted") + (sig.length ? " flagged" : ""));
    c.style.setProperty("--repo", item.repoColor);

    // Row 1: title.
    c.appendChild(el("h3", "card-title", item.title));

    // Row 2: repo (colored dot + name) on the left, ⚠ and date on the right.
    var meta = el("div", "card-meta");
    var repo = el("span", "card-repo");
    var dot = el("span", "repo-dot");
    dot.style.background = item.repoColor;
    repo.appendChild(dot);
    repo.appendChild(document.createTextNode(item.repoName));
    meta.appendChild(repo);
    if (sig.length) {
      var warn = el("span", "warn-badge", "⚠");
      warn.title = sig.join("\n");
      meta.appendChild(warn);
    }
    if ((item.blockedBy || []).length) meta.appendChild(blockBadge(item));
    if (item.owner) meta.appendChild(ownerEl(item.owner));
    if (item.updated) meta.appendChild(dateEl(item.updated));
    c.appendChild(meta);

    // Row 3: tags (static badges).
    if (item.tags.length || !item.native) {
      var tags = el("div", "card-tags");
      item.tags.forEach(function (t) { tags.appendChild(el("span", "tagpill", "#" + t)); });
      if (!item.native) tags.appendChild(el("span", "adapted-badge", "adapted"));
      c.appendChild(tags);
    }

    c.addEventListener("click", function () { openModal(item); });
    return c;
  }

  function linkEl(text, href) {
    var a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  // ── deep links: #<item.id> opens that puck's modal ──
  function setHash(id) {
    var base = location.pathname + location.search;
    try { history.replaceState(null, "", id ? base + "#" + id : base); } catch (e) {}
  }
  function itemFromHash() {
    var h = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!h) return null;
    for (var i = 0; i < DATA.items.length; i++) if (DATA.items[i].id === h) return DATA.items[i];
    return null;
  }
  function copyText(text, onDone) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onDone, function () { legacyCopy(text); onDone(); });
    } else { legacyCopy(text); onDone(); }
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "absolute"; ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e) {}
  }

  // ── detail modal ──
  var modalBackdrop, modalContent, modalPanel;
  function buildModal() {
    modalBackdrop = el("div", "modal-backdrop");
    modalBackdrop.hidden = true;
    var panel = el("div", "modal");
    modalPanel = panel;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    var close = el("button", "modal-close", "✕");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeModal);
    modalContent = el("div", "modal-content");
    panel.appendChild(close);
    panel.appendChild(modalContent);
    modalBackdrop.appendChild(panel);
    modalBackdrop.addEventListener("click", function (e) {
      if (e.target === modalBackdrop) closeModal();
    });
    document.body.appendChild(modalBackdrop);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });
  }

  function openModal(item) {
    modalContent.innerHTML = "";
    modalPanel.style.setProperty("--repo", item.repoColor);

    modalContent.appendChild(el("h2", "modal-title", item.title));

    // Metadata section: an identity line (repo + status), then both dates
    // together on one muted line so the section reads as a tidy block.
    var meta = el("div", "modal-meta");
    var idrow = el("div", "modal-idrow");
    var repo = el("span", "card-repo");
    var dot = el("span", "repo-dot");
    dot.style.background = item.repoColor;
    repo.appendChild(dot);
    repo.appendChild(document.createTextNode(item.repoName));
    idrow.appendChild(repo);
    idrow.appendChild(el("span", "status-pill status-" + item.status, STATUS_LABEL[item.status] || item.status));
    if (item.owner) idrow.appendChild(ownerEl(item.owner, { name: true, link: true }));
    meta.appendChild(idrow);

    if (item.created || item.updated) {
      var dates = el("div", "modal-dates");
      if (item.created) {
        var cs = el("span", null, "Created " + item.created);
        cs.title = "Created (first commit)";
        dates.appendChild(cs);
      }
      if (item.created && item.updated) dates.appendChild(el("span", "modal-dates-sep", "·"));
      if (item.updated) {
        var us = el("span", null, "Updated " + item.updated);
        us.title = "Last updated";
        dates.appendChild(us);
      }
      meta.appendChild(dates);
    }
    modalContent.appendChild(meta);

    // Tags on their own row (static badges).
    if (item.tags.length || !item.native) {
      var tags = el("div", "card-tags");
      item.tags.forEach(function (t) { tags.appendChild(el("span", "tagpill", "#" + t)); });
      if (!item.native) tags.appendChild(el("span", "adapted-badge", "adapted"));
      modalContent.appendChild(tags);
    }

    var sig = signalMessages(item);
    if (sig.length) {
      var flags = el("div", "card-flags");
      sig.forEach(function (m) { flags.appendChild(el("div", "flag", "⚠ " + m)); });
      modalContent.appendChild(flags);
    }

    // Blocked-by: list the unfinished dependencies; each opens that puck.
    if ((item.blockedBy || []).length) {
      var blk = el("div", "modal-blocked");
      blk.appendChild(document.createTextNode("⛔ Blocked by: "));
      var blockers = blockerItems(item);
      if (blockers.length) {
        blockers.forEach(function (b, i) {
          var a = el("a", "blocker-link", b.title);
          a.href = "#" + b.id;
          a.addEventListener("click", function (e) { e.preventDefault(); openModal(b); });
          blk.appendChild(a);
          if (i < blockers.length - 1) blk.appendChild(document.createTextNode(", "));
        });
      } else {
        blk.appendChild(document.createTextNode(item.blockedBy.join(", ")));
      }
      modalContent.appendChild(blk);
    }

    var body = el("div", "modal-body");
    body.innerHTML = renderMd(item.body || "(no details)");
    modalContent.appendChild(body);

    var links = el("div", "card-links");
    links.appendChild(linkEl("source ↗", item.sourceUrl));
    if (item.issue) {
      links.appendChild(linkEl("issue #" + item.issue, "https://github.com/" + item.repo + "/issues/" + item.issue));
    }
    var copyBtn = el("button", "linklike", "🔗 Copy link");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", function () {
      var url = location.origin + location.pathname + "#" + item.id;
      copyText(url, function () {
        copyBtn.textContent = "✓ Copied";
        setTimeout(function () { copyBtn.textContent = "🔗 Copy link"; }, 1500);
      });
    });
    links.appendChild(copyBtn);
    modalContent.appendChild(links);

    modalBackdrop.hidden = false;
    document.body.classList.add("modal-open");
    modalContent.scrollTop = 0;
    setHash(item.id); // reflect the open puck in the URL so it can be copied/shared
  }

  function closeModal() {
    if (!modalBackdrop) return;
    if (location.hash) setHash(null);
    modalBackdrop.hidden = true;
    document.body.classList.remove("modal-open");
  }

  // A compact list row — denser than a card, one vertical column, tap → modal.
  function listRow(item) {
    var sig = signalMessages(item);
    var r = el("div", "list-row" + (sig.length ? " flagged" : ""));
    r.style.setProperty("--repo", item.repoColor);
    r.title = item.repoName;
    var dot = el("span", "repo-dot");
    dot.style.background = item.repoColor;
    r.appendChild(dot);
    // title + meta share a wrapping row: inline (date right) on desktop, stacked
    // (date on its own line below the title) on mobile.
    var body = el("div", "list-body");
    body.appendChild(el("span", "list-title", item.title));
    var meta = el("div", "list-meta");
    if (sig.length) {
      var warn = el("span", "warn-badge", "⚠");
      warn.title = sig.join("\n");
      meta.appendChild(warn);
    }
    if ((item.blockedBy || []).length) meta.appendChild(blockBadge(item));
    if (item.updated) meta.appendChild(dateEl(item.updated, "list-date"));
    body.appendChild(meta);
    r.appendChild(body);
    r.addEventListener("click", function () { openModal(item); });
    return r;
  }

  function renderColumns(visible, statuses) {
    statuses.forEach(function (status) {
      var group = visible.filter(function (it) { return it.status === status; });
      var col = el("div", "column col-status-" + status);
      var head = el("div", "col-head");
      head.appendChild(el("span", "swatch"));
      head.appendChild(el("h2", null, STATUS_LABEL[status] || status));
      head.appendChild(el("span", "count", String(group.length)));
      col.appendChild(head);
      var cards = el("div", "cards");
      if (group.length === 0) {
        cards.appendChild(el("div", "empty", "—"));
      } else {
        group.forEach(function (it) { cards.appendChild(card(it)); });
      }
      col.appendChild(cards);
      board.appendChild(col);
    });
  }

  function renderList(visible, statuses) {
    statuses.forEach(function (status) {
      var group = visible.filter(function (it) { return it.status === status; });
      if (group.length === 0) return; // no "—" placeholders in the flat list
      var section = el("section", "list-group col-status-" + status);
      var head = el("div", "list-head");
      head.appendChild(el("span", "swatch"));
      head.appendChild(el("h2", null, STATUS_LABEL[status] || status));
      head.appendChild(el("span", "count", String(group.length)));
      section.appendChild(head);
      group.forEach(function (it) { section.appendChild(listRow(it)); });
      board.appendChild(section);
    });
  }

  // Client-side sort. "default" mirrors the harvester (manual `order` first, then
  // freshest `updated`, then title) so the board looks the same until you pick
  // another mode; the explicit modes drop `order` since the choice is deliberate.
  // Sort by a nullable date field, always pushing items that lack it to the end.
  // dir: 1 = oldest first (ascending), -1 = newest first (descending).
  function byDate(field, dir) {
    return function (a, b) {
      var av = a[field], bv = b[field];
      if (av && bv) return (dir === 1 ? av.localeCompare(bv) : bv.localeCompare(av)) || a.title.localeCompare(b.title);
      if (av) return -1;
      if (bv) return 1;
      return a.title.localeCompare(b.title);
    };
  }

  function sortComparator() {
    if (state.sort === "updated-asc") return byDate("updated", 1);
    if (state.sort === "created-desc") return byDate("created", -1);
    if (state.sort === "created-asc") return byDate("created", 1);
    if (state.sort === "title") {
      return function (a, b) { return a.title.localeCompare(b.title); };
    }
    return function (a, b) {
      var ao = a.order == null ? Infinity : a.order;
      var bo = b.order == null ? Infinity : b.order;
      if (ao !== bo) return ao - bo;
      return (b.updated || "").localeCompare(a.updated || "") || a.title.localeCompare(b.title);
    };
  }

  function renderBoard() {
    board.innerHTML = "";
    board.classList.toggle("as-list", state.view === "list");
    var visible = DATA.items.filter(matches).sort(sortComparator());
    var statuses = DATA.statuses.filter(function (s) {
      return s !== "done" || state.showDone || state.attention;
    });

    if (state.view === "list") renderList(visible, statuses);
    else renderColumns(visible, statuses);

    updateFilterButton();
    var shown = visible.length;
    document.getElementById("footmeta").textContent =
      shown + " of " + DATA.total + " shown · generated " + DATA.generatedAt.slice(0, 16).replace("T", " ") + " UTC · ";
  }

  // ── filter chips ──
  function buildRepoChips() {
    var wrap = document.getElementById("repoFilters");
    DATA.sources.forEach(function (s) {
      var chip = el("button", "chip repo");
      chip.setAttribute("aria-pressed", "false");
      var dot = el("span", "dot");
      dot.style.background = s.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(s.name));
      var n = el("span", "n", String(s.count));
      chip.appendChild(n);
      chip.title = s.blurb + (s.native ? "" : " — adapted from " + s.adapter);
      chip.addEventListener("click", function () {
        toggleSet(state.repos, s.repo, chip);
        renderBoard();
      });
      wrap.appendChild(chip);
    });
  }

  function buildTagChips() {
    var counts = {};
    DATA.items.forEach(function (it) {
      it.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    var wrap = document.getElementById("tagFilters");
    tags.slice(0, 24).forEach(function (t) {
      var chip = el("button", "chip tag");
      chip.setAttribute("aria-pressed", "false");
      chip.appendChild(document.createTextNode("#" + t));
      chip.appendChild(el("span", "n", String(counts[t])));
      chip.addEventListener("click", function () {
        toggleSet(state.tags, t, chip);
        renderBoard();
      });
      wrap.appendChild(chip);
    });
  }

  function toggleSet(set, key, chip) {
    if (set.has(key)) { set.delete(key); chip.setAttribute("aria-pressed", "false"); }
    else { set.add(key); chip.setAttribute("aria-pressed", "true"); }
  }

  // "Needs attention" filter — only shown when something is actually flagged.
  function buildAttentionChip() {
    var flagged = DATA.items.filter(function (it) { return isFlagged(it); }).length;
    if (!flagged) return;
    var chip = el("button", "chip attention");
    chip.setAttribute("aria-pressed", "false");
    chip.appendChild(document.createTextNode("⚠ Needs attention"));
    chip.appendChild(el("span", "n", String(flagged)));
    chip.title = "Pucks whose declared status disagrees with reality — a linked issue's state, or a now/next puck gone quiet.";
    chip.addEventListener("click", function () {
      state.attention = !state.attention;
      chip.setAttribute("aria-pressed", state.attention ? "true" : "false");
      renderBoard();
    });
    document.getElementById("filters").insertBefore(chip, document.querySelector("#filters .toggle"));
  }

  // ── theme ──
  var root = document.documentElement;
  var themeBtn = document.getElementById("theme");
  var saved = null;
  try { saved = localStorage.getItem("roadmap-theme"); } catch (e) {}
  if (saved) root.setAttribute("data-theme", saved);

  // Keep the browser status-bar color matched to the actual page background, so
  // it tracks both the system scheme and the in-app toggle (not just dark).
  var themeColorMeta = document.querySelector('meta[name="theme-color"]');
  function applyThemeColor() {
    if (!themeColorMeta) return;
    var bg = getComputedStyle(document.body).backgroundColor;
    if (bg) themeColorMeta.setAttribute("content", bg);
  }
  // True light⇄dark toggle: flip whatever is currently showing. (A three-state
  // dark→light→auto cycle was confusing because "auto" looks identical to dark on
  // a dark-set device, so getting back to dark took two presses.)
  function effectiveIsDark() {
    var t = root.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  themeBtn.addEventListener("click", function () {
    var next = effectiveIsDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("roadmap-theme", next); } catch (e) {}
    applyThemeColor();
    themeBtn.blur();
  });
  // Follow the system scheme while on "auto" (no explicit toggle yet).
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyThemeColor);
  }
  applyThemeColor();

  // ── view toggle (board ⇄ list, remembered) ──
  var viewBtn = document.getElementById("viewToggle");
  function updateViewButton() {
    var isList = state.view === "list";
    // Icon = the current view (no persistent .active highlight — it read as a
    // stuck focus ring); the title says what a tap does.
    viewBtn.textContent = isList ? "☰" : "▦";
    viewBtn.title = isList ? "Switch to board view" : "Switch to list view";
    viewBtn.setAttribute("aria-label", viewBtn.title);
  }
  viewBtn.addEventListener("click", function () {
    state.view = state.view === "board" ? "list" : "board";
    try { localStorage.setItem("roadmap-view", state.view); } catch (e) {}
    updateViewButton();
    renderBoard();
    viewBtn.blur(); // drop focus so no ring lingers after the tap
  });

  // ── sort (in the filter panel, remembered) ──
  var sortSelect = document.getElementById("sortSelect");
  sortSelect.value = state.sort;
  sortSelect.addEventListener("change", function () {
    state.sort = sortSelect.value;
    try { localStorage.setItem("roadmap-sort", state.sort); } catch (e) {}
    renderBoard();
  });

  // ── search + title suggestions ──
  var searchInput = document.getElementById("search");
  var suggestEl = document.getElementById("searchSuggest");
  var suggestItems = []; // items currently offered
  var suggestIndex = -1; // highlighted row (-1 = none)

  // Title matches only (v1): startsWith ranks above a mid-string hit. Suggestions
  // span all items — clicking jumps to any card, even one the board is hiding.
  function computeSuggestions(q) {
    q = q.toLowerCase();
    if (!q) return [];
    var starts = [], contains = [];
    DATA.items.forEach(function (it) {
      var i = it.title.toLowerCase().indexOf(q);
      if (i === 0) starts.push(it);
      else if (i > 0) contains.push(it);
    });
    return starts.concat(contains).slice(0, 8);
  }

  function renderSuggestions() {
    suggestEl.innerHTML = "";
    if (!suggestItems.length) {
      suggestEl.hidden = true;
      searchInput.setAttribute("aria-expanded", "false");
      return;
    }
    suggestItems.forEach(function (it, idx) {
      var li = el("li", "suggest-item");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", idx === suggestIndex ? "true" : "false");
      var dot = el("span", "suggest-dot");
      dot.style.background = it.repoColor;
      li.appendChild(dot);
      li.appendChild(el("span", "suggest-title", it.title));
      li.appendChild(el("span", "status-pill status-" + it.status, STATUS_LABEL[it.status] || it.status));
      // pointerdown (not click): fires before blur and preventDefault keeps the
      // input focused, so the selection lands instead of the dropdown vanishing.
      li.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        chooseSuggestion(it);
      });
      suggestEl.appendChild(li);
    });
    suggestEl.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  function updateSuggestions() {
    suggestItems = computeSuggestions(state.query);
    suggestIndex = -1;
    renderSuggestions();
  }

  function hideSuggestions() {
    suggestItems = [];
    suggestIndex = -1;
    suggestEl.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
  }

  function chooseSuggestion(it) {
    hideSuggestions();
    searchInput.blur();
    openModal(it);
  }

  var searchClear = document.getElementById("searchClear");
  function updateSearchClear() { searchClear.hidden = !searchInput.value; }

  searchInput.addEventListener("input", function (e) {
    state.query = e.target.value.trim();
    renderBoard();
    updateSuggestions();
    updateSearchClear();
  });
  searchInput.addEventListener("focus", function () {
    if (state.query) updateSuggestions();
  });
  // pointerdown + preventDefault so the tap clears without first blurring the
  // input (keeps focus, so the keyboard stays and you can keep typing).
  searchClear.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    searchInput.value = "";
    state.query = "";
    renderBoard();
    hideSuggestions();
    updateSearchClear();
    searchInput.focus();
  });
  searchInput.addEventListener("keydown", function (e) {
    var n = suggestItems.length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      suggestIndex = (suggestIndex + 1) % n;
      renderSuggestions();
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      suggestIndex = (suggestIndex - 1 + n) % n;
      renderSuggestions();
    } else if (e.key === "Enter") {
      // Only open a suggestion the user actually arrowed to; otherwise Enter just
      // commits the search — dismiss the dropdown/keyboard and show the filtered
      // board (the query is already applied live).
      if (suggestIndex >= 0 && n) { e.preventDefault(); chooseSuggestion(suggestItems[suggestIndex]); }
      else { hideSuggestions(); searchInput.blur(); }
    } else if (e.key === "Escape") {
      if (n) hideSuggestions();
      else searchInput.blur();
    }
  });
  // iOS keeps the keyboard up until the field is explicitly blurred — a tap on a
  // card or empty space doesn't. Blur on any tap outside the input (but not on the
  // dropdown, whose own pointerdown handles the pick).
  searchInput.addEventListener("blur", hideSuggestions);
  // Tapping outside: dismiss the keyboard, and if the dropdown is open, close it
  // AND swallow that tap so it only closes the dropdown instead of also opening
  // whatever card is underneath. Reset the flag at the top of every pointerdown so
  // a scroll that never produces a click can't leave it stuck.
  var swallowClick = false;
  document.addEventListener("pointerdown", function (e) {
    swallowClick = false;
    if (e.target === searchInput || suggestEl.contains(e.target)) return;
    var wasOpen = !suggestEl.hidden;
    if (document.activeElement === searchInput) searchInput.blur();
    if (wasOpen) { hideSuggestions(); swallowClick = true; }
  }, true);
  document.addEventListener("click", function (e) {
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.getElementById("showDone").addEventListener("change", function (e) {
    state.showDone = e.target.checked;
    renderBoard();
  });

  // ── collapsible filters (collapsed by default on narrow screens) ──
  var filterChips = document.getElementById("filterChips");
  var filterToggle = document.getElementById("filterToggle");
  function setFilters(open) {
    filterChips.hidden = !open;
    filterToggle.setAttribute("aria-expanded", open ? "true" : "false");
    filterToggle.classList.toggle("active", open);
  }
  filterToggle.addEventListener("click", function () { setFilters(filterChips.hidden); });
  function updateFilterButton() {
    var n = state.repos.size + state.tags.size;
    filterToggle.textContent = n ? "Filter (" + n + ")" : "Filter";
  }

  // ── boot ──
  // Deploy-your-own config: title/description/source link come from
  // board.config.json (embedded in the payload), so nothing here is hardcoded
  // to one owner. Falls back to the static HTML defaults when absent.
  var CFG = DATA.config || {};
  if (CFG.title) {
    document.title = CFG.title;
    var h1 = document.querySelector(".brand h1");
    if (h1) h1.textContent = CFG.title;
  }
  if (CFG.description) {
    var descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute("content", CFG.description);
  }
  var sourceLink = document.getElementById("sourceLink");
  if (sourceLink) {
    if (CFG.repoUrl) sourceLink.href = CFG.repoUrl;
    else sourceLink.style.display = "none"; // no repo configured → hide the dead link
  }

  var active = DATA.counts.now + DATA.counts.next + DATA.counts.later;
  document.getElementById("subtitle").textContent =
    active + " active · " + DATA.counts.done + " done · " + DATA.sources.length + " repos";
  buildModal();
  buildRepoChips();
  buildTagChips();
  buildAttentionChip();
  updateViewButton();
  setFilters(window.matchMedia("(min-width: 601px)").matches);
  renderBoard();

  // Deep link: open the puck named in the URL hash on load, and react to the
  // hash changing (pasted link in the same tab, or Back after opening a modal).
  var deepItem = itemFromHash();
  if (deepItem) openModal(deepItem);
  window.addEventListener("hashchange", function () {
    var it = itemFromHash();
    if (it) openModal(it);
    else closeModal();
  });
})();
