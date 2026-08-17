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
  // Priority is an optional, ordered field (highest → lowest). Absence = none.
  var PRIORITIES = ["urgent", "high", "medium", "low"];
  var PRIORITY_LABEL = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
  // A small priority badge: filled signal bars, Linear-style. Level → filled bars.
  var PRIORITY_BARS = { urgent: 3, high: 3, medium: 2, low: 1 };
  function priorityBadge(level) {
    var b = el("span", "pri pri-" + level);
    b.title = "Priority: " + (PRIORITY_LABEL[level] || level);
    if (level === "urgent") {
      b.appendChild(document.createTextNode("!"));
    } else {
      var filled = PRIORITY_BARS[level] || 0;
      for (var i = 0; i < 3; i++) {
        b.appendChild(el("i", "pri-bar" + (i < filled ? " on" : "")));
      }
    }
    return b;
  }
  var state = {
    repos: new Set(), // empty = all
    tags: new Set(), // empty = all
    query: "",
    showDone: false,
    priorityFilter: null, // null = any; else one of PRIORITIES
    focus: "all", // "all" | "ready" (unblocked now/next) | "inbox" (triage) | "attention" (flagged)
    view: "board", // "board" (kanban columns) | "list" (one column, grouped by status)
    sort: "default", // see SORTS below
  };
  var SORTS = ["default", "priority", "updated-asc", "created-desc", "created-asc", "title"];
  var PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
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
    // Views: Ready = unblocked now/next; Inbox = triage (its own space); Attention
    // = flagged (drift); All = the committed board (now/next/later/done), no inbox.
    if (state.focus === "ready") {
      if (item.status !== "now" && item.status !== "next") return false;
      if ((item.blockedBy || []).length) return false;
    } else if (state.focus === "inbox") {
      if (item.status !== "inbox") return false; // dedicated triage surface
    } else if (state.focus === "attention") {
      if (!isFlagged(item)) return false; // flagged done surfaces even if "show done" is off
    } else {
      // "all" = the board of committed work; inbox lives in its own view.
      if (item.status === "inbox") return false;
      if (!state.showDone && item.status === "done") return false;
    }
    if (state.priorityFilter && item.priority !== state.priorityFilter) return false;
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
    if (item.priority) meta.appendChild(priorityBadge(item.priority));
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

  // A property row: mono key + value node. Add a field = add a row (growable).
  function propRow(k, valNode, cls) {
    var row = el("div", "prop" + (cls ? " prop-" + cls : ""));
    row.appendChild(el("span", "prop-k", k));
    var v = el("div", "prop-v");
    if (valNode != null) v.appendChild(valNode);
    row.appendChild(v);
    return row;
  }

  // A Linear-style editable property: a single chip showing the *current* value;
  // click opens a picker popover to change it. Static chip when not editable. This
  // is the growable pattern — a new field is one more propPicker, not a button row.
  //   opts: { editable, current, options:[{value,label}], valueNode(o), onPick(v) }
  function propPicker(opts) {
    var cur = null;
    for (var i = 0; i < opts.options.length; i++) if (opts.options[i].value === opts.current) cur = opts.options[i];
    var chip = el("button", "pick-chip");
    chip.type = "button";
    function paint(node) { chip.innerHTML = ""; chip.appendChild(node); }
    paint(cur ? opts.valueNode(cur) : el("span", "prop-muted", opts.placeholder || "—"));
    if (!opts.editable) { chip.classList.add("static"); chip.disabled = true; return chip; }
    chip.classList.add("editable");
    chip.appendChild(el("span", "pick-caret", "▾"));
    var wrap = el("div", "prop-pick");
    chip.addEventListener("click", function (e) {
      e.stopPropagation();
      if (wrap.querySelector(".pick-menu")) { closeMenu(); return; }
      var menu = el("div", "pick-menu");
      opts.options.forEach(function (o) {
        var mi = el("button", "pick-mi" + (o.value === opts.current ? " on" : ""));
        mi.type = "button";
        mi.appendChild(opts.valueNode(o));
        if (o.value === opts.current) mi.appendChild(el("span", "pick-check", "✓"));
        mi.addEventListener("click", function () { closeMenu(); if (o.value !== opts.current) opts.onPick(o.value); });
        menu.appendChild(mi);
      });
      wrap.appendChild(menu);
      setTimeout(function () {
        document.addEventListener("click", function closer(ev) {
          if (!wrap.contains(ev.target)) { closeMenu(); document.removeEventListener("click", closer); }
        });
      }, 0);
    });
    function closeMenu() { var m = wrap.querySelector(".pick-menu"); if (m) m.remove(); }
    wrap.appendChild(chip);
    return wrap;
  }

  // Build the full puck detail into `container` — shared by both surfaces.
  // Structure: breadcrumb → title → properties rail → details (body) → links.
  function fillDetail(container, item) {
    container.innerHTML = "";
    container.style.setProperty("--repo", item.repoColor);

    var crumb = el("div", "detail-crumb");
    var home = el("button", "crumb-home", VIEW_TITLES[state.focus] || "Board");
    home.type = "button";
    home.title = "Back to the board";
    home.addEventListener("click", function () { closeModal(); });
    crumb.appendChild(home);
    crumb.appendChild(el("span", "crumb-sep", "›"));
    var cdot = el("span", "repo-dot");
    cdot.style.background = item.repoColor;
    crumb.appendChild(cdot);
    crumb.appendChild(el("span", "crumb-cur", item.repoName + " · " + item.slug));
    container.appendChild(crumb);

    container.appendChild(el("h2", "modal-title", item.title));

    // ── properties rail — discrete rows, Linear-style ──
    var props = el("div", "props");

    var editable = ghToken() && item.native;

    // Status: current value as a chip; click to pick (editable) — Linear-style.
    props.appendChild(propRow("Status", propPicker({
      editable: editable,
      current: item.status,
      options: DATA.statuses.map(function (s) { return { value: s, label: STATUS_LABEL[s] || s }; }),
      valueNode: function (o) { return el("span", "status-pill status-" + o.value, o.label); },
      onPick: function (v) { changeStatus(item, v); },
    })));

    // Priority: same pattern. Shown when editable or when the puck has one set.
    if (editable || item.priority) {
      props.appendChild(propRow("Priority", propPicker({
        editable: editable,
        current: item.priority || null,
        placeholder: "No priority",
        options: [{ value: null, label: "No priority" }].concat(
          PRIORITIES.map(function (p) { return { value: p, label: PRIORITY_LABEL[p] }; })),
        valueNode: function (o) {
          if (!o.value) return el("span", "prop-muted", "No priority");
          var v = el("span", "pri-inline");
          v.appendChild(priorityBadge(o.value));
          v.appendChild(document.createTextNode(" " + (PRIORITY_LABEL[o.value] || o.value)));
          return v;
        },
        onPick: function (v) { changePriority(item, v); },
      })));
    }

    props.appendChild(propRow("Assignee", item.owner
      ? ownerEl(item.owner, { name: true, link: true })
      : el("span", "prop-muted", "—")));

    if (item.tags.length || !item.native) {
      var tags = el("div", "card-tags");
      item.tags.forEach(function (t) { tags.appendChild(el("span", "tagpill", "#" + t)); });
      if (!item.native) tags.appendChild(el("span", "adapted-badge", "adapted"));
      props.appendChild(propRow("Labels", tags));
    }

    if ((item.blockedBy || []).length) {
      var blkV = el("div", "prop-blockers");
      var blockers = blockerItems(item);
      if (blockers.length) {
        blockers.forEach(function (b, i) {
          var a = el("a", "blocker-link", b.title);
          a.href = "#" + b.id;
          a.addEventListener("click", function (e) { e.preventDefault(); openModal(b); });
          blkV.appendChild(a);
          if (i < blockers.length - 1) blkV.appendChild(document.createTextNode(", "));
        });
      } else {
        blkV.appendChild(document.createTextNode(item.blockedBy.join(", ")));
      }
      props.appendChild(propRow("Blocked by", blkV, "blocked"));
    }

    if (item.created) props.appendChild(propRow("Created", el("span", "prop-date", item.created)));
    if (item.updated) props.appendChild(propRow("Updated", el("span", "prop-date", item.updated)));
    container.appendChild(props);

    var sig = signalMessages(item);
    if (sig.length) {
      var flags = el("div", "card-flags");
      sig.forEach(function (m) { flags.appendChild(el("div", "flag", "⚠ " + m)); });
      container.appendChild(flags);
    }

    container.appendChild(el("div", "sect-label", "Details"));
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
    // Keep the app header visible on mobile: the sheet starts just below the
    // topbar (measured, so it's safe-area-proof) instead of covering it, and the
    // topbar sits above the backdrop (z-index) so ☰ / search stay usable.
    var tb = document.querySelector(".topbar");
    modalBackdrop.style.top = tb && !isWide() ? Math.round(tb.getBoundingClientRect().bottom) + "px" : "";
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
      modalBackdrop.style.top = "";
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
    if (state.sort === "priority") {
      return function (a, b) {
        var ar = a.priority ? PRIORITY_RANK[a.priority] : 9;
        var br = b.priority ? PRIORITY_RANK[b.priority] : 9;
        if (ar !== br) return ar - br;
        return (b.updated || "").localeCompare(a.updated || "") || a.title.localeCompare(b.title);
      };
    }
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
    // Ready and Inbox are focused queues → always the grouped list, whatever the toggle says.
    var queue = state.focus === "ready" || state.focus === "inbox";
    var layout = queue ? "list" : state.view;
    board.classList.toggle("as-list", layout === "list");
    var visible = DATA.items.filter(matches).sort(sortComparator());
    var statuses = columnsForFocus();

    if (layout === "list") renderList(visible, statuses);
    else renderColumns(visible, statuses);

    var shown = visible.length;
    updateViewHeader(shown);
    document.getElementById("footmeta").textContent =
      shown + " of " + DATA.total + " shown · generated " + DATA.generatedAt.slice(0, 16).replace("T", " ") + " UTC · ";
  }

  // Which status groups the current view shows. Inbox is its own space, so it's
  // absent from every board view except the Inbox view itself.
  function columnsForFocus() {
    if (state.focus === "inbox") return ["inbox"];
    if (state.focus === "ready") return ["now", "next"];
    if (state.focus === "attention") return DATA.statuses; // flagged can be any status
    // "all" = the committed board: now/next/later (+done when shown), never inbox.
    return DATA.statuses.filter(function (s) {
      return s !== "inbox" && (s !== "done" || state.showDone);
    });
  }

  // The consistent view-header reflects the current focus + how many are shown.
  var VIEW_TITLES = { all: "All pucks", ready: "Ready to take", inbox: "Inbox", attention: "Needs attention" };
  function updateViewHeader(shown) {
    var title = VIEW_TITLES[state.focus] || "All pucks";
    var count = shown != null ? String(shown) : "";
    // Desktop: title lives in the view-header. Mobile: in the topbar (fills the
    // otherwise-empty band between the menu and search). CSS shows one per width.
    ["viewTitle", "topTitle"].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = title; });
    ["viewCount", "topCount"].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = count; });
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

  // Disciplines (tags) as a sidebar section — top N by count + a "more" expander.
  function buildTagChips() {
    var counts = {};
    DATA.items.forEach(function (it) {
      it.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    var wrap = document.getElementById("tagFilters");
    if (!wrap) return;
    var CAP = 10;
    function chipFor(t) {
      var chip = el("button", "chip tag");
      chip.setAttribute("aria-pressed", "false");
      chip.appendChild(document.createTextNode("#" + t));
      chip.appendChild(el("span", "n", String(counts[t])));
      chip.addEventListener("click", function () { toggleSet(state.tags, t, chip); renderBoard(); });
      return chip;
    }
    tags.slice(0, CAP).forEach(function (t) { wrap.appendChild(chipFor(t)); });
    if (tags.length > CAP) {
      var more = el("button", "side-more", "＋ " + (tags.length - CAP) + " more");
      more.type = "button";
      more.addEventListener("click", function () {
        tags.slice(CAP).forEach(function (t) { wrap.insertBefore(chipFor(t), more); });
        more.remove();
      });
      wrap.appendChild(more);
    }
  }

  function toggleSet(set, key, chip) {
    if (set.has(key)) { set.delete(key); chip.setAttribute("aria-pressed", "false"); }
    else { set.add(key); chip.setAttribute("aria-pressed", "true"); }
  }

  // Views — the primary navigation: All pucks (the committed board) · Ready (the
  // actionable queue) · Inbox (triage of raw ideas, its own space) · ⚠ Needs
  // attention (drift). Each is a nav row with a live count and a clear active state.
  function viewCounts() {
    var c = { all: 0, ready: 0, inbox: 0, attention: 0 };
    DATA.items.forEach(function (it) {
      if (it.status === "inbox") c.inbox++;
      else if (it.status !== "done") c.all++;
      if ((it.status === "now" || it.status === "next") && !(it.blockedBy || []).length) c.ready++;
      if (isFlagged(it)) c.attention++;
    });
    return c;
  }
  function buildFocusControl() {
    var counts = viewCounts();
    var seg = el("div", "focusseg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Views");
    var defs = [
      { key: "all", label: "All pucks", title: "The committed board — now/next/later" },
      { key: "ready", label: "Ready", title: "Unblocked now/next — pick one up or hand it to an agent" },
      { key: "inbox", label: "Inbox", title: "Raw ideas to triage — nothing here is a promise yet" },
    ];
    if (counts.attention) defs.push({ key: "attention", label: "Needs attention", title: "Pucks whose declared status disagrees with reality" });
    var btns = {};
    defs.forEach(function (d) {
      var b = el("button", "focusbtn focus-" + d.key + (state.focus === d.key ? " on" : ""));
      b.type = "button";
      b.title = d.title;
      b.setAttribute("aria-pressed", state.focus === d.key ? "true" : "false");
      b.appendChild(el("span", "focus-label", d.label));
      if (counts[d.key]) b.appendChild(el("span", "focus-n", String(counts[d.key])));
      b.addEventListener("click", function () {
        state.focus = d.key;
        Object.keys(btns).forEach(function (k) {
          btns[k].classList.toggle("on", k === d.key);
          btns[k].setAttribute("aria-pressed", k === d.key ? "true" : "false");
        });
        renderBoard();
        maybeCloseMenu();
      });
      btns[d.key] = b;
      seg.appendChild(b);
    });
    var host = document.getElementById("sideViews") || document.getElementById("filters");
    host.appendChild(seg);
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
    closeCmdk();
    openModal(it);
  }

  // ── ⌘K command palette (holds the search input) ──
  // Opened from the sidebar Search button (desktop) or the topbar icon (mobile,
  // where the sidebar is behind the menu) — both are plain buttons, not fake inputs.
  var cmdkOverlay = document.getElementById("cmdkOverlay");
  var cmdkTriggers = [document.getElementById("sideSearch"), document.getElementById("topSearch")];
  function openCmdk() {
    if (!cmdkOverlay) return;
    cmdkOverlay.hidden = false;
    document.body.classList.add("cmdk-open");
    searchInput.focus();
    searchInput.select();
    updateSuggestions();
  }
  function closeCmdk() {
    if (!cmdkOverlay || cmdkOverlay.hidden) return;
    cmdkOverlay.hidden = true;
    document.body.classList.remove("cmdk-open");
    // Palette is navigation, not a lingering board filter — reset the query on close.
    if (searchInput.value) { searchInput.value = ""; state.query = ""; updateSearchClear(); renderBoard(); }
    hideSuggestions();
  }
  cmdkTriggers.forEach(function (t) { if (t) t.addEventListener("click", function () { openCmdk(); maybeCloseMenu(); }); });
  if (cmdkOverlay) cmdkOverlay.addEventListener("mousedown", function (e) { if (e.target === cmdkOverlay) closeCmdk(); });
  document.addEventListener("keydown", function (e) {
    var k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === "k") { e.preventDefault(); cmdkOverlay && cmdkOverlay.hidden ? openCmdk() : closeCmdk(); return; }
    // "/" opens search when not already typing in a field
    if (k === "/" && !e.metaKey && !e.ctrlKey) {
      var t = e.target;
      var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (!typing) { e.preventDefault(); openCmdk(); return; }
    }
    if (k === "escape" && cmdkOverlay && !cmdkOverlay.hidden) { closeCmdk(); }
  });

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
  // ── Filter popover (view-header) — view-scoped filters: Show done + Priority.
  // Sidebar = scope (repos/disciplines); this = what the current view shows.
  function activeFilterCount() {
    return (state.showDone ? 1 : 0) + (state.priorityFilter ? 1 : 0);
  }
  function refreshFilterBadge() {
    var badge = document.getElementById("filterCount");
    var btn = document.getElementById("filterBtn");
    if (!badge || !btn) return;
    var n = activeFilterCount();
    badge.hidden = !n;
    badge.textContent = n ? String(n) : "";
    btn.classList.toggle("on", !!n);
  }
  var filterBtn = document.getElementById("filterBtn");
  function toggleFilterMenu() {
    var wrap = filterBtn && filterBtn.parentNode;
    if (!wrap) return;
    var open = wrap.querySelector(".filter-pop");
    if (open) { open.remove(); filterBtn.setAttribute("aria-expanded", "false"); return; }
    var pop = el("div", "filter-pop");

    // Show done
    var doneRow = el("label", "fp-toggle");
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = state.showDone;
    cb.addEventListener("change", function () { state.showDone = cb.checked; renderBoard(); refreshFilterBadge(); });
    doneRow.appendChild(cb); doneRow.appendChild(el("span", null, "Show done"));
    pop.appendChild(doneRow);

    // Priority
    pop.appendChild(el("div", "fp-label", "Priority"));
    var prow = el("div", "fp-chips");
    var opts = [{ v: null, l: "Any" }].concat(PRIORITIES.map(function (p) { return { v: p, l: PRIORITY_LABEL[p] }; }));
    opts.forEach(function (o) {
      var chip = el("button", "fp-chip" + (state.priorityFilter === o.v ? " on" : "") + (o.v ? " pri-" + o.v : ""), o.l);
      chip.type = "button";
      chip.addEventListener("click", function () {
        state.priorityFilter = o.v;
        prow.querySelectorAll(".fp-chip").forEach(function (c) { c.classList.remove("on"); });
        chip.classList.add("on");
        renderBoard(); refreshFilterBadge();
      });
      prow.appendChild(chip);
    });
    pop.appendChild(prow);

    wrap.appendChild(pop);
    filterBtn.setAttribute("aria-expanded", "true");
    setTimeout(function () {
      document.addEventListener("click", function closer(e) {
        if (!wrap.contains(e.target)) { pop.remove(); filterBtn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", closer); }
      });
    }, 0);
  }
  if (filterBtn) filterBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleFilterMenu(); });


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
  renderBoard();

  // ── mobile drawer: the sidebar slides in over a scrim ──
  var appEl = document.getElementById("app");
  var scrimEl = document.getElementById("scrim");
  var menuBtn = document.getElementById("menuToggle");
  function setMenu(open) {
    if (!appEl) return;
    appEl.classList.toggle("menu-open", open);
    if (scrimEl) scrimEl.hidden = !open;
  }
  function maybeCloseMenu() {
    if (window.matchMedia("(max-width: 899px)").matches) setMenu(false);
  }
  if (menuBtn) menuBtn.addEventListener("click", function () { setMenu(!appEl.classList.contains("menu-open")); });
  if (scrimEl) scrimEl.addEventListener("click", function () { setMenu(false); });

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

  // Remove a frontmatter field line (no-op if absent) — mirrors roadmap.mjs
  // removeField. Used to clear priority (absence of the field = no priority).
  function removeFrontmatter(text, key) {
    var nl = text.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    var lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[0] !== "---") return null;
    var end = -1;
    for (var i = 1; i < lines.length; i++) { if (lines[i] === "---") { end = i; break; } }
    if (end < 0) return null;
    for (var j = 1; j < end; j++) {
      if (new RegExp("^" + key + ":").test(lines[j])) { lines.splice(j, 1); break; }
    }
    return lines.join(nl);
  }

  // Commit a priority change via the Contents API. A null level clears the field.
  function commitPriority(item, priority) {
    var token = ghToken();
    var apiPath = item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + apiPath;
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("read failed (" + r.status + ")"); return r.json(); })
      .then(function (info) {
        var text = b64decode(info.content);
        var out = priority ? editFrontmatter(text, "priority", priority) : removeFrontmatter(text, "priority");
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + " priority " + (priority || "cleared"), content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { if (!r.ok) throw new Error("write failed (" + r.status + ")"); });
  }

  // Optimistic: flip in-memory + re-render, commit in the background, revert on failure.
  function changePriority(item, priority) {
    if (priority === (item.priority || null) || !ghToken()) return;
    var prevP = item.priority, prevU = item.updated;
    item.priority = priority; item.updated = today();
    renderBoard(); openModal(item);
    toast("Saving…");
    commitPriority(item, priority)
      .then(function () { toast("✓ Saved — live in ~1 min"); })
      .catch(function (err) {
        item.priority = prevP; item.updated = prevU;
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

  // ＋ new-puck control (sidebar foot).
  var newBtns = [], userEl;
  function refreshEditControls() {
    newBtns.forEach(function (b) { b.hidden = !ghToken(); });
  }
  function afterAuth() { refreshEditControls(); refreshUser(); }
  function buildEditControls() {
    // New: primary create action in the sidebar (desktop) + the mobile topbar
    // (next to search, so it's reachable without opening the menu). Token-gated.
    newBtns = ["sideNew", "topNew"].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    newBtns.forEach(function (b) {
      b.hidden = !ghToken();
      b.addEventListener("click", openNewPuckPanel);
    });
  }

  // A user chip at the top of the sidebar: your GitHub identity (derived from the
  // token via api.github.com) with a Sign out menu; or a "Sign in to edit" button
  // when no token is set. Replaces the key-in-the-foot.
  function buildUserControl() {
    var sb = document.getElementById("sidebar");
    var brand = sb && sb.querySelector(".side-brand");
    if (!brand) return;
    userEl = el("div", "side-user");
    brand.parentNode.insertBefore(userEl, brand.nextSibling);
    refreshUser();
  }
  function refreshUser() {
    if (!userEl) return;
    userEl.innerHTML = "";
    if (!ghToken()) {
      var signin = el("button", "user-signin");
      signin.type = "button";
      signin.appendChild(icon("key"));
      signin.appendChild(el("span", null, "Sign in to edit"));
      signin.addEventListener("click", function () { openTokenPanel(afterAuth); });
      userEl.appendChild(signin);
      return;
    }
    var chip = el("button", "user-chip");
    chip.type = "button";
    var av = el("span", "user-av");
    var name = el("span", "user-name", "…");
    chip.appendChild(av);
    chip.appendChild(name);
    chip.appendChild(el("span", "user-caret", "▾"));
    chip.addEventListener("click", function (e) { e.stopPropagation(); toggleUserMenu(); });
    userEl.appendChild(chip);
    fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + ghToken(), Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (u && u.login) {
          name.textContent = "@" + u.login;
          var img = document.createElement("img");
          img.className = "user-av-img"; img.alt = ""; img.src = u.avatar_url;
          av.appendChild(img);
        } else { name.textContent = "token invalid"; chip.classList.add("bad"); }
      })
      .catch(function () { name.textContent = "signed in"; });
  }
  function toggleUserMenu() {
    var open = userEl.querySelector(".user-menu");
    if (open) { open.remove(); return; }
    var menu = el("div", "user-menu");
    var change = el("button", "user-mi", "Change token");
    change.type = "button";
    change.addEventListener("click", function () { menu.remove(); openTokenPanel(afterAuth); });
    var out = el("button", "user-mi danger", "Sign out");
    out.type = "button";
    out.addEventListener("click", function () { menu.remove(); setGhToken(""); afterAuth(); });
    menu.appendChild(change);
    menu.appendChild(out);
    userEl.appendChild(menu);
    setTimeout(function () {
      document.addEventListener("click", function closer(e) {
        if (!userEl.contains(e.target)) { menu.remove(); document.removeEventListener("click", closer); }
      });
    }, 0);
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
    function close() { if (back.parentNode) document.body.removeChild(back); document.body.classList.remove("modal-open"); }
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
    document.body.classList.add("modal-open");
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
    function close() { if (back.parentNode) document.body.removeChild(back); document.body.classList.remove("modal-open"); }
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
    document.body.classList.add("modal-open");
    inp.focus();
  }

  buildEditControls();
  buildUserControl();

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
