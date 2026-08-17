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
    focus: "all", // "all" | "ready" (unblocked now/next) | "attention" (flagged)
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
    // Cockpit focus: Ready = unblocked now/next; Attention = flagged (drift).
    if (state.focus === "ready") {
      if (item.status !== "now" && item.status !== "next") return false;
      if ((item.blockedBy || []).length) return false;
    } else if (state.focus === "attention") {
      if (!isFlagged(item)) return false; // flagged done surfaces even if "show done" is off
    } else if (!state.showDone && item.status === "done") {
      return false;
    }
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

  // ── inline icons — Streamline "Feather" set (streamlinehq.com), stroke
  // inherits currentColor so they track light/dark + the repo accent. To add
  // one: drop its path 'd' string(s) into ICONS and reference by name. ──
  var SVGNS = "http://www.w3.org/2000/svg";
  var ICONS = {
    slash: ["M1.25 7.5a6.25 6.25 0 1 0 12.5 0 6.25 6.25 0 1 0 -12.5 0", "m3.08125 3.08125 8.8375 8.8375"],
    share: ["M2.5 7.5v5a1.25 1.25 0 0 0 1.25 1.25h7.5a1.25 1.25 0 0 0 1.25 -1.25v-5", "m10 3.75 -2.5 -2.5 -2.5 2.5", "m7.5 1.25 0 8.125"],
    list: ["m5 3.75 8.125 0", "m5 7.5 8.125 0", "m5 11.25 8.125 0", "m1.875 3.75 0.00625 0", "m1.875 7.5 0.00625 0", "m1.875 11.25 0.00625 0"],
    grid: ["M1.875 1.875h4.375v4.375H1.875Z", "M8.75 1.875h4.375v4.375h-4.375Z", "M8.75 8.75h4.375v4.375h-4.375Z", "M1.875 8.75h4.375v4.375H1.875Z"],
    key: ["m13.125 1.25 -1.25 1.25m-4.7562500000000005 4.7562500000000005a3.4375 3.4375 0 1 1 -4.86125 4.86125 3.4375 3.4375 0 0 1 4.860625 -4.860625zm0 0L9.6875 4.6875m0 0 1.875 1.875L13.75 4.375l-1.875 -1.875m-2.1875 2.1875L11.875 2.5"],
    external: ["M11.25 8.125v3.75a1.25 1.25 0 0 1 -1.25 1.25H3.125a1.25 1.25 0 0 1 -1.25 -1.25V5a1.25 1.25 0 0 1 1.25 -1.25h3.75", "m9.375 1.875 3.75 0 0 3.75", "M6.25 8.75 13.125 1.875"],
    sun: ["M4.375 7.5a3.125 3.125 0 1 0 6.25 0 3.125 3.125 0 1 0 -6.25 0", "m7.5 0.625 0 1.25", "m7.5 13.125 0 1.25", "m2.6374999999999997 2.6374999999999997 0.8875 0.8875", "m11.475 11.475 0.8875 0.8875", "m0.625 7.5 1.25 0", "m13.125 7.5 1.25 0", "m2.6374999999999997 12.3625 0.8875 -0.8875", "m11.475 3.525 0.8875 -0.8875"],
    moon: ["M13.125 7.9937499999999995A5.625 5.625 0 1 1 7.0062500000000005 1.875 4.375 4.375 0 0 0 13.125 7.9937499999999995z"],
  };
  function icon(name, cls) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "-0.5 -0.5 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("class", "icn" + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  }

  // Blocked badge for a puck waiting on unfinished dependencies (tooltip lists them).
  function blockBadge(item) {
    var b = el("span", "block-badge");
    b.appendChild(icon("slash"));
    var names = blockerItems(item).map(function (x) { return x.title; });
    b.title = "Blocked by: " + (names.join(", ") || item.blockedBy.join(", "));
    b.setAttribute("aria-label", b.title);
    return b;
  }

  // A card is a compact summary; tapping it opens the full detail in a modal
  // (fullscreen on mobile) so long bodies don't blow up the column height.
  function card(item) {
    var sig = signalMessages(item);
    var c = el("div", "card" + (item.native ? "" : " adapted") + (sig.length ? " flagged" : "") + (item.id === selectedId ? " sel" : ""));
    c.setAttribute("data-id", item.id);
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

  // ── detail: a side pane on desktop, a modal overlay on mobile ──
  var detailPane, detailContent, workEl, selectedId = null;
  function isWide() { return window.matchMedia("(min-width: 900px)").matches; }
  function paneRefs() {
    if (!detailPane) {
      detailPane = document.getElementById("detailPane");
      detailContent = document.getElementById("detailContent");
      workEl = document.getElementById("work");
    }
  }

  // Build the full puck detail into `container` — shared by both surfaces.
  function fillDetail(container, item) {
    container.innerHTML = "";
    container.style.setProperty("--repo", item.repoColor);
    container.appendChild(el("h2", "modal-title", item.title));

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
    container.appendChild(meta);

    buildStatusEditor(item, container); // status buttons (token + native puck only)

    if (item.tags.length || !item.native) {
      var tags = el("div", "card-tags");
      item.tags.forEach(function (t) { tags.appendChild(el("span", "tagpill", "#" + t)); });
      if (!item.native) tags.appendChild(el("span", "adapted-badge", "adapted"));
      container.appendChild(tags);
    }

    var sig = signalMessages(item);
    if (sig.length) {
      var flags = el("div", "card-flags");
      sig.forEach(function (m) { flags.appendChild(el("div", "flag", "⚠ " + m)); });
      container.appendChild(flags);
    }

    if ((item.blockedBy || []).length) {
      var blk = el("div", "modal-blocked");
      blk.appendChild(icon("slash", "inline"));
      blk.appendChild(document.createTextNode("Blocked by: "));
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
      container.appendChild(blk);
    }

    var body = el("div", "modal-body");
    body.innerHTML = renderMd(item.body || "(no details)");
    container.appendChild(body);

    if (ghToken() && item.native) {
      var editBtn = el("button", "linklike body-edit", "✎ Edit body");
      editBtn.type = "button";
      editBtn.addEventListener("click", function () { startBodyEdit(item, body, editBtn); });
      container.appendChild(editBtn);
    }

    var links = el("div", "card-links");
    var srcLink = linkEl("source", item.sourceUrl);
    srcLink.insertBefore(icon("external", "inline"), srcLink.firstChild);
    links.appendChild(srcLink);
    if (item.issue) {
      links.appendChild(linkEl("issue #" + item.issue, "https://github.com/" + item.repo + "/issues/" + item.issue));
    }
    var copyBtn = el("button", "linklike");
    copyBtn.type = "button";
    copyBtn.appendChild(icon("share", "inline"));
    var copyLabel = el("span", null, "Copy link");
    copyBtn.appendChild(copyLabel);
    copyBtn.addEventListener("click", function () {
      var url = location.origin + location.pathname + "#" + item.id;
      copyText(url, function () {
        copyLabel.textContent = "Copied";
        setTimeout(function () { copyLabel.textContent = "Copy link"; }, 1500);
      });
    });
    links.appendChild(copyBtn);
    container.appendChild(links);
  }

  // Router: side pane on desktop, modal on mobile. Both reflect the URL hash.
  function openModal(item) {
    if (isWide()) openDetail(item);
    else openOverlay(item);
    setHash(item.id);
  }
  function openOverlay(item) {
    modalPanel.style.setProperty("--repo", item.repoColor);
    fillDetail(modalContent, item);
    modalBackdrop.hidden = false;
    document.body.classList.add("modal-open");
    modalContent.scrollTop = 0;
  }
  function openDetail(item) {
    paneRefs();
    fillDetail(detailContent, item);
    detailPane.hidden = false;
    workEl.classList.add("has-detail");
    detailContent.scrollTop = 0;
    selectedId = item.id;
    highlightSelected();
  }
  function highlightSelected() {
    var nodes = document.querySelectorAll("#board .card, #board .list-row");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle("sel", !!selectedId && nodes[i].getAttribute("data-id") === selectedId);
    }
  }

  function closeModal() {
    if (location.hash) setHash(null);
    if (modalBackdrop) {
      modalBackdrop.hidden = true;
      document.body.classList.remove("modal-open");
    }
    closeDetail();
  }
  function closeDetail() {
    paneRefs();
    selectedId = null;
    if (workEl) workEl.classList.remove("has-detail");
    if (detailPane) detailPane.hidden = true;
    highlightSelected();
  }

  // A compact list row — denser than a card, one vertical column, tap → modal.
  function listRow(item) {
    var sig = signalMessages(item);
    var r = el("div", "list-row" + (sig.length ? " flagged" : "") + (item.id === selectedId ? " sel" : ""));
    r.setAttribute("data-id", item.id);
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
    // Ready is a focused work queue → always the grouped list, whatever the layout toggle says.
    var layout = state.focus === "ready" ? "list" : state.view;
    board.classList.toggle("as-list", layout === "list");
    var visible = DATA.items.filter(matches).sort(sortComparator());
    var statuses = DATA.statuses.filter(function (s) {
      return s !== "done" || state.showDone || state.focus === "attention";
    });

    if (layout === "list") renderList(visible, statuses);
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

  // Cockpit focus — Ready (unblocked now/next) · All · ⚠ (flagged). The primary
  // way to steer the board: Ready is the actionable work queue, ⚠ is drift.
  function buildFocusControl() {
    var flaggedCount = DATA.items.filter(isFlagged).length;
    var seg = el("div", "focusseg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Focus");
    var defs = [
      { key: "ready", label: "Ready", title: "Unblocked now/next — pick one up or hand it to an agent" },
      { key: "all", label: "All", title: "Every puck" },
    ];
    if (flaggedCount) defs.push({ key: "attention", label: "⚠ " + flaggedCount, title: "Pucks whose declared status disagrees with reality" });
    var btns = {};
    defs.forEach(function (d) {
      var b = el("button", "focusbtn focus-" + d.key + (state.focus === d.key ? " on" : ""), d.label);
      b.type = "button";
      b.title = d.title;
      b.setAttribute("aria-pressed", state.focus === d.key ? "true" : "false");
      b.addEventListener("click", function () {
        state.focus = d.key;
        Object.keys(btns).forEach(function (k) {
          btns[k].classList.toggle("on", k === d.key);
          btns[k].setAttribute("aria-pressed", k === d.key ? "true" : "false");
        });
        renderBoard();
      });
      btns[d.key] = b;
      seg.appendChild(b);
    });
    var filters = document.getElementById("filters");
    filters.insertBefore(seg, filters.firstChild);
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
  function updateThemeButton() {
    themeBtn.innerHTML = "";
    // Show the icon of the mode a tap switches TO (dark now → sun to go light).
    themeBtn.appendChild(icon(effectiveIsDark() ? "sun" : "moon"));
  }
  themeBtn.addEventListener("click", function () {
    var next = effectiveIsDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("roadmap-theme", next); } catch (e) {}
    applyThemeColor();
    updateThemeButton();
    themeBtn.blur();
  });
  // Follow the system scheme while on "auto" (no explicit toggle yet).
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      applyThemeColor();
      updateThemeButton();
    });
  }
  applyThemeColor();
  updateThemeButton();

  // ── view toggle (board ⇄ list, remembered) ──
  var viewBtn = document.getElementById("viewToggle");
  function updateViewButton() {
    var isList = state.view === "list";
    // Icon = the current view (no persistent .active highlight — it read as a
    // stuck focus ring); the title says what a tap does.
    viewBtn.innerHTML = "";
    viewBtn.appendChild(icon(isList ? "grid" : "list"));
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
  buildFocusControl();
  updateViewButton();
  setFilters(window.matchMedia("(min-width: 601px)").matches);
  renderBoard();

  // ── GUI editing: write pucks back to git from the browser ────────────────
  // Zero-backend. With a fine-grained GitHub token (kept only in this browser's
  // localStorage) the board commits roadmap/<slug>.md straight to api.github.com
  // — the same edit the CLI makes, from the web. Edit controls appear only when a
  // token is set, so the public board is identical for everyone else.
  var TOKEN_KEY = "roadmap-gh-token";
  function ghToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setGhToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64decode(b) { return decodeURIComponent(escape(atob(String(b).replace(/\s/g, "")))); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function branchOf(item) { var m = /\/blob\/([^/]+)\//.exec(item.sourceUrl || ""); return m ? m[1] : "main"; }

  // Format-preserving frontmatter edit — mirrors scripts/roadmap.mjs setField.
  function editFrontmatter(text, key, value) {
    var nl = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[0] !== "---") return null;
    var end = -1;
    for (var i = 1; i < lines.length; i++) { if (lines[i] === "---") { end = i; break; } }
    if (end < 0) return null;
    var out = key + ": " + value, done = false;
    for (var j = 1; j < end; j++) {
      if (new RegExp("^" + key + ":").test(lines[j])) { lines[j] = out; done = true; break; }
    }
    if (!done) lines.splice(end, 0, out);
    return lines.join(nl);
  }

  // Commit a status change via the GitHub Contents API (read sha → PUT commit).
  function commitStatus(item, status) {
    var token = ghToken();
    var apiPath = item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + apiPath;
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("read failed (" + r.status + ")"); return r.json(); })
      .then(function (info) {
        var text = b64decode(info.content);
        var out = editFrontmatter(text, "status", status);
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + " → " + status, content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { if (!r.ok) throw new Error("write failed (" + r.status + ")"); });
  }

  // Optimistic: flip in-memory + re-render now, commit in the background, revert on failure.
  function changeStatus(item, status) {
    if (status === item.status || !ghToken()) return;
    var prevS = item.status, prevU = item.updated;
    item.status = status; item.updated = today();
    renderBoard(); openModal(item);
    toast("Saving…");
    commitStatus(item, status)
      .then(function () { toast("✓ Saved — live in ~1 min"); })
      .catch(function (err) {
        item.status = prevS; item.updated = prevU;
        renderBoard(); openModal(item);
        toast("✗ " + err.message, true);
      });
  }

  // Replace the body (everything after the frontmatter fence), keeping the
  // frontmatter byte-identical.
  function replaceBody(text, newBody) {
    var nl = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[0] !== "---") return null;
    var end = -1;
    for (var i = 1; i < lines.length; i++) { if (lines[i] === "---") { end = i; break; } }
    if (end < 0) return null;
    var fm = lines.slice(0, end + 1);
    var b = newBody.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
    return fm.concat([""], b, [""]).join(nl);
  }

  // Commit an edited body via the Contents API (read sha → PUT), bumping updated.
  function commitBody(item, newBody) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("read failed (" + r.status + ")"); return r.json(); })
      .then(function (info) {
        var out = replaceBody(b64decode(info.content), newBody);
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + " edit body", content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { if (!r.ok) throw new Error("write failed (" + r.status + ")"); });
  }

  // Swap the rendered body for a textarea; Save commits, Cancel restores.
  function startBodyEdit(item, bodyEl, editBtn) {
    editBtn.style.display = "none";
    var ta = document.createElement("textarea");
    ta.className = "body-editor";
    ta.value = item.body || "";
    var actions = el("div", "body-edit-actions");
    var save = el("button", "tbtn primary", "Save");
    var cancel = el("button", "tbtn", "Cancel");
    save.type = "button"; cancel.type = "button";
    actions.appendChild(save); actions.appendChild(cancel);
    bodyEl.innerHTML = ""; bodyEl.appendChild(ta); bodyEl.appendChild(actions);
    ta.focus();
    function restore(md) { bodyEl.innerHTML = renderMd(md || "(no details)"); editBtn.style.display = ""; }
    cancel.addEventListener("click", function () { restore(item.body); });
    save.addEventListener("click", function () {
      var newBody = ta.value, prev = item.body;
      item.body = newBody; item.updated = today();
      restore(newBody);
      toast("Saving…");
      commitBody(item, newBody)
        .then(function () { toast("✓ Saved — live in ~1 min"); })
        .catch(function (err) { item.body = prev; restore(prev); toast("✗ " + err.message, true); });
    });
  }

  // Status editor inside the modal — native pucks only, token set.
  function buildStatusEditor(item, container) {
    if (!ghToken() || !item.native) return;
    var row = el("div", "edit-status");
    row.appendChild(el("span", "edit-label", "Set status"));
    DATA.statuses.forEach(function (s) {
      var b = el("button", "edit-btn status-" + s + (s === item.status ? " active" : ""), STATUS_LABEL[s] || s);
      b.type = "button";
      if (s === item.status) b.disabled = true;
      else b.addEventListener("click", function () { changeStatus(item, s); });
      row.appendChild(b);
    });
    (container || modalContent).appendChild(row);
  }

  // Toast
  var toastEl, toastTimer;
  function toast(msg, isErr) {
    if (!toastEl) { toastEl = el("div", "toast"); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = "toast"; }, isErr ? 6000 : 2600);
  }

  // slugify — a byte-for-byte copy of scripts/lib/adapters.mjs so a GUI-created
  // puck lands at the same path the harvester derives from the title.
  function slugify(s) {
    return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
  }

  // The new-puck file body — mirrors `roadmap new` in scripts/roadmap.mjs.
  function puckTemplate(title, status, tags) {
    var t = /[:#]/.test(title) ? JSON.stringify(title) : title;
    var lines = ["---", "title: " + t, "status: " + status];
    if (tags.length) lines.push("tags: [" + tags.join(", ") + "]");
    lines.push("updated: " + today(), "created: " + today(), "---", "", "## Mål", "", "", "## Research", "", "", "## Öppna frågor", "- ", "");
    return lines.join("\n");
  }

  // Where a repo keeps its pucks + which branch — derived from an existing item
  // of that repo (falls back to the convention default).
  function sourceMeta(repo) {
    var it = DATA.items.filter(function (x) { return x.repo === repo; })[0];
    var dir = "roadmap", branch = "main";
    if (it) { var p = it.sourcePath.split("/"); p.pop(); dir = p.join("/") || "roadmap"; branch = branchOf(it); }
    return { dir: dir, branch: branch };
  }

  // Create a new file via the Contents API (no sha = create; 422 = already exists).
  function commitCreate(repo, path, branch, content, message) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    return fetch(api, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, content: b64encode(content), branch: branch }),
    }).then(function (r) { if (!r.ok) throw new Error(r.status === 422 ? "already exists" : "create failed (" + r.status + ")"); });
  }

  // Optimistic create: add to the board now, commit in the background, revert on failure.
  function createPuck(repo, title, status, tags) {
    var slug = slugify(title);
    var short = repo.split("/").pop();
    var id = short + "/" + slug;
    if (DATA.items.some(function (x) { return x.id === id; })) { toast('✗ A puck "' + slug + '" already exists here', true); return; }
    var src = DATA.sources.filter(function (s) { return s.repo === repo; })[0] || {};
    var meta = sourceMeta(repo);
    var path = meta.dir + "/" + slug + ".md";
    var body = "## Mål\n\n\n## Research\n\n\n## Öppna frågor\n- ";
    var item = {
      id: id, repo: repo, repoName: src.name || short, repoColor: src.color || "#888888",
      issueState: null, slug: slug, title: title, status: status, tags: tags, updated: today(),
      created: today(), issue: null, order: 0, depends: [], owner: null, body: body,
      sourcePath: path, sourceUrl: "https://github.com/" + repo + "/blob/" + meta.branch + "/" + path,
      adapter: "pucks", native: true, blockedBy: [], signals: [],
    };
    DATA.items.push(item); DATA.total += 1;
    renderBoard(); openModal(item);
    toast("Creating…");
    commitCreate(repo, path, meta.branch, puckTemplate(title, status, tags), "roadmap: add " + slug)
      .then(function () { toast("✓ Created — live in ~1 min"); })
      .catch(function (err) {
        var i = DATA.items.indexOf(item); if (i >= 0) DATA.items.splice(i, 1);
        DATA.total -= 1; renderBoard(); closeModal();
        toast("✗ " + err.message, true);
      });
  }

  // 🔑 edit-access + ＋ new-puck controls in the header.
  var tokenBtn, newBtn;
  function refreshEditControls() {
    if (tokenBtn) tokenBtn.classList.toggle("on", !!ghToken());
    if (newBtn) newBtn.hidden = !ghToken();
  }
  function buildEditControls() {
    var host = document.getElementById("theme");
    if (!host || !host.parentNode) return;
    newBtn = el("button", "iconbtn newpuckbtn", "＋");
    newBtn.type = "button"; newBtn.title = "New puck"; newBtn.hidden = !ghToken();
    newBtn.addEventListener("click", openNewPuckPanel);
    host.parentNode.insertBefore(newBtn, host);
    tokenBtn = el("button", "iconbtn tokenbtn");
    tokenBtn.type = "button";
    tokenBtn.appendChild(icon("key"));
    tokenBtn.title = "Edit access — set a GitHub token to edit pucks from the board";
    tokenBtn.classList.toggle("on", !!ghToken());
    tokenBtn.addEventListener("click", function () { openTokenPanel(refreshEditControls); });
    host.parentNode.insertBefore(tokenBtn, host);
  }

  function field(labelText, control) {
    var d = el("div", "np-field");
    var l = el("label", null, labelText); d.appendChild(l); d.appendChild(control);
    return d;
  }
  function selectEl(cls, opts, value) {
    var s = document.createElement("select"); s.className = cls;
    opts.forEach(function (o) { var e = document.createElement("option"); e.value = o.value; e.textContent = o.label; s.appendChild(e); });
    if (value != null) s.value = value;
    return s;
  }
  function openNewPuckPanel() {
    if (!ghToken()) return;
    var back = el("div", "token-backdrop");
    var p = el("div", "token-panel");
    p.appendChild(el("h3", "token-title", "New puck"));
    var proj = selectEl("np-select", DATA.sources.map(function (s) { return { value: s.repo, label: s.name }; }),
      DATA.sources.some(function (s) { return s.repo === "tor2dbear/roadmap"; }) ? "tor2dbear/roadmap" : null);
    var title = el("input", "token-input"); title.type = "text"; title.placeholder = "Title"; title.autocomplete = "off";
    var st = selectEl("np-select", DATA.statuses.map(function (s) { return { value: s, label: STATUS_LABEL[s] || s }; }), "inbox");
    var tg = el("input", "token-input"); tg.type = "text"; tg.placeholder = "tags (comma-separated)"; tg.autocomplete = "off";
    var preview = el("div", "np-preview", "");
    function updatePreview() {
      var m = sourceMeta(proj.value);
      preview.textContent = title.value.trim() ? "→ " + m.dir + "/" + slugify(title.value) + ".md" : "";
    }
    title.addEventListener("input", updatePreview); proj.addEventListener("change", updatePreview);
    p.appendChild(field("Project", proj));
    p.appendChild(field("Title", title));
    p.appendChild(preview);
    p.appendChild(field("Status", st));
    p.appendChild(field("Tags", tg));
    var actions = el("div", "token-actions");
    var create = el("button", "tbtn primary", "Create");
    var cancel = el("button", "tbtn", "Cancel");
    function close() { if (back.parentNode) document.body.removeChild(back); }
    create.addEventListener("click", function () {
      var t = title.value.trim();
      if (!t) { title.focus(); return; }
      var tags = tg.value.split(",").map(function (x) { return slugify(x); }).filter(Boolean);
      close(); createPuck(proj.value, t, st.value, tags);
    });
    cancel.addEventListener("click", close);
    actions.appendChild(create); actions.appendChild(cancel);
    p.appendChild(actions);
    back.appendChild(p);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    title.focus();
  }

  function openTokenPanel(after) {
    var back = el("div", "token-backdrop");
    var p = el("div", "token-panel");
    p.appendChild(el("h3", "token-title", "Edit access"));
    p.appendChild(el("p", "token-note",
      "Paste a GitHub fine-grained token with Contents: write on your roadmap repo(s). It’s stored only in this browser and used to commit edits straight to GitHub."));
    var help = el("a", "token-help", "Create a fine-grained token ↗");
    help.href = "https://github.com/settings/personal-access-tokens/new";
    help.target = "_blank"; help.rel = "noopener";
    p.appendChild(help);
    var inp = el("input", "token-input");
    inp.type = "password"; inp.placeholder = "github_pat_…"; inp.value = ghToken();
    inp.autocomplete = "off"; inp.spellcheck = false;
    p.appendChild(inp);
    var actions = el("div", "token-actions");
    var save = el("button", "tbtn primary", "Save");
    var clear = el("button", "tbtn", "Clear");
    var cancel = el("button", "tbtn", "Cancel");
    function close() { if (back.parentNode) document.body.removeChild(back); }
    save.addEventListener("click", function () {
      var v = inp.value.trim(); setGhToken(v); if (after) after(); close();
      toast(v ? "Token saved — open a puck to edit" : "Token cleared");
    });
    clear.addEventListener("click", function () { setGhToken(""); inp.value = ""; if (after) after(); close(); toast("Token cleared"); });
    cancel.addEventListener("click", close);
    actions.appendChild(save); actions.appendChild(clear); actions.appendChild(cancel);
    p.appendChild(actions);
    back.appendChild(p);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    inp.focus();
  }

  buildEditControls();

  // Deep link: open the puck named in the URL hash on load, and react to the
  // hash changing (pasted link in the same tab, or Back after opening a modal).
  var detailCloseBtn = document.getElementById("detailClose");
  if (detailCloseBtn) detailCloseBtn.addEventListener("click", closeModal);

  // If the viewport crosses the desktop/mobile line while a puck is open, move
  // it to the right surface (pane ⇄ overlay) so it never ends up in a dead one.
  window.addEventListener("resize", function () {
    var it = itemFromHash();
    if (!it) return;
    if (isWide()) {
      if (modalBackdrop) { modalBackdrop.hidden = true; document.body.classList.remove("modal-open"); }
      openDetail(it);
    } else {
      closeDetail();
      openOverlay(it);
    }
  });

  var deepItem = itemFromHash();
  if (deepItem) openModal(deepItem);
  window.addEventListener("hashchange", function () {
    var it = itemFromHash();
    if (it) openModal(it);
    else closeModal();
  });
})();
