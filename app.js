/* Roadmap aggregator UI. Reads window.__ROADMAP__ (from data/roadmap.js). */
(function () {
  "use strict";

  var DATA = window.__ROADMAP__;
  // ── demo mode ───────────────────────────────────────────────────────────────────
  // A board that is fully operable and commits nothing.
  //
  // The public demo is logged out, so every write affordance is gated off and a visitor
  // sees a read-only board — for a product whose whole claim is that both a human and an
  // agent write back to git. Demo mode unlocks the interface and answers GitHub locally.
  //
  // *One seam, not fifty.* The write paths are untouched and still speak to
  // api.github.com; the request is answered in the page instead of sent. That is what
  // makes the demo honest: the optimistic update, the rollback on failure, the toasts
  // and the sha bookkeeping are the same code the real board runs, exercised for real.
  //
  // Only `config.demo` turns it on — no URL parameter, no key combination. A switch that
  // silently stops committing must not be reachable on a board that has a token.
  var DEMO = !!(DATA && DATA.config && DATA.config.demo);
  // Up here rather than beside `ghToken`, where it used to sit and where it read more
  // naturally. `var` hoists the *declaration* and not the assignment, and the boot
  // render (`renderBoard()`, a top-level call) runs some thirty lines above the old
  // spot — so at first paint `ghToken()` was asking localStorage for the key
  // `undefined`, answering "" for a browser that had a token. Every token-gated
  // affordance was therefore missing until something re-rendered: open a shared link
  // with a filter in it and the chip row had no Save view until you touched the board;
  // click a sidebar row and it appeared. A constant read during boot has to be
  // assigned before boot, which on one long IIFE means the top.
  var TOKEN_KEY = "roadmap-gh-token";
  var board = document.getElementById("board");

  if (!DATA) {
    board.innerHTML =
      '<div class="banner">No data loaded. Run <code>node scripts/harvest.mjs</code> to' +
      " generate <code>data/roadmap.js</code>, then reload. When served over http this" +
      " page reads that file automatically.</div>";
    return;
  }

  // Drop the transition-suppression guard once the first frame has painted, so
  // real interactions animate but the initial load never does (see .preload CSS).
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { document.body.classList.remove("preload"); });
  });

  var STATUS_LABEL = { now: "Now", next: "Next", later: "Later", inbox: "Inbox", done: "Done", cancelled: "Cancelled" };
  // Terminal statuses: settled, hidden from the active board unless "show done" is on.
  var TERMINAL = { done: 1, cancelled: 1 };
  // Priority is an optional, ordered field (highest → lowest). Absence = none.
  var PRIORITIES = ["urgent", "high", "medium", "low"];
  var PRIORITY_LABEL = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
  // A small priority badge: filled signal bars, Linear-style. Level → filled bars.
  var PRIORITY_BARS = { urgent: 3, high: 3, medium: 2, low: 1 };
  function priorityBadge(level) {
    var b = el("span", "pri pri-" + level);
    b.title = "Priority: " + (PRIORITY_LABEL[level] || level);
    if (level === "urgent") {
      // Was the character "!" in a red square — the fourth mark on this board drawn as
      // text rather than as a path, after `warn`, `x` and the agent arrow. It slipped
      // past the sweep those three paid for, because that sweep guards the symbol
      // ranges and "!" is ASCII: the rule was "not a typographic character", the test
      // said "not one of these characters", and the gap between the two is exactly
      // where this sat. The sweep is widened in the same commit.
      b.appendChild(icon("alert", "pri-glyph"));
    } else {
      var filled = PRIORITY_BARS[level] || 0;
      for (var i = 0; i < 3; i++) {
        b.appendChild(el("i", "pri-bar" + (i < filled ? " on" : "")));
      }
    }
    return b;
  }
  // PO-layer: a puck can be routed to a discipline agent (backend/design/…). The
  // value is a free handle stored in git; these are the defaults the picker offers.
  var AGENT_DISCIPLINES = ["backend", "frontend", "design", "research", "ops"];
  function agentLabel(a) { return a ? a.charAt(0).toUpperCase() + a.slice(1) : a; }
  // Picker options: the default disciplines ∪ any agent already in use in the data.
  function agentOptions() {
    var set = {};
    AGENT_DISCIPLINES.forEach(function (a) { set[a] = true; });
    (DATA.items || []).forEach(function (it) { if (it.agent) set[it.agent] = true; });
    return Object.keys(set).sort();
  }
  // The status pill, in one place. Three call sites wrote this same line — the rail, the
  // palette and the blockers list — and the row and the card are now a fourth and fifth.
  // (The picker's `valueNode` keeps its own: it labels a *value*, not a puck.)
  function statusPill(st, cls) {
    return el("span", (cls ? cls + " " : "") + "status-pill status-" + st, STATUS_LABEL[st] || st);
  }
  function agentBadge(name) {
    var b = el("span", "agent-badge");
    b.title = "Routed to " + name;
    b.appendChild(icon("agent", "agent-glyph"));
    // The name in a box of its own, because the badge is an `inline-flex` and
    // `text-overflow` needs a block container — a bare text node there clips mid-letter
    // instead of ellipsising. The badge is the second field in a card's metadata row with
    // arbitrary text in it (the repo name is the first), and an agent handle has no length
    // limit at all, so it is the one that can push the row past the card on its own.
    b.appendChild(el("span", "agent-name", name));
    return b;
  }
  var state = {
    // One store. Repo and agent used to live in Sets of their own, because the sidebar
    // calls them *places* — where you are, rather than something you narrowed to. That
    // distinction is real and the rows stay, but it was never a reason for a second
    // memory: `controlTerms()` projected the Sets into terms and `readUrl` read them
    // back, "one model, two directions", which is a long way of saying the query could
    // always express it. Two stores that must agree eventually don't — the same URL drew
    // two different chromes depending on whether you clicked or reloaded, and the chip
    // row could not spell "repo" because repo lived somewhere the labeller never looked.
    // Both were symptoms of the pair, so the pair goes and the rows derive from the
    // query like every other control.
    query: "", // the filter, as text: the store behind the chips, the panel and the rows
    // Which saved view you navigated into, by name — and *only* that. It is not a
    // second copy of the filter: the query above still says what the board shows.
    // This says where the board came from, which nothing else can answer, because a
    // modified saved view is indistinguishable from any other filter by inspection.
    // Deliberately not in the URL. The parameters are what a link has to carry; adding
    // provenance would make it a second thing the link must agree with them about, and
    // a stale one the moment either side is hand-edited. So a reload of a modified view
    // is honestly just a filter, and says so.
    fromView: null,
    showDone: false,
    focus: "all", // "all" | "ready" (unblocked now/next) | "inbox" (triage) | "attention" (flagged)
    view: "board", // "board" (kanban columns) | "list" (one column, grouped)
    // The ordering, as a chain of keys — see SORT_FIELDS. Canonical when set: `applyParams`
    // runs every value through `parseSort`, so a legacy one-word mode never reaches here.
    // `null` means *no choice made*, which is the same distinction `props` draws two keys
    // down, and for the same reason: a grouping may propose an ordering (`sortChain`), and
    // an automation that applies in the absence of a choice needs an absence to read. It
    // was spelled `DEFAULT_SORT` before, which conflated the two — so under a grouping with
    // a proposal the chain `order,updated` could not be asked for at all. Measured on
    // `group=none`: building `[Manual]` and adding `Updated` gave back `[Status, Manual]`
    // and dropped `sort` from the URL, and `?sort=order,updated` drew `status,order`.
    sort: null,
    group: "status", // which field becomes the columns — see GROUPS
    showEmpty: true, // board only: keep a column that has no pucks (it's a drop target)
    // List-only: which groups are folded shut. A folded group is a *display*
    // preference, never puck truth, so it goes in the URL with the rest of the
    // display state (`done`, `empty`, `sort`, …) — which also makes it save into a
    // view for free, with no new machinery and no second store. The keys belong to
    // whichever field is grouping; changing the grouping leaves harmless leftovers
    // that match nothing. Not in the board layout: there a column header is a drop
    // target and carries `+`, so a click on it already means something else.
    collapsed: new Set(),
    // Which properties the card and the row draw. `null` means *no choice made*, which
    // is not the same as an empty one: the automatic date rule (`autoDateField`) applies
    // in the absence of a choice and never over one, so ticking every date off has to be
    // expressible. A Set with nothing in it is that; `null` is the board as it shipped.
    // In the URL as `props=` (a comma-separated list, or the literal `none` for the
    // empty choice, since an empty string is indistinguishable from an absent key once
    // it has been through a saved view).
    fields: null,
  };
  var PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
  // Display preferences persist (they're settings, not a transient filter) — but they
  // persist *to the view they were set in*, not to the board as a whole. There is no
  // read here any more, and that is the point: which memory to restore is a question
  // only the view can answer, and at this line there is no view yet. See
  // `restoreDisplay` and `readUrl`, where the three levels are ordered.

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
  function itemById(id) {
    for (var i = 0; i < DATA.items.length; i++) if (DATA.items[i].id === id) return DATA.items[i];
    return null;
  }
  // Dependencies, resolved. The harvester hands over ids (cross-repo included), so
  // both directions are a lookup: `blockedBy` = what still blocks me, `blocks` =
  // what I hold up. Only `depends:` is authored — `blocks` is the reverse edge.
  function blockerItems(item) { return (item.blockedBy || []).map(itemById).filter(Boolean); }
  function blockedItems(item) { return (item.blocks || []).map(itemById).filter(Boolean); }
  // One reference form for every puck-to-puck link, mirroring refKey() in the
  // harvester: a bare slug means "in my own repo", `owner/repo#slug` names one
  // anywhere on the board.
  function resolveRef(from, ref) {
    var s = String(ref || "").trim();
    var at = s.indexOf("#");
    var repo = at === -1 ? from.repo : s.slice(0, at);
    var slug = at === -1 ? s : s.slice(at + 1);
    for (var i = 0; i < DATA.items.length; i++) {
      if (DATA.items[i].repo === repo && DATA.items[i].slug === slug) return DATA.items[i];
    }
    return null;
  }
  // How this repo would name that puck: a bare slug at home, `owner/repo#slug`
  // across repos. Matches refKey() in the harvester, and is the one place both
  // `parent` and `depends` decide how a link is written.
  function refFor(from, target) {
    return target.repo === from.repo ? target.slug : target.repo + "#" + target.slug;
  }
  // The authored list, resolved — every declared blocker, landed ones included.
  // `blockedBy` is the *unfinished* subset, so editing has to work from this one:
  // you can't remove a dependency the board never showed you.
  function dependsItems(item) {
    return (item.depends || []).map(function (r) { return resolveRef(item, r); }).filter(Boolean);
  }
  // The hierarchy, resolved. `parentRef`/`children` are ids the harvester derived
  // from the `parent:` fields — never a stored second copy, so a lookup is all the
  // board needs.
  function parentItem(item) { return item.parentRef ? itemById(item.parentRef) : null; }
  // Members in the order you'd work them: by status column, then by manual rank,
  // then by title. The harvester sorts `children[]` by id "for stable output" and
  // says the board sorts them for display — this is the board keeping that promise.
  // Without it a parent you're running listed its parts alphabetically by slug,
  // with the one `next` puck sitting in the middle of the `now` ones.
  // Where a status sits on the ladder. `indexOf` alone answers -1 for a status the
  // payload's own list does not name, and -1 sorts *first* — ahead of `now`. Not
  // hypothetical: this repo's committed snapshot is five statuses to the live board's six,
  // so a cancelled puck would have led the list. Unknown goes last, where an unrecognised
  // value belongs.
  function statusRank(s) {
    var i = DATA.statuses.indexOf(s);
    return i === -1 ? Infinity : i;
  }
  function childItems(item) {
    return (item.children || []).map(itemById).filter(Boolean).sort(function (a, b) {
      var sa = statusRank(a.status), sb = statusRank(b.status);
      if (sa !== sb) return sa - sb;
      var oa = a.order == null ? Infinity : a.order, ob = b.order == null ? Infinity : b.order;
      if (oa !== ob) return oa - ob;
      return a.title.localeCompare(b.title);
    });
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
      if (s.type === "target-passed") {
        var dt = daysSince(item.target);
        return "Target " + item.target + " has passed" + (dt != null ? " (" + dt + " days ago)" : "") + " — move the horizon or land it?";
      }
      if (s.type === "depends-missing") {
        return "Depends on " + (item.missingDepends || []).join(", ") + ", which doesn’t exist — typo, or the puck was renamed?";
      }
      if (s.type === "dependency-cycle") return "In a dependency loop — these pucks wait for each other, so none of them is ready.";
      if (s.type === "parent-missing") return 'Parent "' + item.parent + '" doesn’t exist — typo, or the puck was renamed?';
      if (s.type === "parent-cycle") return 'Parent "' + item.parent + '" closes a loop — the link is ignored.';
      if (s.type === "rollup-open") {
        var open = item.progress.total - item.progress.done;
        return "Marked " + (STATUS_LABEL[item.status] || item.status).toLowerCase() + " but " + open +
          " of " + item.progress.total + " parts " + (open === 1 ? "is" : "are") + " still open.";
      }
      if (s.type === "rollup-done") return "Every part is done — mark the parent done?";
      return s.type;
    });
  }

  // ── tiny, safe markdown (escape first, then a whitelist of inline + block bits) ──
  // Escape-first is the safety property, and it is why this stayed hand-rolled
  // rather than becoming a dependency: nothing a puck body says can turn into HTML
  // that is not written below. These bodies come from *other people's* repos and
  // land in `innerHTML` on our origin — and every real markdown library passes raw
  // HTML through by default, so adopting one means adopting a sanitizer too. Two
  // dependencies to buy a handful of block types is the wrong trade.
  //
  // The cost is paid here, once: block detection below runs on lines that have
  // already been escaped, so a blockquote starts with `&gt;`, not `>`.
  function esc(s) {
    return String(s)
      .replace(/\u0000/g, "") // the inline pass parks finished HTML on NUL — keep it ours
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // The quote is not decoration. A URL reaches `href="…"` and the result goes
      // through `innerHTML`, so a `"` inside one closes the attribute and the rest of
      // the URL becomes markup — `https://x"onpointerenter="…` is a real event handler
      // on our origin, where the GitHub token lives. renderMd also draws issue bodies
      // and comments, so the author of that URL need not be the board's owner.
      // Escape-first is the whole safety property; it was one character short of it.
      .replace(/"/g, "&quot;");
  }
  function mdLink(href, text) {
    return '<a href="' + href + '" target="_blank" rel="noopener">' + text + "</a>";
  }
  // Emphasis, split out because it has to run in two places: over a link's *label*
  // before that link is parked, and over the line once every link is out of the way.
  function mdEmphasis(s) {
    return String(s)
      // `[^*]+` could not span the inner `*`, so `**fet med *kursiv* inuti**` left its
      // `**` on screen. A single `*` is allowed inside; a double still closes.
      .replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  }
  // Everything link-shaped is lifted out of the string first and put back last, so no
  // rule can reach inside another. The order is what the bugs were made of:
  //
  //   - Emphasis used to run *before* the autolinker, so `…/a*b*c` had its path eaten
  //     (`<em>b</em>`) and only the head of the URL was linked.
  //   - A whole explicit link used to be parked before emphasis ran, so a formatted
  //     label — `[**viktigt**](…)` — kept its asterisks. The label is emphasised on the
  //     way into the hold instead; the href never is.
  function mdInline(s) {
    var held = [];
    function hold(html) { return "\u0000" + (held.push(html) - 1) + "\u0000"; }
    var out = String(s)
      .replace(/`([^`]+)`/g, function (_, c) { return hold("<code>" + c + "</code>"); })
      // `(^|[^!])` and not a lookbehind: `![alt](url)` is image syntax, which the board
      // does not interpret — without the guard the link rule ate the brackets and left
      // a stray `!` in front of a link to the image file. Re-emitting the preceding
      // character is the same shape the emphasis rule already uses, and it works on the
      // iOS versions a lookbehind does not.
      .replace(/(^|[^!])\[([^\]]+)\]\((https?:[^)]+)\)/g, function (_, pre, t, u) { return pre + hold(mdLink(u, mdEmphasis(t))); })
      // A bare URL is a link everywhere else a reader meets one. Trailing sentence
      // punctuation is left outside the link; parens are not part of a URL here.
      .replace(/(^|[\s(>])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?])/g, function (_, pre, u) { return pre + hold(mdLink(u, u)); });
    out = mdEmphasis(out);
    // A held link's label can itself hold a code span, so one pass is not enough.
    // Indices only ever point backwards, so this terminates.
    while (out.indexOf("\u0000") >= 0) {
      out = out.replace(/\u0000(\d+)\u0000/g, function (_, i) { return held[+i]; });
    }
    return out;
  }

  // A table is recognised only as a *pair*: a `|…|` row followed by a `|---|` rule
  // with the same number of cells. Everything else that starts with `|` falls to
  // BLOCKISH below and is rendered plainly, one line per line.
  var TABLE_ROW = /^\s*\|(.+)\|\s*$/;
  var TABLE_RULE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
  // Blocks we do not render must still *break* the paragraph. Folding them in with a
  // space is what turned a table into one long sentence — every row and the `|---|`
  // separator glued into a single `<p>`. (`&gt;`: see the note on esc() above.)
  // `&lt;` and `![` are here because CONVENTION promises it: raw HTML and images are
  // not interpreted, and "not interpreted" has to mean *shown on its own line* rather
  // than folded into the neighbouring sentence. Without them the guarantee held for
  // tables and stopped exactly where the documentation kept going.
  var BLOCKISH = /^\s*(?:\||&gt;|&lt;|!\[|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/;
  function mdCells(line) {
    return TABLE_ROW.exec(line)[1].split("|").map(function (c) { return c.trim(); });
  }
  function mdAlign(spec) {
    if (/^:-+:$/.test(spec)) return ' style="text-align:center"';
    if (/^-+:$/.test(spec)) return ' style="text-align:right"';
    return "";
  }
  function mdIndent(ws) { return ws.replace(/\t/g, "    ").length; }
  function renderMd(src) {
    var out = [];
    var lines = esc(src).split("\n");
    // Open lists, innermost last: { type, indent, liOpen }. A stack rather than a
    // flag, because indentation is what tells a sub-point from a wrapped line, and
    // one flag can only ever answer "in a list, yes or no".
    var stack = [];
    var para = []; // buffer of wrapped lines that form one paragraph
    var liBuf = null; // buffer of wrapped lines that form one list item
    var quote = []; // buffer of consecutive `>` lines
    var inCode = false;
    var code = []; // buffer of lines inside a ``` fence
    function flushPara() {
      if (para.length) { out.push("<p>" + mdInline(para.join(" ")) + "</p>"); para = []; }
    }
    function flushQuote() {
      if (quote.length) { out.push("<blockquote>" + mdInline(quote.join(" ")) + "</blockquote>"); quote = []; }
    }
    // An item's `<li>` opens as soon as its text is known but closes late: a nested
    // list has to be emitted *inside* it, so the tag stays open until a sibling item
    // or the end of the level.
    function emitLi() {
      if (!liBuf) return;
      out.push("<li>" + mdInline(liBuf.join(" ")));
      if (stack.length) stack[stack.length - 1].liOpen = true;
      liBuf = null;
    }
    function closeLi() {
      emitLi();
      var top = stack[stack.length - 1];
      if (top && top.liOpen) { out.push("</li>"); top.liOpen = false; }
    }
    function closeList() { closeLi(); out.push("</" + stack.pop().type + ">"); }
    function closeLists(toIndent) {
      while (stack.length && stack[stack.length - 1].indent > toIndent) closeList();
    }
    function endBlocks() { flushPara(); flushQuote(); while (stack.length) closeList(); }
    function flushCode() {
      if (code.length) { out.push("<pre><code>" + code.join("\n") + "</code></pre>"); code = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        if (inCode) { flushCode(); inCode = false; }
        else { endBlocks(); inCode = true; }
        continue;
      }
      if (inCode) { code.push(line); continue; }

      // Tables, before anything else can claim the line: only the row+rule pair is
      // one, and the cell counts have to agree — GitHub does not render a table
      // whose header and separator disagree either.
      if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] || "") &&
          mdCells(line).length === mdCells(lines[i + 1]).length) {
        endBlocks();
        var head = mdCells(line);
        var align = mdCells(lines[i + 1]).map(mdAlign);
        var t = ['<div class="md-table"><table><thead><tr>'];
        head.forEach(function (c, n) { t.push("<th" + align[n] + ">" + mdInline(c) + "</th>"); });
        t.push("</tr></thead><tbody>");
        for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
          var row = mdCells(lines[i]);
          t.push("<tr>");
          for (var c = 0; c < head.length; c++) t.push("<td" + align[c] + ">" + mdInline(row[c] || "") + "</td>");
          t.push("</tr>");
        }
        i--; // the loop's own i++ takes the line that ended the table
        out.push(t.join("") + "</tbody></table></div>");
        continue;
      }

      var bq = /^\s*&gt;\s?(.*)$/.exec(line);
      if (bq) {
        flushPara();
        while (stack.length) closeList();
        quote.push(bq[1].trim());
        continue;
      }
      flushQuote(); // any other line ends the quote

      var h = /^(#{2,4})\s+(.*)$/.exec(line);
      var ul = /^([ \t]*)[-*]\s+(.*)$/.exec(line);
      var ol = /^([ \t]*)(\d+)[.)]\s+(.*)$/.exec(line);
      var li = ul || ol;
      if (h) {
        endBlocks();
        var lvl = Math.min(h[1].length, 4);
        out.push("<h" + lvl + ">" + mdInline(h[2]) + "</h" + lvl + ">");
      } else if (li) {
        flushPara();
        var wantType = ul ? "ul" : "ol";
        var indent = mdIndent(li[1]);
        closeLists(indent); // anything deeper than this line ends here
        var top = stack[stack.length - 1];
        if (top && top.indent === indent && top.type !== wantType) { closeList(); } // bullets ↔ numbered
        top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          emitLi(); // we are nesting inside the item that is still open
          // Preserve an author's starting number (a section that resumes at "3.").
          var openTag = "<" + wantType + ">";
          if (wantType === "ol" && parseInt(ol[2], 10) !== 1) openTag = '<ol start="' + parseInt(ol[2], 10) + '">';
          out.push(openTag);
          stack.push({ type: wantType, indent: indent, liOpen: false });
        } else {
          closeLi(); // a sibling at this level: close the previous item
        }
        liBuf = [ul ? ul[2] : ol[3]]; // buffer so soft-wrapped lines fold into this item
      } else if (line.trim() === "") {
        endBlocks();
      } else if (BLOCKISH.test(line)) {
        // A block we do not render. It gets its own line rather than being folded
        // into the running paragraph — plain instead of garbled.
        endBlocks();
        out.push("<p>" + mdInline(line.trim()) + "</p>");
      } else if (liBuf) {
        liBuf.push(line.trim()); // lazy continuation of the current list item
      } else {
        para.push(line.trim()); // fold wrapped lines into the current paragraph
      }
    }
    endBlocks();
    if (inCode) flushCode();
    return out.join("\n");
  }

  // ── query model ──────────────────────────────────────────────────────────────
  // What's on screen is one list of predicates. The search box, the sidebar places,
  // the filter popover and the URL are four *faces* of that list — never four
  // sources: the controls hold the state, this projects it, and one evaluator runs
  // it. A term is { field, op, values, neg }: AND between terms, OR within a term's
  // values (`status:now,next` = now or next). Grammar is GitHub-shaped so nobody has
  // to learn it, and it is the same string an agent or a saved view writes.
  function lower(s) { return String(s).toLowerCase(); }
  function shortRepo(r) { return String(r).split("/").pop(); }

  // Fields are what a puck actually carries. `dateOf` marks the ones that compare
  // with >=/<=/>/< instead of matching a value.
  var FIELDS = {
    status: { vals: function (i) { return [i.status]; } },
    priority: { vals: function (i) { return i.priority ? [i.priority] : []; } },
    agent: { vals: function (i) { return i.agent ? [i.agent] : []; } },
    owner: { vals: function (i) { return i.owner ? [i.owner] : []; } },
    tag: { vals: function (i) { return i.tags || []; } },
    repo: { vals: function (i) { return [i.repo, shortRepo(i.repo), i.repoName]; } },
    issue: { vals: function (i) { return i.issue == null ? [] : [String(i.issue)]; } },
    // The parent a puck sits in. Matches whatever names it: the raw `parent:` value
    // as written, the resolved id, or the parent's bare slug — so `parent:auth`
    // works from a card, a URL or an agent that only knows the slug.
    parent: {
      vals: function (i) {
        if (!i.parentRef && !i.parent) return [];
        var out = i.parent ? [i.parent] : [];
        if (i.parentRef) out.push(i.parentRef, String(i.parentRef).split("/").pop());
        return out;
      },
    },
    updated: { dateOf: function (i) { return i.updated; } },
    created: { dateOf: function (i) { return i.created; } },
    target: { dateOf: function (i) { return i.target; } },
  };
  var FIELD_ALIAS = { label: "tag", labels: "tag", tags: "tag", repos: "repo", prio: "priority", discipline: "agent", etapp: "parent", epic: "parent" };

  // `is:` is the namespace for states that aren't fields — they're derived from the
  // data (by the harvester or here), so giving each its own field would invent a
  // second truth. Negate with `-is:blocked`.
  var IS_STATES = {
    // Ready is "pick one up, or hand it to an agent" — and a parent is neither. It
    // has no work of its own; what you take is one of its parts. Dog-fooding made
    // that concrete: `gui-hantverk` was unblocked (it declares no `depends:`) and
    // therefore Ready, while four of its five members were waiting on each other.
    // The view agents read to choose work was offering the one thing that can't be
    // chosen, and hiding that its contents were stalled.
    ready: function (i) {
      return (i.status === "now" || i.status === "next") &&
        !(i.blockedBy || []).length && !(i.children || []).length;
    },
    blocked: function (i) { return !!(i.blockedBy || []).length; },
    flagged: function (i) { return isFlagged(i); },
    stale: function (i) { return (i.signals || []).some(function (s) { return s.type === "stale"; }); },
    adapted: function (i) { return !i.native; },
    done: function (i) { return !!TERMINAL[i.status]; }, // done *or* cancelled — the archive
    // The hierarchy, as states rather than fields: a puck with children *is* the
    // parent, and one with neither parent nor children stands outside every tree.
    blocking: function (i) { return !!(i.blocks || []).length; },
    parent: function (i) { return !!(i.children || []).length; },
    member: function (i) { return !!i.parentRef; },
    standalone: isStandalone,
  };
  // Spellings that mean an existing state. Canonicalised at parse rather than
  // registered as a second predicate — which is how `orphan` used to be carried, and
  // it left the facet panel unable to tick the row a live `is:orphan` term had
  // selected, because the panel looks its values up by name. `parent` joins it here
  // rather than in `IS_STATES`, so every link and saved view written before the
  // rename keeps working *and* keeps showing.
  var IS_ALIAS = { etapp: "parent", epic: "parent", orphan: "standalone" };
  // The three states cover every puck between them, and the only ones counted twice
  // are the sub-parents — which genuinely are both. That's the check that the split
  // is the right one: `is:parent` + `is:member` + `is:standalone` leaves nothing out.
  function isStandalone(i) { return !i.parentRef && !(i.children || []).length; }

  // Split on whitespace, but keep "quoted phrases" whole so free text can contain spaces.
  function tokenize(str) {
    var out = [], cur = "", quote = null;
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (quote) { if (c === quote) quote = null; else cur += c; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }

  // Anything that isn't a known field or `is:` state stays free text, so a typo
  // narrows the search instead of silently disappearing.
  function parseQuery(str) {
    var terms = [];
    tokenize(String(str || "")).forEach(function (tok) {
      var neg = false;
      if (tok.charAt(0) === "-" && tok.length > 1) { neg = true; tok = tok.slice(1); }
      var c = tok.indexOf(":");
      if (c > 0) {
        var name = lower(tok.slice(0, c));
        var rest = tok.slice(c + 1);
        name = FIELD_ALIAS[name] || name;
        // `is:a,b` carries alternatives in one term, the same shape every other field
        // uses. It has to: `runQuery` ANDs terms, so a value per term made two ticks in
        // one facet ask for a contradiction — `is:parent is:standalone` is "is a parent
        // and stands outside every tree", empty by construction. Unknown names are
        // dropped rather than failing the whole term, and a term left with nothing
        // falls through to free text, so a typo still narrows instead of vanishing.
        if (name === "is") {
          var states = rest.split(",").map(lower)
            .map(function (v) { return IS_ALIAS[v] || v; })
            .filter(function (v) { return IS_STATES[v]; });
          if (states.length) {
            terms.push({ field: "is", op: "is", values: states, neg: neg });
            return;
          }
        }
        // `has:<field>` — does the puck carry this field at all. The one question the
        // grammar could not ask, and the only way to say "hide the column of pucks
        // that have no priority": that column's key is the absence of a value, so
        // there is no `-priority:x` that names it. Listing every real value instead
        // (`priority:urgent,high,medium,low`) works only for a closed set and goes
        // quietly wrong for agents and parents, where a new value would arrive already
        // hidden. Symmetrical with `is:` — one field per term, negatable.
        if (name === "has" && FIELDS[FIELD_ALIAS[lower(rest)] || lower(rest)]) {
          terms.push({ field: "has", op: "is", values: [FIELD_ALIAS[lower(rest)] || lower(rest)], neg: neg });
          return;
        }
        if (FIELDS[name] && rest) {
          if (FIELDS[name].dateOf) {
            var m = /^(>=|<=|>|<|=)?(.+)$/.exec(rest);
            terms.push({ field: name, op: m[1] || "=", values: [m[2]], neg: neg });
          } else {
            terms.push({ field: name, op: "in", values: rest.split(",").map(lower).filter(Boolean), neg: neg });
          }
          return;
        }
      }
      terms.push({ field: "text", op: "has", values: [lower(tok)], neg: neg });
    });
    return terms;
  }

  function quoted(v) { return /\s/.test(v) ? '"' + v + '"' : v; }
  function serializeTerms(terms) {
    return terms.map(function (t) {
      var p = t.neg ? "-" : "";
      if (t.field === "text") return p + quoted(t.values[0]);
      if (t.field === "is") return p + "is:" + t.values.join(",");
      if (t.field === "has") return p + "has:" + t.values[0];
      if (t.op !== "in" && t.op !== "=") return p + t.field + ":" + t.op + t.values[0];
      return p + t.field + ":" + t.values.map(quoted).join(",");
    }).join(" ");
  }

  // ISO dates compare as strings, so no parsing is needed.
  function cmpDate(a, op, b) {
    if (!a) return false; // no value → never matches a date question
    if (op === ">") return a > b;
    if (op === "<") return a < b;
    if (op === ">=") return a >= b;
    if (op === "<=") return a <= b;
    return a === b;
  }

  function termMatches(item, t) {
    var hit;
    if (t.field === "text") {
      var hay = lower(item.title + " " + item.body + " " + (item.tags || []).join(" ") + " " + item.repoName);
      hit = hay.indexOf(t.values[0]) !== -1;
    } else if (t.field === "is") {
      hit = t.values.some(function (v) { return !!IS_STATES[v](item); });
    } else if (t.field === "has") {
      // A date field carries no `vals()`, so ask it the way it answers.
      var hf = FIELDS[t.values[0]];
      hit = hf.dateOf ? !!hf.dateOf(item) : hf.vals(item).filter(Boolean).length > 0;
    } else {
      var f = FIELDS[t.field];
      if (f.dateOf) hit = cmpDate(f.dateOf(item), t.op, t.values[0]);
      else {
        var vals = f.vals(item).filter(Boolean).map(lower);
        hit = t.values.some(function (v) { return vals.indexOf(v) !== -1; });
      }
    }
    return t.neg ? !hit : hit;
  }
  function runQuery(item, terms) {
    for (var i = 0; i < terms.length; i++) if (!termMatches(item, terms[i])) return false;
    return true;
  }

  // The sidebar views are queries, not special cases in the filter — the same
  // strings a saved view or an agent would write. ("all" = the committed board;
  // inbox has its own space, and the archive is added below unless it's shown.)
  // `is:parent` is derived (a puck with children *is* the parent), so the view is a
  // query and not a new record type — the same trick every other view uses.
  // Parents carries no `-status:inbox`: a parent can sit anywhere, inbox included,
  // and hiding it there would make the sidebar's count disagree with the board.
  // Standalone does carry it — an inbox puck is standalone by definition, and
  // without the exclusion the row would just re-count the inbox.
  var VIEWS = {
    all: "-status:inbox", ready: "is:ready", inbox: "status:inbox",
    parents: "is:parent", standalone: "-status:inbox is:standalone", attention: "is:flagged",
  };
  // Which views can reach the archive at all, and therefore have to obey the toggle.
  // `ready` and `inbox` can't (their statuses are never terminal), and `attention`
  // *wants* to — a flagged done puck is exactly what that view is for. The rest are
  // the ones that would otherwise show landed work unasked.
  var ARCHIVABLE = { all: 1, parents: 1, standalone: 1 };
  var NOT_DONE = { field: "is", op: "is", values: ["done"], neg: true };

  // The two fields the sidebar navigates by. They are ordinary query fields; what makes
  // them "places" is only that a nav row shows them, which is a fact about the chrome.
  var PLACE_FIELDS_ORDER = ["repo", "agent"];
  // A place's active values: the positive term on that field, if any. Negations are not
  // places — there is nowhere called "not PIA" — so they stay ordinary filter chips.
  function placeValues(field) { return filterValues(field, false); }
  // The filter half of the view — what goes in ?q= and on the chip row.
  function filterTerms() { return parseQuery(state.query); }
  // What the view itself says, before any filter the user added. Split out because
  // two questions need it separately: "what does the board show" (below) and "what
  // could this view ever show" (the filter panel, deciding which values are real).
  function viewTerms() {
    var t = parseQuery(VIEWS[state.focus] || VIEWS.all);
    if (ARCHIVABLE[state.focus] && !state.showDone) t.push(NOT_DONE);
    return t;
  }
  function activeTerms() { return viewTerms().concat(filterTerms()); }

  // Recomputed once per render (renderBoard) so the query isn't parsed per item.
  var activeQuery = null;
  function matches(item) { return runQuery(item, activeQuery || activeTerms()); }

  // ── editing the filter ──────────────────────────────────────────────────────
  // The query string is the store for every filter that isn't a place, so the chip
  // row and the panel don't keep their own copies: they parse it, change a term,
  // and serialize it back. One representation, three ways to touch it.
  // The store, not the input: writing the whole query into the search box would
  // put the active filters inside a field the palette selects-all on open, where
  // the next keystroke would wipe them.
  function setQueryTerms(terms) {
    state.query = serializeTerms(terms);
    renderBoard();
  }
  // `is:` holds one state per term (that's its grammar), so it toggles whole terms;
  // every other field merges values into one term (`status:now,next`).
  function sameField(t, field, neg) {
    return t.field === field && !!t.neg === !!neg && t.field !== "text";
  }
  function filterValues(field, neg) {
    var out = [];
    parseQuery(state.query).forEach(function (t) {
      if (sameField(t, field, neg)) out = out.concat(t.values);
    });
    return out;
  }
  function toggleFilterValue(field, value, neg) {
    var terms = parseQuery(state.query), hit = -1;
    // `is:` belongs to a panel section, and the section owns the term shape: one term
    // per section, so a tick lands beside the others instead of starting a second term
    // the panel would not show as ticked. (A *column* constraint is not a tick and does
    // not come through here — see `hideColumnTerm`.)
    if (field === "is") {
      var sec = sectionForState(value);
      if (sec) return toggleSectionValue(sec, value, neg);
    }
    if (field === "is" || field === "has") {
      for (var i = 0; i < terms.length; i++) {
        if (sameField(terms[i], field, neg) && terms[i].values[0] === value) { hit = i; break; }
      }
      if (hit >= 0) terms.splice(hit, 1);
      else terms.push({ field: field, op: "is", values: [value], neg: !!neg });
      return setQueryTerms(terms);
    }
    for (var j = 0; j < terms.length; j++) if (sameField(terms[j], field, neg)) { hit = j; break; }
    if (hit < 0) {
      terms.push({ field: field, op: "in", values: [value], neg: !!neg });
    } else {
      var vals = terms[hit].values.slice();
      var at = vals.indexOf(value);
      if (at >= 0) vals.splice(at, 1); else vals.push(value);
      if (vals.length) terms[hit].values = vals; else terms.splice(hit, 1);
    }
    setQueryTerms(terms);
  }

  // The free-text half of the search box — what suggestions and quick-capture use,
  // so typing `status:now` filters instead of offering to create a puck called that.
  function queryText() {
    return parseQuery(state.query).filter(function (t) { return t.field === "text" && !t.neg; })
      .map(function (t) { return t.values[0]; }).join(" ");
  }

  // ── the URL: the query's third face ─────────────────────────────────────────
  // `?view=` names the view (a shorthand for its query, so the sidebar can still
  // highlight a row), `?q=` carries the filter on top of it, `?done=1` is display
  // state — the archive toggle is not a filter. The puck hash is left alone, and
  // writes always replace: the board URL describes where you are, it isn't a step
  // in history.
  // The view as data: the same keys the URL uses and a saved view stores, so a
  // link, a config entry and the live board are three encodings of one thing.
  // Only non-defaults are included, so a plain board keeps a clean URL.
  // Which keys mean anything, in one place. Both producers go through it — the live
  // board (`viewParamObject`) and a stored entry (`paramsOf`) — because they have to
  // answer identically or a saved view stops matching the board it describes. They did
  // not, once: gating the live side alone made an untouched "Inbox by repo" load as
  // *(edited)* and offer to Update itself, since the stored `group` survived and the
  // live one had just been dropped. Hand-editing board.config.json is a first-class
  // path (AGENTS.md), so a redundant-but-valid entry has to load consistently too.
  //
  // Four keys are conditional, and each condition is the same question asked of a
  // different fallback:
  //
  //   group      `groupUsable` drops `status` where the view has already fixed it, so
  //              in the inbox — one status column — `status` and `repo` draw the same
  //              board. Compared through the fallback, not against the raw default.
  //   done       the archive toggle does nothing outside an ARCHIVABLE view, and the
  //              Display menu does not offer the row there.
  //   empty      `renderList` drops empty groups unconditionally ("a flat list has no
  //              drop targets"), and Display hides that control outside the board.
  //   collapsed  a fold means nothing outside the list layout.
  //
  // Three of the four were found the same way and for the same reason: `goToView` and
  // the Display menu deliberately keep your choices across a navigation, so a setting
  // follows you into a view that cannot act on it. Written anyway it did two kinds of
  // damage — an untouched view offered to save a duplicate of itself, and two boards
  // drawn identically compared unequal.
  //
  // Nothing is lost by dropping them. `state` still carries every setting, so stepping
  // back into a view that can use one writes it again; the Display toggles additionally
  // persist in localStorage. The one honest cost: reload while standing in a view that
  // ignores the setting, having arrived from a link that set it and never touched the
  // control. A preference that does nothing where you are looking is the right thing to
  // drop there.
  // `etapps` is what the row was called, and it is in links already sent *and* in
  // saved views already committed. The rewrite therefore belongs where every reader
  // passes: `effectiveParams` is the one normaliser both a saved view's parameters and
  // the live board's go through. Doing it only at the URL read — which is where it was
  // first written — left a stored `etapps` comparing itself against the live `parents`,
  // so the view read as edited the moment it opened, and dropped its archive flag on
  // the way, because `ARCHIVABLE` has no `etapps` any more.
  function canonicalView(v) { return v === "etapps" ? "parents" : v; }
  // `props` in both directions. The empty choice is the literal `none`, because an empty
  // string cannot survive the round trip: `viewsEqual` compares `(a[k] || "")`, so an
  // empty value and a missing key are the same value to it — and the difference between
  // them is exactly what "an empty choice is a choice" means.
  var PROPS_NONE = "none";
  function serializeProps(set) {
    var on = PROPS.filter(function (f) { return set.has(f.key); }).map(function (f) { return f.key; });
    return on.length ? on.join(",") : PROPS_NONE;
  }
  function parseProps(v) {
    if (v == null || v === "") return null;              // no choice — the automatic rule
    if (v === PROPS_NONE) return new Set();             // a choice, and it is "nothing"
    var set = new Set();
    String(v).split(",").forEach(function (k) { if (PROP_BY_KEY[k]) set.add(k); });
    // Every name unknown: a typo, or a key from a newer board. Treated as no choice rather
    // than as the empty one, since silently drawing a bare list is a worse answer to a
    // link we could not read than drawing the board's own default.
    return set.size ? set : null;
  }
  function effectiveParams(o) {
    if (o.view) o.view = canonicalView(o.view);
    // `props` through its own parser and back, for the reason `canonicalQuery` is two
    // lines away in `paramsOf`: this is the one normaliser both a saved view's parameters
    // and the live board's pass through, and the board renders from `parseProps`, which
    // drops names it does not know. A view committed by hand — or by a newer board — with
    // `props: "repo,newField"` therefore drew `repo` and compared `repo,newField`, so it
    // read as *(edited)* the moment it was opened. All names unknown is no choice at all
    // (`parseProps` answers null), and the key goes rather than standing as a string the
    // board is not following.
    if (o.props != null && o.props !== "") {
      var chosen = parseProps(o.props);
      if (chosen) o.props = serializeProps(chosen); else delete o.props;
    }
    // `sort` beside `props`, and for the identical reason: the board renders from
    // `parseSort`, so a stored `sort: "default"` — the spelling every saved view and every
    // shared link used before the chain — drew `order,updated-desc` and compared `default`,
    // and read as *(edited)* the moment it opened. One normaliser, both sides of the
    // comparison.
    //
    // Dropped when it is what the board would draw anyway — which is the grouping's own
    // proposal and not the constant. That is the whole correction: measured against
    // `DEFAULT_SORT`, `order,updated` was deleted under `group=none` too, where it is a
    // different board from the proposal, so the chain could not be asked for at all. The
    // drop itself stays, since `viewParamObject` still emits only what the board would not
    // have drawn by itself and the two sides have to agree about which strings those are.
    // Below the group lines, because it is the *settled* grouping that proposes.
    if (o.sort) {
      var okeys = parseSortKeys(o.sort);
      if (okeys.length) o.sort = serializeSort(okeys); else delete o.sort;
    }
    var focus = o.view || "all";
    var layout = o.layout || DISPLAY_DEFAULTS.view;
    var cols = columnsForFocus(focus, o.done === "1");
    var eff = function (k) { return k !== "status" || cols.length > 1 ? k : "repo"; };
    // A grouping that cannot be drawn as columns is not a view together with the board
    // layout: the layout wins and the grouping is dropped, the same shape as `empty` and
    // `collapsed` below. Two of them (`LIST_ONLY`) — `parent` is a hierarchy, `none` is
    // the absence of columns, which is the same statement from the other end. Dropped
    // rather than kept, so the parameters say what is actually drawn — a stored view that
    // keeps a setting the board ignores is how an untouched view came to read as
    // *(edited)*.
    if (LIST_ONLY[o.group] && layout !== "list") delete o.group;
    if (o.group && eff(o.group) === eff(DISPLAY_DEFAULTS.group)) delete o.group;
    if (o.done && !ARCHIVABLE[focus]) delete o.done;
    if (o.empty && layout !== "board") delete o.empty;
    if (o.collapsed && layout !== "list") delete o.collapsed;
    // …and a grouping with no heading has no fold control either. `collapsed` is keyed by
    // the grouping's own values, so under a headless one it names buckets that are never
    // drawn: measured, `?layout=list&group=none&collapsed=<NO_VALUE>` kept the key in the
    // URL and lit the Display dot while all seven rows stood open — a parameter claiming a
    // fold nobody can see, undo, or have made. Same sentence as the line above it.
    if (o.collapsed && headlessGroup(o.group)) delete o.collapsed;
    if (o.sort === proposedSort(o.group || DISPLAY_DEFAULTS.group)) delete o.sort;
    return o;
  }
  function viewParamObject() {
    var o = {};
    if (state.focus !== "all") o.view = state.focus;
    var q = serializeTerms(filterTerms());
    if (q) o.q = q;
    // What is *emitted* is the choice, not the fallback: a saved view has to be
    // reproducible, and the fallback is derived from wherever it lands.
    if (state.group !== DISPLAY_DEFAULTS.group) o.group = state.group;
    if (state.view !== DISPLAY_DEFAULTS.view) o.layout = state.view;
    // Not `!== DISPLAY_DEFAULTS.sort`: a chain equal to what this grouping proposes is a
    // choice the board would have made for you, and writing it down would freeze it — the
    // proposal is meant to follow the grouping, not to be captured by the first link.
    if (sortChosen()) o.sort = state.sort;
    if (state.showDone) o.done = "1";
    if (!state.showEmpty) o.empty = "0";
    // Sorted, not in click order: the same set of folded groups has to serialize to
    // the same string every time, or the URL churns and two identical views compare
    // unequal. Whether a fold means anything at all is `effectiveParams`' call.
    if (state.collapsed.size) {
      var folded = [];
      state.collapsed.forEach(function (k) { folded.push(k); });
      o.collapsed = folded.sort().join(",");
    }
    // In FIELDS' order, not tick order, for the same reason the folds are sorted: the same
    // choice has to serialize to the same string every time, or two identical views
    // compare unequal and the URL churns. `none` is the empty choice — an empty string
    // would be dropped by the comparer, which reads a missing key and an empty one alike,
    // and the board would then quietly go back to choosing the date for you.
    if (state.props) o.props = serializeProps(state.props);
    return effectiveParams(o);
  }
  // What the board carries *beyond* the view it is standing in. A built-in view is not
  // yours to save: "Ready" is already a row in the sidebar, and a saved copy of it is
  // the same list under two names — the drift `viewsShown` exists to avoid ("All pucks
  // 31 / Standalone 31"). Changes made *on top of* one are yours, so this subtracts the
  // scope rather than refusing whenever one is set, and a saved view still stores its
  // `view` key: "Ready, grouped by repo" is a view, "Ready" is a duplicate.
  // Only `view` is subtracted. Every other key in `viewParamObject` is already a
  // non-default — a thing you did — which is why the default board answers empty here
  // exactly as it did before.
  function ownParams() {
    var o = viewParamObject();
    delete o.view;
    return o;
  }
  // Whether this board is worth *offering* to name — `ownParams` minus the layout. A board
  // that is the default arrangement, read as a list, is not a view of the roadmap; it is a
  // preference about your screen, which is the same reason the Display dot stopped counting
  // it. Reported right after that change: `?layout=list` left the chip row holding nothing
  // but `Save view`, on a board the dot had just called default — two surfaces answering one
  // question differently, which is the shape this file keeps paying for.
  //
  // The *refusal* in `saveCurrentView` still asks `ownParams`, and the divergence is the
  // point rather than an oversight: the title menu and ⌘K are deliberate acts — you went
  // looking for a way to name this — while a button that puts itself in front of you is an
  // offer, and an offer to name the default board is noise. So "Ready, as a list" stays
  // savable; it simply is not proposed.
  function worthNaming() {
    var o = ownParams();
    delete o.layout;
    return Object.keys(o).length > 0;
  }
  // The view's keys, in one place. Three readers used to keep their own copy of this
  // list — the URL writer, and the saved-view reader and comparer — so adding
  // `collapsed` to the writer alone meant a saved view committed the fold and then
  // stripped it on the way back in. A list that has to be right in three files is a
  // list that will be wrong in one.
  var VIEW_KEYS = ["view", "q", "group", "layout", "sort", "done", "empty", "collapsed", "props"];
  // `q` and `collapsed` carry values the URL can't take raw: a search string, and the
  // NUL that keys the "none" bucket (see NO_VALUE) — unencoded, the parser drops it
  // and a shared link loses the fold it was supposed to carry.
  var ENCODED_KEYS = { q: 1, collapsed: 1 };
  function viewParams() {
    var p = [];
    var o = viewParamObject();
    VIEW_KEYS.forEach(function (k) {
      if (o[k] == null) return;
      p.push(k + "=" + (ENCODED_KEYS[k] ? encodeURIComponent(o[k]).replace(/%20/g, "+") : o[k]));
    });
    return p.length ? "?" + p.join("&") : "";
  }
  function writeUrl() {
    var next = viewParams();
    if (next === location.search) return; // nothing moved — don't churn history
    try { history.replaceState(history.state, "", location.pathname + next + location.hash); } catch (e) {}
  }
  // ── the view's display memory ───────────────────────────────────────────────
  // The grouping, the ordering, the properties, the folds and the two whole-board
  // toggles belong to **the view they were set in**. Setting `All pucks` to group by
  // repo used to regroup Ready and Inbox with it — and in Inbox the URL could not even
  // say so, because `effectiveParams` drops a `group` the view has already fixed: a
  // setting invisible in the link and visible on the screen, which is the hardest kind
  // to find.
  //
  // The rule this closes was already written one storey down, in `goToView`: *"Navigation
  // is a fresh start. Clearing only the places left the rest of the filter riding along
  // […] leaving one has to leave all of it, or the rows in the sidebar stop meaning what
  // they say."* That paragraph is about the filter. The display was the half still
  // riding along.
  //
  // It settles against the other stated rule — display preferences are settings, not a
  // transient filter — by *narrowing* it rather than dropping it: a setting still
  // persists, and what it persists to is the view. The strongest clue was in the file
  // already. A saved view carries all of `VIEW_KEYS` and `applySavedView` restores every
  // one of them, so half the views on this board could already do this; the question was
  // never whether display can be per view but why only the saved ones had it.
  //
  // **Three levels, and the order is the contract: the URL wins, then the view's memory,
  // then the board's defaults.** A shared link is what the product promises — it has to
  // draw the same board for whoever opens it — so a link that names a setting beats the
  // memory and, as `applyParams` already said, is never written into it: someone else's
  // view must not quietly become yours.
  var DISPLAY_STORE = "roadmap-display";
  // Every key in `VIEW_KEYS` except the two that are not display. `view` is the view's
  // own identity — it is what the memory is keyed *by*. `q` is the filter, which
  // navigation clears rather than remembers, and that is `goToView`'s rule left standing.
  // What remains is exactly what a saved view stores about how a board looks, which is
  // the whole argument: the built-in views were the only ones that could not.
  var DISPLAY_KEYS = ["group", "layout", "sort", "done", "empty", "collapsed", "props"];
  var displayMem = null;
  // The two words the *released* board wrote into storage as whole sort values. They stopped
  // meaning their old chains when the ordering became one, so a returning browser holding
  // either would have its ties silently re-decided — priority by title instead of updated,
  // status by title instead of manual rank. That is the instance the earlier rounds looked
  // for and could not find: not a link and not a saved view, but `roadmap-display` itself,
  // written by the shipped UI on this very board.
  //
  // The compatibility belongs **here and not in `parseSort`**. A migration runs once and
  // then the grammar is clean; an expansion in the parser is forever, and takes the spelling
  // of the one-key chain with it — which is what made the first attempt cost a `priority,title`
  // nobody needed. Stamped, because without the stamp it would run on every read, and then
  // deliberately narrowing the chain to just `priority` in the new menu would be rewritten
  // back on the next load: the round-trip bug again, one storey up.
  var STORED_SORT_V = 2;
  var STORED_SORT_WAS = { priority: "priority,updated", status: "status,order" };
  function upgradeStoredSort(store) {
    if (!store || store.__v >= STORED_SORT_V) return false;
    Object.keys(store).forEach(function (view) {
      var mem = store[view];
      if (mem && typeof mem === "object" && STORED_SORT_WAS[mem.sort]) {
        mem.sort = STORED_SORT_WAS[mem.sort];
      }
    });
    store.__v = STORED_SORT_V;
    return true;
  }
  function displayStore() {
    if (displayMem) return displayMem;
    var raw = null;
    try { raw = localStorage.getItem(DISPLAY_STORE); } catch (e) {}
    if (raw) {
      try {
        var o = JSON.parse(raw);
        if (o && typeof o === "object") {
          displayMem = o;
          // Written back, or the stamp never lands and the upgrade runs again next load.
          if (upgradeStoredSort(o)) writeDisplayStore(o);
          return displayMem;
        }
      } catch (e) {} // unreadable is the same as absent, and migrating over it is right
    }
    return (displayMem = migrateDisplay());
  }
  function writeDisplayStore(store) {
    displayMem = store;
    try { localStorage.setItem(DISPLAY_STORE, JSON.stringify(store)); } catch (e) {}
  }
  // The old format was one localStorage key per setting with no notion of a view at all —
  // the shape this closes. It is read once, into `all`: that is the view those settings
  // were made in, since it is the board you land on, and seeding all six views from them
  // would freeze one accident into six memories, which is the contagion being removed.
  // The old keys are dropped as they are read, so nothing can go on reading them, and an
  // empty object is written rather than nothing — a store that is present but empty is
  // how the migration is stopped from running a second time and handing back a memory you
  // have since reset.
  //
  // Only what differs from the defaults, which is what `viewParamObject` emits and
  // therefore what every later write looks like. A stored `done: "0"` would be a memory
  // of having changed nothing.
  function migrateDisplay() {
    var old = {};
    ["view", "sort", "group", "done", "empty", "props"].forEach(function (k) {
      try {
        var v = localStorage.getItem("roadmap-" + k);
        if (v != null) old[k] = v;
        localStorage.removeItem("roadmap-" + k);
      } catch (e) {}
    });
    var mem = {};
    if (old.view === "list") mem.layout = "list";
    // The flat key was written by the same released UI, so it carries the same two words.
    if (old.sort && old.sort !== DISPLAY_DEFAULTS.sort) mem.sort = STORED_SORT_WAS[old.sort] || old.sort;
    if (old.group && old.group !== DISPLAY_DEFAULTS.group) mem.group = old.group;
    if (old.done === "1") mem.done = "1";
    if (old.empty === "0") mem.empty = "0";
    if (old.props) mem.props = old.props;
    var store = Object.keys(mem).length ? { all: mem } : {};
    store.__v = STORED_SORT_V; // already in the new spelling, so it must not be upgraded again
    writeDisplayStore(store);
    return store;
  }
  // A copy, always: what this hands back goes straight into `applyParams`, and both it
  // and `effectiveParams` mutate the object they are given — which here would be the
  // store itself.
  function displayMemory(focus) {
    var mem = displayStore()[focus], o = {};
    if (mem) DISPLAY_KEYS.forEach(function (k) { if (mem[k] != null) o[k] = String(mem[k]); });
    return o;
  }
  // The one writer. It stores what the board *is*, never the key that just moved: the
  // display is a tuple whose settings decide each other — picking the hierarchy picks the
  // list layout, changing the grouping drops the folds — so a per-key write would store
  // half a board. `viewParamObject` has already dropped every setting this view cannot
  // act on (a fold outside the list, an archive toggle outside `ARCHIVABLE`), so the
  // memory only ever holds what the view can draw, and a view left at the defaults holds
  // no entry at all rather than an entry saying "default".
  //
  // Writing the whole board is also where the link rule gets its edge. Loading
  // `?group=agent` writes nothing — that is `readUrl`, and it is what keeps someone
  // else's view from quietly becoming yours. But turning one knob on that board stores
  // the grouping too, because the tuple is what is stored. That is the line, and it is
  // the right one: **a link you only look at writes nothing; a knob you turn adopts the
  // board you turned it on.** The alternative stores half a board — a memory of a
  // grouping and a layout that were never on screen together.
  //
  // **Silent inside a saved view.** A saved view is its own record, in
  // `board.config.json`, and the way to persist a change to it is `Update "<name>"` in
  // the chip row. A local memory laid over it would win on the way back in, so the view
  // would read as *(edited)* the moment it opened — the same shape as the `etapps`
  // rename bug. Nor may it fall through to the built-in view underneath: tweaking a saved
  // view whose scope is Ready is not a statement about Ready.
  function rememberDisplay() {
    if (state.fromView) return;
    var o = viewParamObject(), mem = {};
    DISPLAY_KEYS.forEach(function (k) { if (o[k] != null) mem[k] = o[k]; });
    var store = displayStore();
    if (Object.keys(mem).length) store[state.focus] = mem;
    else delete store[state.focus];
    writeDisplayStore(store);
  }
  // Whether the archive would be *on* once you landed in `focus` — that view's remembered
  // `done`, since `restoreDisplay` starts from the defaults and lays the memory over them.
  //
  // The sidebar's counts need this and it is not a detail: both `viewCounts` and
  // `placeCounts` say, in their own comments, that a row's number is what clicking it
  // shows. That held for free while `showDone` was one value for the whole board — the
  // current value *was* every destination's value. Per view it is not, and reading
  // `state.showDone` for a row you are not standing in makes the number a promise the
  // click immediately breaks. Which is the very failure `goToPlace` already names one
  // screen down, about clearing the agent while landing on a repo.
  function willShowDone(focus) { return displayMemory(focus).done === "1"; }
  // Put the board's display back to what `focus` was left in, over the board's defaults
  // for whatever it was never given. A view you have never set up therefore opens at the
  // defaults rather than inheriting the last one: inheritance is the contagion being
  // removed, and it would be at its worst on a first visit, which is the one time there
  // is nothing on screen to correct it.
  //
  // Both navigations go through it, and `goToPlace` is the one that is easy to miss:
  // `state.focus` is the memory's key, so anything that moves it has to move the display
  // with it. A repo or an agent is not a view of its own — that would be a memory per
  // repo, which is more than anyone asked for — it is `all` with a filter, which is
  // exactly what `goToPlace` sets, so landing on one restores `all`.
  function restoreDisplay(focus) {
    clearDisplay();
    applyParams(displayMemory(focus)); // never `reset`: the query is not this one's to touch
    refreshDisplayDot();
  }

  // A repo can be written short (`pia-terminal`), full (`owner/pia-terminal`) or by
  // display name (`PIA`) — resolve any of them to the id the state holds.
  function resolveRepo(v) {
    var want = lower(v), hit = null;
    DATA.sources.forEach(function (s) {
      if (hit) return;
      if (lower(s.repo) === want || lower(shortRepo(s.repo)) === want || lower(s.name) === want) hit = s.repo;
    });
    return hit;
  }
  function readUrl() {
    var s = location.search.replace(/^\?/, ""), got = {};
    if (s) s.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      got[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " "));
    });
    // Where the three levels are ordered: the view's memory over the board's defaults,
    // and the link over both. The view has to be read first — *which* memory to restore
    // is the one question only the URL can answer — which is why this cannot be the
    // boot-time localStorage read it replaces: that one ran before there was a view, and
    // therefore had to apply one board's settings to all six.
    //
    // No early return on an empty search any more. A bare `/` is the `all` view, and it
    // has a memory like every other.
    var focus = canonicalView(got.view || "all");
    if (!VIEWS[focus]) focus = "all";
    restoreDisplay(focus);
    applyParams(got);
  }
  // Every display key back to the board's own default. Split out of `applyParams`'s
  // reset branch because `restoreDisplay` needs the same half without the other one: a
  // navigation to a place resets the display and keeps the query, which is the one
  // combination the reset branch cannot express.
  function clearDisplay() {
    state.showDone = DISPLAY_DEFAULTS.showDone;
    state.showEmpty = DISPLAY_DEFAULTS.showEmpty;
    state.group = DISPLAY_DEFAULTS.group;
    state.view = DISPLAY_DEFAULTS.view;
    state.sort = DISPLAY_DEFAULTS.sort;
    state.collapsed.clear();
    state.props = null;
  }
  // Apply a view's params to the board. `reset` makes them authoritative (a saved
  // view is a complete description); the boot path leaves untouched keys alone
  // because there is nothing to reset yet.
  function applyParams(got, reset) {
    if (reset) {
      state.query = "";
      state.focus = "all";
      state.fromView = null; // applySavedView sets it back; every other reset means "no view"
      clearDisplay();
    }
    // A link's display choices win over the saved preferences, but aren't saved
    // themselves — someone else's view shouldn't quietly become yours.
    if (got.done === "1") state.showDone = true;
    if (got.empty === "0") state.showEmpty = false;
    if (got.collapsed != null) {
      state.collapsed.clear();
      got.collapsed.split(",").forEach(function (k) { if (k) state.collapsed.add(k); });
    }
    // `!= null` rather than truthy: `props=none` is a real value and so, on the reset
    // path, is the absence of the key — but only `reset` may turn a choice back into no
    // choice, since the boot path is layering a URL over stored preferences and has
    // nothing to say about keys it does not carry.
    if (got.props != null) state.props = parseProps(got.props);
    if (GROUPS[got.group]) state.group = got.group;
    // `setDisplay` clears the folds when the grouping changes, for the reason written
    // there; a link arriving with both had no equivalent. A headless grouping is the case
    // where it matters most, because there is no control to undo the fold with.
    if (headlessGroup(state.group)) state.collapsed.clear();
    if (got.layout === "list" || got.layout === "board") state.view = got.layout;
    // Through the parser, so `state.sort` is always a canonical chain — a legacy one-word
    // mode expands here and never has to be recognised again downstream.
    if (got.sort) {
      var gkeys = parseSortKeys(got.sort);
      state.sort = gkeys.length ? serializeSort(gkeys) : null;
    }
    normalizeSort();
    if (got.view) got.view = canonicalView(got.view);
    if (VIEWS[got.view]) state.focus = got.view;
    if (!got.q) return;
    // Nothing to hand back to anyone: `?q=` is the store. The sidebar rows read it for
    // their pressed state, the panel reads it for its values, and the chip row skips
    // what a row already shows. A link and the live board are the same string.
    state.query = canonicalQuery(got.q);
  }
  // A repo term said as a short or display name, rewritten to the full `owner/name`.
  // Two things need it: a link written by hand still lights the row it names, and a
  // board with two repos of the same name under different owners cannot light both —
  // `FIELDS.repo` matches the short name for every owner, so the ambiguity is real.
  //
  // It has to be one producer. Rewriting only on the way in left a saved view whose `q`
  // uses the short name comparing its *configured* string against the board's
  // canonicalised one, so the view you had just applied lit up for no one. Both sides
  // of that comparison come through here now.
  function canonicalQuery(q) {
    return serializeTerms(parseQuery(q).map(function (t) {
      if (t.field !== "repo" || t.neg) return t;
      return { field: t.field, op: t.op, neg: t.neg,
               values: t.values.map(function (v) { return resolveRepo(v) || v; }) };
    }));
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
  // `field` because the name used to be an assumption: "Last updated" was hardcoded into
  // both the tooltip and the accessible name, so a view showing `created` announced the
  // wrong field. `label` draws the name visibly, which a view showing two dates needs —
  // two bare strings side by side say nothing about which is which.
  function dateEl(date, cls, field, label) {
    var name = DATE_LABEL[field || "updated"] || "Updated";
    var d = el("span", cls || "card-date");
    if (label) d.appendChild(el("span", "date-tag", name));
    d.appendChild(document.createTextNode(date));
    d.title = name + " " + date;
    d.setAttribute("aria-label", name + " " + date);
    return d;
  }

  // ── the horizon ─────────────────────────────────────────────────────────────
  // `target` is stored exact (it has to sort and compare) but shown coarse: a card
  // shouting "30 NOV" reads as a deadline promise, "Nov 2026" reads as a horizon.
  // Close in, the countdown is the useful part, so that wins.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function monthLabel(ym) { // "2026-11" → "Nov 2026"
    var p = String(ym).split("-");
    return (MONTHS[Number(p[1]) - 1] || p[1]) + " " + p[0];
  }
  function targetLabel(date) {
    var d = daysSince(date); // positive = the horizon has passed
    if (d != null && d >= 0 && d <= 1) return d === 0 ? "today" : "yesterday";
    if (d != null && d < 0 && d >= -21) return "in " + -d + " day" + (d === -1 ? "" : "s");
    return monthLabel(String(date).slice(0, 7));
  }
  // A real calendar date, not just the right shape: Date rolls "2026-02-31" into
  // March, so only a value that survives the round-trip counts. Mirrors
  // normalizeDate() in the harvester, so the board and the pipeline agree.
  function realDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function endOfMonth(ym) { // "2026-11" → "2026-11-30"
    var p = String(ym).split("-");
    return new Date(Date.UTC(Number(p[0]), Number(p[1]), 0)).toISOString().slice(0, 10);
  }
  function targetEl(date, cls) {
    var passed = daysSince(date) > 0;
    var d = el("span", (cls || "card-date") + " target-date" + (passed ? " past" : ""), "◷ " + targetLabel(date));
    d.title = "Target " + date + (passed ? " — horizon passed" : "");
    d.setAttribute("aria-label", d.title);
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
    // alert-triangle (Feather), scaled to the 15 grid the set draws on. The set had no
    // warning mark, so the drift flag was the literal "⚠" — a text character sitting
    // inches from `slash`, which is a real path from this set. A character takes its
    // weight, its optical size and its baseline from whatever font the platform falls
    // back to (U+26A0 is in none of the stack's faces), and on a machine that resolves
    // it to a colour emoji `color: var(--later)` does nothing at all. Two flags on one
    // card, drawn by two different systems.
    warn: ["M6.43125 2.4125 1.1375 11.25a1.25 1.25 0 0 0 1.06875 1.875h10.5875a1.25 1.25 0 0 0 1.06875 -1.875L8.56875 2.4125a1.25 1.25 0 0 0 -2.1375 0z",
           "m7.5 5.625 0 2.5", "m7.5 10.625 0.00625 0"],
    // eye / eye-off (Feather) — the column menu's two halves: narrow to this column,
    // or take it out of the view.
    eye: ["M0.625 7.5s2.5 -5 6.875 -5 6.875 5 6.875 5 -2.5 5 -6.875 5 -6.875 -5 -6.875 -5z",
          "M5.625 7.5a1.875 1.875 0 1 0 3.75 0 1.875 1.875 0 1 0 -3.75 0"],
    "eye-off": ["M11.2125 11.2125A6.29375 6.29375 0 0 1 7.5 12.5c-4.375 0 -6.875 -5 -6.875 -5a11.53125 11.53125 0 0 1 3.1625 -3.7125M6.1875 2.65A5.7 5.7 0 0 1 7.5 2.5c4.375 0 6.875 5 6.875 5a11.5625 11.5625 0 0 1 -1.35 1.99375m-4.2 -0.66875a1.875 1.875 0 1 1 -2.65 -2.65",
                "m0.625 0.625 13.75 13.75"],
    share: ["M2.5 7.5v5a1.25 1.25 0 0 0 1.25 1.25h7.5a1.25 1.25 0 0 0 1.25 -1.25v-5", "m10 3.75 -2.5 -2.5 -2.5 2.5", "m7.5 1.25 0 8.125"],
    sidebar: ["M3.125 1.875h8.75s1.25 0 1.25 1.25v8.75s0 1.25 -1.25 1.25H3.125s-1.25 0 -1.25 -1.25V3.125s0 -1.25 1.25 -1.25", "m5.625 1.875 0 11.25"],
    search: ["M1.875 6.875a5 5 0 1 0 10 0 5 5 0 1 0 -10 0", "m13.125 13.125 -2.71875 -2.71875"],
    plus: ["m7.5 3.125 0 8.75", "m3.125 7.5 8.75 0"],
    // x (Feather), scaled to the same 15 grid. Every remove/close affordance drew the
    // literal "✕" (U+2715) — the same defect as `warn`: a character takes its weight,
    // its optical size and its baseline from whatever font the platform falls back to,
    // so the mark that dismisses a modal and the mark that drops a filter chip were two
    // different pictures at two different weights, neither matching `plus` beside them.
    x: ["M11.25 3.75 3.75 11.25", "m3.75 3.75 7.5 7.5"],
    filter: ["M13.75 1.875 1.25 1.875l5 5.9125000000000005L6.25 11.875l2.5 1.25 0 -5.3374999999999995L13.75 1.875z"],
    edit: ["M6.875 2.5H2.5a1.25 1.25 0 0 0 -1.25 1.25v8.75a1.25 1.25 0 0 0 1.25 1.25h8.75a1.25 1.25 0 0 0 1.25 -1.25v-4.375", "M11.5625 1.5625a1.325625 1.325625 0 0 1 1.875 1.875L7.5 9.375l-2.5 0.625 0.625 -2.5 5.9375 -5.9375z"],
    // git-commit — a puck is a commit-like unit in git (our "project" glyph)
    commit: ["M5 7.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0 -5 0", "M0.65625 7.5 4.375 7.5", "m10.631250000000001 7.5 3.71875 0"],
    // A parent is several pucks on one track — the commit mark, twice. It has to
    // differ from `commit` at 12px, which is why it is two dots and not a container
    // outline: at that size an outline is a smudge and a count of dots still reads.
    parent: ["M3.125 7.5a1.5625 1.5625 0 1 0 3.125 0 1.5625 1.5625 0 1 0 -3.125 0",
            "M8.75 7.5a1.5625 1.5625 0 1 0 3.125 0 1.5625 1.5625 0 1 0 -3.125 0",
            "M0.9375 7.5 3.125 7.5", "M6.25 7.5 8.75 7.5", "M11.875 7.5 14.0625 7.5"],
    // git-merge — the Parent brand mark: two stages meeting on one line
    merge: ["M9.5833 11.5a1.9167 1.9167 0 1 0 3.8333 0 1.9167 1.9167 0 1 0 -3.8333 0", "M1.9167 3.8333a1.9167 1.9167 0 1 0 3.8333 0 1.9167 1.9167 0 1 0 -3.8333 0", "M3.8333 13.4167V5.75a5.75 5.75 0 0 0 5.75 5.75"],
    // trash-2 (Feather), scaled to the 16 viewBox
    trash: ["M2 4h12", "M12.667 4v9.333a1.333 1.333 0 0 1 -1.333 1.333H4.667a1.333 1.333 0 0 1 -1.333 -1.333V4", "M5.333 4V2.667a1.333 1.333 0 0 1 1.333 -1.333h2.667a1.333 1.333 0 0 1 1.333 1.333V4", "M6.667 7.333v4", "M9.333 7.333v4"],
    // sliders (Feather) — settings/command
    sliders: ["M2.6667 14v-4.6667", "M2.6667 6.6667V2", "M8 14v-6", "M8 5.3333V2", "M13.3333 14v-3.3333", "M13.3333 8V2", "M0.6667 9.3333h4", "M6 5.3333h4", "M11.3333 10.6667h4"],
    // more-horizontal, from the set proper. It was hand-drawn here as three
    // zero-length capped lines (the way `list` draws its bullets) — same picture,
    // but the spacing was mine and not the set's.
    more: ["M2.5 7.5a0.625 0.625 0 1 0 1.25 0 0.625 0.625 0 1 0 -1.25 0",
           "M6.875 7.5a0.625 0.625 0 1 0 1.25 0 0.625 0.625 0 1 0 -1.25 0",
           "M11.25 7.5a0.625 0.625 0 1 0 1.25 0 0.625 0.625 0 1 0 -1.25 0"],
    // The only direction marks on the board: the breadcrumb's steps and the filter
    // panel's way in and out. They were the typographic › ‹ ←, which take their
    // weight and their baseline from the *font* — so they never quite matched the
    // marks beside them, and the back arrow was a different species from the
    // separators it sat in a row with.
    "chev-right": ["m5.625 11.25 3.75 -3.75 -3.75 -3.75"],
    "chev-left": ["m9.375 11.25 -3.75 -3.75 3.75 -3.75"],
    "chev-down": ["m3.75 5.625 3.75 3.75 3.75 -3.75"],
    check: ["M12.5 3.75 5.625 10.625l-3.125 -3.125"],
    "chev-up": ["m11.25 9.375 -3.75 -3.75 -3.75 3.75"],
    // A chevron is a direction; an arrow is a *move*. The set had all four chevrons and no
    // arrow at all, so "move this key up" was drawn with the glyph that everywhere else
    // means "there is more above" — a fold, a caret, a menu. Same 15 grid, same 1px stroke:
    // the chevron's own head, on a shaft that runs the full height.
    "arrow-up": ["M7.5 13.125 7.5 1.875", "m3.75 5.625 3.75 -3.75 3.75 3.75"],
    // refresh-cw — ask CI for a fresher harvest. Scaled from Feather's 24 grid by the
    // same 0.625 as its neighbour `reset` (rotate-ccw), which is the nearest glyph in
    // the set: that one undoes an arrangement, this one goes and gets something. They
    // were checked side by side at 15px and read as two shapes, not one — two chasing
    // arcs against a single open circle — so the pair needs no further separation.
    //
    // download-cloud was the alternative, and it is the better picture of the
    // *direction* (this pulls seven repos inward; nothing is pushed). It lost on two
    // counts: at 15px the cloud's shoulder thins to a smudge, and the footer row it
    // belongs to already holds two literal downloads — `flat digest` and
    // `roadmap.json` — beside which a download arrow names the wrong thing. Worth
    // revisiting only if the action is ever renamed to something openly inward.
    sync: ["m14.375 2.5 0 3.75 -3.75 0",
           "m0.625 12.5 0 -3.75 3.75 0",
           "M2.19375 5.625a5.625 5.625 0 0 1 9.28125 -2.1L14.375 6.25",
           "M0.625 8.75l2.9 2.725A5.625 5.625 0 0 0 12.80625 9.375"],
    // rotate-ccw — undo an arrangement, not undo a write
    reset: ["m0.625 2.5 0 3.75 3.75 0",
            "M2.19375 9.375a5.625 5.625 0 1 0 1.33125 -5.85L0.625 6.25"],
    // inbox — the one view that is a room rather than a filter (see VIEW_GROUPS)
    inbox: ["m13.75 7.5 -3.75 0 -1.25 1.875 -2.5 0 -1.25 -1.875 -3.75 0",
            "M3.40625 3.19375 1.25 7.5v3.75a1.25 1.25 0 0 0 1.25 1.25h10a1.25 1.25 0 0 0 1.25 -1.25v-3.75l-2.15625 -4.30625A1.25 1.25 0 0 0 10.475 2.5H4.525a1.25 1.25 0 0 0 -1.11875 0.69375z"],
    list: ["m5 3.75 8.125 0", "m5 7.5 8.125 0", "m5 11.25 8.125 0", "m1.875 3.75 0.00625 0", "m1.875 7.5 0.00625 0", "m1.875 11.25 0.00625 0"],
    grid: ["M1.875 1.875h4.375v4.375H1.875Z", "M8.75 1.875h4.375v4.375h-4.375Z", "M8.75 8.75h4.375v4.375h-4.375Z", "M1.875 8.75h4.375v4.375H1.875Z"],
    key: ["m13.125 1.25 -1.25 1.25m-4.7562500000000005 4.7562500000000005a3.4375 3.4375 0 1 1 -4.86125 4.86125 3.4375 3.4375 0 0 1 4.860625 -4.860625zm0 0L9.6875 4.6875m0 0 1.875 1.875L13.75 4.375l-1.875 -1.875m-2.1875 2.1875L11.875 2.5"],
    external: ["M11.25 8.125v3.75a1.25 1.25 0 0 1 -1.25 1.25H3.125a1.25 1.25 0 0 1 -1.25 -1.25V5a1.25 1.25 0 0 1 1.25 -1.25h3.75", "m9.375 1.875 3.75 0 0 3.75", "M6.25 8.75 13.125 1.875"],
    sun: ["M4.375 7.5a3.125 3.125 0 1 0 6.25 0 3.125 3.125 0 1 0 -6.25 0", "m7.5 0.625 0 1.25", "m7.5 13.125 0 1.25", "m2.6374999999999997 2.6374999999999997 0.8875 0.8875", "m11.475 11.475 0.8875 0.8875", "m0.625 7.5 1.25 0", "m13.125 7.5 1.25 0", "m2.6374999999999997 12.3625 0.8875 -0.8875", "m11.475 3.525 0.8875 -0.8875"],
    moon: ["M13.125 7.9937499999999995A5.625 5.625 0 1 1 7.0062500000000005 1.875 4.375 4.375 0 0 0 13.125 7.9937499999999995z"],
    // robot (Streamline Micro), scaled from its 10 grid to the 15 this set draws on.
    // The agent mark was the literal "→" (U+2192) — the third time this defect appears
    // here, after `warn` and `x`: a character takes its weight, its optical size and its
    // baseline from whatever font resolves it, so the mark beside a routed puck was a
    // different species from every other mark on the card.
    //
    // It also said the wrong thing. An arrow is a direction, and `agent:` is not a
    // destination — it is *which discipline profile a runner should read*. The board has
    // real direction marks (`chev-*`), and having the routing field borrow their shape
    // made the one field that is about a reader look like a field about a place.
    // alert-circle (Feather), scaled to the 15 grid like `warn` and `x` before it. Its
    // circle comes out byte-identical to `slash`'s, which is the cross-check that the
    // scaling landed: they are the same circle in the source set.
    //
    // `warn` is the drift triangle — something disagrees with reality. This is the
    // urgent *priority* mark, which is a claim about importance and not about
    // correctness, so it stays a separate shape rather than reusing the triangle at a
    // different colour.
    alert: ["M1.25 7.5a6.25 6.25 0 1 0 12.5 0 6.25 6.25 0 1 0 -12.5 0",
            "m7.5 5 0 2.5", "m7.5 10 0.00625 0"],
    agent: ["M14.25 12.75c0 0.3978 -0.158 0.7794 -0.4393 1.0607C13.5294 14.092 13.1478 14.25 12.75 14.25h-10.5c-0.3978 0 -0.7794 -0.158 -1.0607 -0.4393C0.908 13.5294 0.75 13.1478 0.75 12.75V10.5c0 -1.7902 0.7112 -3.5071 1.977 -4.773C3.9929 4.4612 5.7098 3.75 7.5 3.75c1.7902 0 3.5071 0.7112 4.773 1.977C13.5388 6.9929 14.25 8.7098 14.25 10.5v2.25Z",
            "M7.5 3.75v-3",
            "M4.5 11.25c-0.4142 0 -0.75 -0.3358 -0.75 -0.75s0.3358 -0.75 0.75 -0.75",
            "M4.5 11.25c0.4142 0 0.75 -0.3358 0.75 -0.75s-0.3358 -0.75 -0.75 -0.75",
            "M10.5 11.25c-0.4142 0 -0.75 -0.3358 -0.75 -0.75s0.3358 -0.75 0.75 -0.75",
            "M10.5 11.25c0.4142 0 0.75 -0.3358 0.75 -0.75s-0.3358 -0.75 -0.75 -0.75"],
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
  // The breadcrumb's step, in one place: the separator appeared in three builders,
  // and a glyph copied three times is three chances for them to drift apart.
  function sep() { return icon("chev-right", "crumb-sep"); }

  // ── segmented control: one value out of a small closed set ──────────────────
  // There were two of these — the layout switch and the theme switch — with the
  // same job, the same click-and-repaint dance, and two different looks: one drew a
  // border around *each* option, the other a filled track with a raised pill. The
  // giveaway is the border: one around each option says "two things that happen to
  // sit next to each other", one frame around the group says "one control with N
  // positions". Both of them are the second thing.
  //
  // Tabs are deliberately not this. Overview/Activity switches what the page
  // *shows*, so it stays underlined (`.tab-btn`) — the one of the three where the
  // choice changes the region below it. Same reason `.focusbtn` differs from it.
  //
  // opts: [[value, label, iconName?], …]. onPick gets the value; the control has
  // already moved its own `on` state, so a caller only does its own work.
  function segmented(opts, current, onPick) {
    var seg = el("div", "segmented");
    seg.setAttribute("role", "group");
    opts.forEach(function (o) {
      var b = el("button", "segmented-btn" + (current === o[0] ? " on" : ""));
      b.type = "button";
      if (o[2]) b.appendChild(icon(o[2]));
      b.appendChild(el("span", null, o[1]));
      b.setAttribute("aria-pressed", current === o[0] ? "true" : "false");
      b.addEventListener("click", function () {
        [].forEach.call(seg.children, function (c) {
          var on = c === b;
          c.classList.toggle("on", on);
          c.setAttribute("aria-pressed", on ? "true" : "false");
        });
        onPick(o[0]);
      });
      seg.appendChild(b);
    });
    return seg;
  }
  // A disclosure caret carries both directions and lets CSS pick by the button's
  // own `aria-expanded` — the state is already on the control, so nothing has to be
  // kept in sync. (A rotated down-chevron would draw the same shape; using the set's
  // own up mark means the file says which mark it is rather than how it got there.)
  function fillCaret(span) {
    if (!span) return;
    span.innerHTML = "";
    span.appendChild(icon("chev-down", "caret-down"));
    span.appendChild(icon("chev-up", "caret-up"));
  }

  // Drift badge: the signals a puck's declared status disagrees with. Built in two
  // places (card and list row) from the same three lines, so it lives here.
  function warnBadge(sig) {
    var w = el("span", "warn-badge");
    w.appendChild(icon("warn"));
    w.title = sig.join("\n");
    w.setAttribute("aria-label", "Needs attention: " + sig.join("; "));
    return w;
  }

  // Blocked badge for a puck waiting on unfinished dependencies (tooltip lists them).
  function blockBadge(item) {
    var b = el("span", "block-badge");
    b.appendChild(icon("slash"));
    var names = blockerItems(item).map(function (x) { return x.title; });
    b.title = "Blocked by: " + (names.join(", ") || item.blockedBy.join(", "));
    if ((item.blocks || []).length) b.title += "  ·  blocks " + item.blocks.length;
    b.setAttribute("aria-label", b.title);
    return b;
  }

  // Rollup badge for a puck that *is* a parent: how many of its children have
  // landed. Derived at harvest from the children's own statuses, so a parent can't
  // claim progress its pucks don't have.
  function progressBadge(item) {
    var p = item.progress;
    var b = el("span", "rollup" + (p.done === p.total ? " full" : ""));
    // The proportion, as a fill behind the count — not instead of it.
    //
    // The finding this closes said the rollup was "a number where a shape would do",
    // and the puck deliberately waited for real parents before choosing the shape. The
    // real ones have 1, 2, 3 and 5 parts, and at those sizes every shape is the
    // *worse* instrument: 0/1, 1/2 and 2/3 draw 0%, 50% and 67% while the reader's
    // actual question — how many are left — is "one" for all three. A shape earns its
    // place where the count stops meaning anything (37/120 → "about a third"), and
    // nothing on this board is close. So the answer is the count, and only the count.
    // The puck mark, not the parent mark: this badge counts *pucks*, and the parent
    // it belongs to already wears its own mark beside the title. Carrying `parent`
    // here put the same glyph on one card twice and had the count of two dots
    // standing in front of the number 5.
    b.appendChild(icon("commit"));
    b.appendChild(el("span", "rollup-n", p.done + "/" + p.total));
    b.title = "Parent: " + p.done + " of " + p.total + " pucks done";
    b.setAttribute("aria-label", b.title);
    return b;
  }
  // Membership chip on a child card: which parent this puck belongs to.
  // Membership, on a card. Clickable when the parent is on the board: the crumb
  // already goes up and the members list goes down, but this — the one place the
  // relation is stated on the board itself — did nothing but repeat a name. On a
  // flat board a card and its parent can be columns apart, so the tie has to be a
  // link or it is only a label.
  function parentChip(item) {
    var p = parentItem(item);
    var name = p ? p.title : item.parentRef;
    var c = el(p ? "button" : "span", "parent-chip" + (p ? " parent-link" : ""));
    if (p) c.type = "button";
    c.appendChild(icon("merge"));
    c.appendChild(el("span", "parent-name", name));
    c.title = "Parent: " + name;
    c.setAttribute("aria-label", c.title);
    if (p) {
      c.addEventListener("click", function (e) {
        e.stopPropagation(); // the card underneath opens *this* puck; the chip opens its parent
        openModal(p);
      });
    }
    return c;
  }

  // The puck's identity mark: a git-commit glyph tinted with the repo colour —
  // like Linear's project icon, which is coloured by the project's identity (not
  // status). It's the single colour marker, so the meta shows just the repo name.
  // The identity mark, tinted with the repo. A puck that holds other pucks gets a
  // different one: a parent was indistinguishable from a member on the board, and
  // "which of these is a parent?" is the first question the board should answer
  // without being read.
  function puckGlyph(item) {
    var isParent = (item.children || []).length > 0;
    var g = el("span", "puck-glyph" + (isParent ? " is-parent" : ""));
    g.style.color = item.repoColor;
    g.title = isParent ? "Parent \u00b7 " + item.repoName : item.repoName;
    g.appendChild(icon(isParent ? "parent" : "commit"));
    return g;
  }

  // ── which properties a view shows ───────────────────────────────────────────
  // One list, both surfaces. Every property is already its own guarded line in `card()`
  // and `listRow()` — `if (item.priority)`, `if (item.agent)`, `if (item.progress)` — so
  // the chooser is not a rewrite of the renderers but a question put to them. Keeping the
  // question in one place is the point: two lists that must agree are the drift this file
  // names elsewhere (`VIEW_KEYS` was three copies, and the one that wasn't updated
  // silently dropped a fold).
  //
  // `where` says which part of the row the property belongs to, and it is also the order
  // the row lays its tracks out in:
  //   "name"  inline in the title cell (a mark that qualifies the title)
  //   "cell"  its own grid track, with `track` giving the width
  //   "date"  a date, which collapses into one shared track (see `dateCells`)
  // The card has no tracks and reads the same list positionally.
  //
  // What is *not* here is what a puck cannot be read without: the title, the puck glyph
  // (it carries the repo colour) and the ⚠ badge, which is the drift signal — being able
  // to hide it is being able to hide that something is wrong.
  var PROPS = [
    { key: "rollup", label: "Rollup", where: "name",
      has: function (i) { return !!i.progress; }, make: function (i) { return progressBadge(i); } },
    { key: "parent", label: "Parent", where: "name",
      // No grouping test here any more. It used to carry `effectiveGroup() !== "parent"`,
      // which made it an *override*: ticked or not, the chip vanished under the parent
      // grouping. That is the mistake this file names three times — a control claiming a
      // choice that never took effect. `groupSays` below does the same job as a *default*.
      has: function (i) { return !!i.parentRef; },
      make: function (i) { return parentChip(i); } },
    { key: "blocked", label: "Blocked by", where: "name",
      has: function (i) { return (i.blockedBy || []).length > 0; }, make: function (i) { return blockBadge(i); } },
    { key: "status", label: "Status", where: "cell", cls: "list-status", track: "84px",
      // The one property that was *missing* rather than merely un-choosable. Under every
      // grouping but `status` nothing on a card or a row said which state a puck was in:
      // the glyph carries the repo colour and parent-ness, the sort has no status mode,
      // and the dimming for terminal pucks hangs on `.col-status-*`, a *column* class, so
      // it only works where the column already answers. Measured on the live board under
      // `group=repo` with the archive on: a `now` row and a `done` row were identical in
      // class, opacity and text — with 131 of 175 pucks done.
      has: function () { return true; }, make: function (i) { return statusPill(i.status); } },
    { key: "priority", label: "Priority", where: "cell", cls: "list-pri", track: "44px",
      has: function (i) { return !!i.priority; }, make: function (i) { return priorityBadge(i.priority); } },
    { key: "agent", label: "Agent", where: "cell", cls: "list-agent", track: "108px",
      has: function (i) { return !!i.agent; }, make: function (i) { return agentBadge(i.agent); } },
    { key: "owner", label: "Owner", where: "cell", cls: "list-owner", track: "28px",
      has: function (i) { return !!i.owner; }, make: function (i) { return ownerEl(i.owner); } },
    { key: "repo", label: "Repo", where: "cell", cls: "list-repo", track: "148px",
      has: function () { return true; },
      make: function (i) {
        var f = document.createDocumentFragment();
        var dot = el("span", "repo-dot");
        dot.style.background = i.repoColor;
        f.appendChild(dot);
        f.appendChild(el("span", "repo-name", i.repoName));
        return f;
      } },
    { key: "created", label: "Created", where: "date" },
    { key: "updated", label: "Updated", where: "date" },
    { key: "target", label: "Target", where: "date" },
    // Heading-only, and the one property with no row equivalent — which is why the puck
    // asked whether the heading should carry a set of its own. It does not, and `rollup`
    // is the reason: the badge beside a group's name and the badge on a row are the *same*
    // property, so two sets would have had to name it twice and could then disagree. One
    // set, and a property draws wherever it means something — which the list already does
    // for `parent` (nothing to say under the parent grouping) and `repo` (likewise).
    { key: "count", label: "Count", where: "head" },
    { key: "tags", label: "Labels", where: "tags",
      has: function (i) { return i.tags.length > 0 || !i.native; },
      make: function (i) {
        var f = document.createDocumentFragment();
        i.tags.forEach(function (t) { f.appendChild(el("span", "tagpill", "#" + t)); });
        if (!i.native) f.appendChild(el("span", "adapted-badge", "adapted"));
        return f;
      } },
  ];
  var PROP_BY_KEY = {};
  PROPS.forEach(function (f) { PROP_BY_KEY[f.key] = f; });
  var DATE_PROPS = PROPS.filter(function (f) { return f.where === "date"; }).map(function (f) { return f.key; });
  // The default set is the board as it shipped: everything on, with the dates left to the
  // automatic rule below. Written as "no choice" rather than as a list, so a view that has
  // never chosen keeps following the rule instead of freezing today's answer into a link.
  // A property the grouping already states does not need repeating on every row beneath
  // it: the column heading is the answer, and saying it again costs a track for nothing.
  // This is `autoDateField`'s rule one property over — it decides the *default*, and a tick
  // overrides it, never the reverse.
  //
  // A list and not `effectiveGroup() === key`, and `target` is why — but not for the reason
  // it first looked. The dates do not route through `propOn` at all: they go through
  // `dateFields()` and, absent a choice, `autoDateField()`. So this rule could not reach
  // `target` even if it named it, and naming it would have been dead code wearing a
  // justification.
  //
  // Which leaves the two automations pointing opposite ways at the same puck, and the
  // older, narrower one is right: under the target grouping `autoDateField` deliberately
  // *shows* target — show the date the ordering is about — while this rule's instinct
  // would be to suppress it. It is not the same sentence twice: the grouping buckets by
  // month ("Sep 2026") and the row says "in 5 days". The column is coarser than the row.
  var GROUP_SAYS = { status: 1, repo: 1, agent: 1, priority: 1, parent: 1 };
  function groupSays(key) { return !!GROUP_SAYS[key] && effectiveGroup() === key; }
  function propOn(key) {
    if (!state.props) return !groupSays(key);
    return state.props.has(key);
  }
  // Which date the board picks *for* you: the one the ordering is actually about. Sorting
  // by "Newest created" and then showing `updated` made the column look shuffled. It is a
  // default, not an override — the moment a view names its dates, they win. Otherwise
  // ticking `Updated` under a created-sort would show the update date while the order
  // followed creation, which is the exact reading this rule exists to prevent.
  // The *first* date key in the chain, since that is the one the eye is actually following —
  // a `created` key sitting third behind `priority` and `status` is a tiebreak, not what the
  // list looks ordered by. Reading only `[0]` would answer "updated" for the common
  // `order,created-desc`, which is the exact shuffled-looking column this rule exists to
  // prevent.
  // Which date a key is about is the field's own business (`SORT_FIELDS[…].date`), not a
  // second table keyed by spelling — that table had one row per key *and direction*, so a
  // direction the catalogue gained would have to be remembered here too.
  function autoDateField() {
    if (state.group === "target") return "target";
    var hit = null;
    sortChain().forEach(function (k) {
      var d = SORT_FIELDS[sortField(k)].date;
      if (!hit && d) hit = d;
    });
    return hit || "updated";
  }
  // The dates a card or row shows, as field keys. No choice → the automatic one. A choice
  // → exactly what it names, *including nothing*: an empty set is a choice, and a board
  // that quietly put a date back would be claiming a tick that never took effect.
  function dateFields() {
    if (!state.props) return [autoDateField()];
    return DATE_PROPS.filter(function (k) { return state.props.has(k); });
  }
  // What is *drawn* right now, which is not the same question as `propOn` — and the dates
  // are the whole difference. Absent a choice they do not go through `propOn` at all
  // (`autoDateField` picks exactly one), so asking `propOn` about them answers "on" for
  // all three. The chooser is the one caller that must ask this instead: it seeds the
  // first tick from what is on screen, and seeding it from `propOn` copied `created`,
  // `updated` and `target` into the set — so unticking *Agent* on a default board turned
  // its one date into three, and the three checkboxes stood ticked over a row showing one.
  function propShown(key) {
    return DATE_PROPS.indexOf(key) < 0 ? propOn(key) : dateFields().indexOf(key) >= 0;
  }
  // One date element, in that field's own language. `label` is forced on whenever a view
  // shows more than one: two bare date strings side by side say nothing about which is
  // which, and `dateEl` used to hardcode *"Last updated"* into both its tooltip and its
  // accessible name — so the second date was not merely unlabelled but read out wrong.
  var DATE_LABEL = { created: "Created", updated: "Updated", target: "Target" };
  function oneDate(item, field, cls, label) {
    if (field === "target") {
      if (item.target) return targetEl(item.target, cls); // already says "◷" and names itself
      // Only the automatic rule falls back: it picked `target` on the view's behalf, so a
      // puck without one would otherwise be a hole where every other row has a date. A
      // view that *asked* for Target gets the truth, which is that this puck has none.
      return state.props ? null : (item.updated ? dateEl(item.updated, cls, "updated", label) : null);
    }
    return item[field] ? dateEl(item[field], cls, field, label) : null;
  }
  // The row's tracks, from the same list the cells come from — one walk, two outputs, so
  // a property cannot be drawn without a column or reserve a column it never fills. The
  // CSS keeps the two it is never asked about (the glyph and the name); everything after
  // them is this string.
  //
  // `--list-fixed` is the sum the row's `min-width` is built on, and it has to be summed
  // here for the same reason: it is the floor the title's 220px sits on top of, and a
  // floor computed from a track list that is no longer the track list is a row whose
  // declared minimum is not its actual one.
  var LIST_TAGS_TRACK = "minmax(80px, 160px)";
  // The date track is the one that grows, because it is the one holding a variable number
  // of things. A fixed 92px fits one bare date and nothing else: with `Created` and
  // `Updated` both ticked, the cell is right-aligned, so the overflow ran *leftwards* and
  // printed the two dates over the repo name beside them (measured on a 390px phone —
  // "ALPHA" and "CREATED 2026-08-01" in the same pixels). Not `max-content`: each row is
  // its own grid, so a content-sized track would be a different width on every row and the
  // column would stop being a column. A width per date, and the labels are what makes them
  // wider than one.
  function dateTrack(n) { return n < 2 ? 92 : n * 136 + (n - 1) * 8; }
  function listTracks() {
    var tracks = [], px = 0, dn = dateFields().length;
    PROPS.forEach(function (f) {
      if (f.where !== "cell" || !propOn(f.key)) return;
      tracks.push(f.track);
      px += parseInt(f.track, 10) || 0;
    });
    if (dn) { tracks.push(dateTrack(dn) + "px"); px += dateTrack(dn); }
    if (propOn("tags")) { tracks.push(LIST_TAGS_TRACK); px += 80; }
    return { tracks: tracks.join(" "), fixed: px, gaps: tracks.length + 1 };
  }
  function applyListTracks(node) {
    var t = listTracks();
    // A space, never the empty string. `setProperty(name, "")` *removes* the declaration,
    // and a removed custom property is what makes `var(--list-tracks, …)` reach for the
    // four tracks the stylesheet ships — so `props=none`, which is a choice and means "no
    // metadata at all", came out with four phantom columns and 392px reserved for nothing
    // (measured: `18px 220px 44px 108px 148px 92px` on a row holding two cells). An empty
    // *value* is not the guaranteed-invalid one, so it substitutes nothing and the
    // fallback stays where it belongs — the case where the board has not rendered yet.
    node.style.setProperty("--list-tracks", t.tracks || " ");
    node.style.setProperty("--list-track-px", t.fixed + "px");
    node.style.setProperty("--list-gaps", String(t.gaps));
  }
  function dateCells(item, cls) {
    var fs = dateFields(), out = [], many = fs.length > 1;
    fs.forEach(function (f) {
      var e = oneDate(item, f, cls, many);
      if (e) out.push(e);
    });
    return out;
  }

  function card(item) {
    var sig = signalMessages(item);
    var c = el("div", "card" + (item.native ? "" : " adapted") + (sig.length ? " flagged" : "") + (item.id === selectedId ? " sel" : ""));
    c.setAttribute("data-id", item.id);
    c.style.setProperty("--repo", item.repoColor);

    // Row 1: puck glyph (repo-colored) + title.
    var head = el("div", "card-head");
    head.appendChild(puckGlyph(item));
    head.appendChild(el("h3", "card-title", item.title));
    c.appendChild(head);

    // Row 2: repo name on the left (the glyph carries the colour), ⚠ and date right.
    // The order is the card's own, not FIELDS' — that list orders the *row's* tracks, and
    // a card has none. What it does share is the answer to "is this property on", which is
    // the whole point of keeping one list: `card-repo` is the repo property here and the
    // `list-repo` cell is the same property there.
    var meta = el("div", "card-meta");
    if (propOn("repo")) {
      var repo = el("span", "card-repo");
      repo.appendChild(document.createTextNode(item.repoName));
      meta.appendChild(repo);
    }
    // Not in FIELDS and deliberately: the drift signal is not a property you may hide.
    if (sig.length) meta.appendChild(warnBadge(sig));
    ["status", "priority", "agent", "rollup", "parent", "blocked", "owner"].forEach(function (k) {
      var f = PROP_BY_KEY[k];
      if (propOn(k) && f.has(item)) meta.appendChild(f.make(item));
    });
    // The dates go in a box of their own as soon as there are two, and the list's date
    // track is the reason to expect that: the row reserves a *wider* column for a second
    // date, and the card had nothing of the sort. `.card-meta` is one non-wrapping flex
    // row and every date is `nowrap`, so `props=created,updated,target` on a puck with a
    // target ran the last one 68px past the card's right edge and into the next column
    // (measured on a 280px column, the board's minimum). The box carries the auto margin
    // the single date used to carry, so one date is laid out exactly as before, and wraps
    // inside itself so the card grows downwards instead of sideways.
    var dates = dateCells(item);
    if (dates.length > 1) {
      var box = el("span", "card-dates");
      dates.forEach(function (d) { box.appendChild(d); });
      meta.appendChild(box);
    } else {
      dates.forEach(function (d) { meta.appendChild(d); });
    }
    c.appendChild(meta);

    // Row 3: tags (static badges).
    if (propOn("tags") && PROP_BY_KEY.tags.has(item)) {
      var tags = el("div", "card-tags");
      tags.appendChild(PROP_BY_KEY.tags.make(item));
      c.appendChild(tags);
    }

    c.addEventListener("click", function () { openModal(item); });
    // Drag-to-restatus (desktop): writable native pucks can be dragged to another
    // status column, which commits the status change. Touch falls back to the picker.
    if (canWrite(item) && item.native) {
      c.setAttribute("draggable", "true");
      c.addEventListener("dragstart", function (e) {
        dragItem = item;
        c.classList.add("dragging");
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item.id); }
      });
      c.addEventListener("dragend", function () { dragItem = null; c.classList.remove("dragging"); clearDropTargets(); });
    }
    return c;
  }
  var dragItem = null;
  function clearDropTargets() {
    var els = document.querySelectorAll(".column.drop-target");
    Array.prototype.forEach.call(els, function (e) { e.classList.remove("drop-target"); });
    var lines = document.querySelectorAll(".drop-line");
    Array.prototype.forEach.call(lines, function (e) { if (e.parentNode) e.parentNode.removeChild(e); });
  }

  // Where a drop would land: the cards under the pointer, minus the one being
  // dragged (it's about to leave its old slot, so it must not count as a neighbour).
  function dropPointAt(container, y, items, moving) {
    var kids = Array.prototype.filter.call(container.querySelectorAll(".card"), function (c) {
      return c.getAttribute("data-id") !== moving.id;
    });
    var idx = kids.length;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { idx = i; break; }
    }
    var byId = {};
    items.forEach(function (it) { byId[it.id] = it; });
    var seq = kids.map(function (c) { return byId[c.getAttribute("data-id")]; }).filter(Boolean);
    return { before: kids[idx] || null, prev: seq[idx - 1] || null, next: seq[idx] || null };
  }
  // The end of the list is the last *card*, not the last child. `.col-add` moved inside
  // the scroller when `.cards` became the column's scrollport, so appending drew the line
  // below the `+` — measured with three cards: the line at y=487 against a last card
  // ending at 433, with the button's 443–474 in between. 54px below where the drop would
  // actually write, which is the one thing a drop line exists to say. `dropPointAt` reads
  // `.card` and hands back `null` for "after them all"; this is the same sentence, and it
  // has to be said twice because the container holds more than cards now.
  function showDropLine(container, before) {
    var line = container.querySelector(".drop-line") || el("div", "drop-line");
    var at = before || container.querySelector(":scope > .col-add");
    if (at) container.insertBefore(line, at);
    else container.appendChild(line);
  }

  function linkEl(text, href) {
    var a = el("a", null, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  // ── deep links: #<item.id> opens that puck's modal ──
  // Opening a *different* puck pushes a new history entry so the browser Back
  // button returns to where you were; re-rendering the same open puck (after an
  // edit) or clearing the hash replaces in place, so history never piles up.
  function setHash(id) {
    var base = location.pathname + location.search;
    var url = id ? base + "#" + id : base;
    var curId = decodeURIComponent(location.hash.replace(/^#/, ""));
    // Mark entries we push so boot can tell a reload of an app-opened puck (state
    // set) from a genuine direct deep link (no state) and not duplicate the board.
    var st = id ? { puck: id } : null;
    try {
      if (id && id !== curId) history.pushState(st, "", url);
      else history.replaceState(st, "", url);
    } catch (e) {}
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
    var close = el("button", "modal-close");
    close.appendChild(icon("x", "x-icn"));
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
      // Defer to the palette/help layers — their own Escape unwinds them first.
      if (e.key === "Escape" && !cmdkVisible() && !helpOpen()) closeModal();
    });
  }

  // ── detail: a side pane on desktop, a modal overlay on mobile ──
  var detailPane, detailContent, workEl, boardEl, portEl, selectedId = null, currentDetailItem = null, boardAt = null;
  function isWide() { return window.matchMedia("(min-width: 900px)").matches; }
  function paneRefs() {
    if (!detailPane) {
      detailPane = document.getElementById("detailPane");
      detailContent = document.getElementById("detailContent");
      workEl = document.getElementById("work");
      boardEl = document.getElementById("board");
      // `.port` wraps the board *and* the footer, and that is what makes the kanban port
      // a port a footer can scroll out of. The board is asked for the layout class; the
      // port is what scrolls.
      portEl = document.getElementById("port");
      // `armAxisLock` takes `.work` and not the port, deliberately: the axis lock is the
      // list's, scoped by the same `:has(> .port > .board.as-list)` the stylesheet uses, and in
      // the list `.work` *is* the port. `armChromeWheel` takes it for a different reason —
      // it is the box the chrome sits above, not the box that scrolls; what it forwards
      // to it asks `scrollPort()` per event.
      if (workEl) { armAxisLock(workEl); armChromeWheel(workEl); }
    if (boardEl) { armColumnWheel(boardEl); armStopWatch(boardEl); }
    }
  }

  // A stop answers a question about *size*, and size changes without a render: a window
  // resized, a tablet rotated, the sidebar opened or closed. The comment beside
  // `markColumnStops` used to call that gap rare and accept a stale answer — the
  // measurement says otherwise (a window from 900 to 300 tall left two columns with 22 and
  // 53 of range and no stop at all), and with the port's own stop now conditional too there
  // were two answers going stale rather than one. Codex found it (#54).
  //
  // One observer, on `#board`, rather than one per column: the board is the box both the
  // window and the sidebar move, and its children's heights follow it. `markStops` writes
  // nothing but `tabindex`, so it cannot change layout and the observer cannot loop. It
  // fires once on `observe` too, which is simply the first correct answer.
  var stopWatchArmed = false;
  function armStopWatch(board) {
    if (stopWatchArmed || !board || !window.ResizeObserver) return;
    stopWatchArmed = true;
    new ResizeObserver(function () { markStops(board); }).observe(board);
  }

  // ── one axis per drag ───────────────────────────────────────────────────────
  // The port scrolls both ways in the list — that is the price of a sticky group heading,
  // since a box that scrolls sideways is a scroll container in both axes — and a phone
  // drag is never perfectly straight. A flick down the list with a few degrees of drift
  // moved the columns sideways too, which is what "det skrollar i alla led" was.
  //
  // The first answer read the scroll the browser had already done and put the off-axis
  // back. It passed a synthetic test and did nothing on a real phone, for a reason worth
  // keeping: **an iOS touch scroll runs on the compositor, and writing `scrollTop` while
  // the finger is down does not reach it.** A test that moves the offsets itself never
  // touches that mechanism, so it measured the arithmetic and not the thing.
  //
  // So the browser is told up front instead. `touch-action: pan-y pinch-zoom` on the port
  // (list layout only — the kanban board is its own sideways scroller and `pan-y` on an
  // ancestor would forbid it) means a drag *cannot* pan it sideways however crooked it is:
  // the drift is gone at the source rather than corrected after the fact. Sideways is then
  // ours to drive: the first 8px pick the axis, and a sideways one refuses the browser's
  // vertical pan (`preventDefault`) and moves `scrollLeft` by the finger's own delta.
  //
  // What it costs, and it is the honest half: a sideways flick has no momentum, because it
  // is not the browser scrolling. Vertical keeps everything — momentum, the rubber band —
  // which is the axis a long list is actually read in.
  var axisArmed = false;
  // The glide belongs to its gesture, and anything that takes the port over ends it: a
  // touch anywhere (the finger that opened Filter never reached `.work`, so the port's own
  // `touchstart` could not see it), a scroll lock (`overflow: hidden` does not stop a
  // programmatic `scrollLeft`, so the board slid on under an open sheet — measured 229 at
  // the tap, 271 as it opened, 352 by the time it stopped), and a board that is replaced
  // under it. Set by `armAxisLock`; a no-op until then.
  var stopGlide = function () {};
  function armAxisLock(port) {
    if (axisArmed) return;
    axisArmed = true;
    var sx = 0, sy = 0, lastX = 0, lastT = 0, vx = 0, axis = null, live = false, fling = 0;
    // The flag needs no timer to expire: every touchstart reassigns it, so a catch that
    // ends in a drag (no click to eat) cannot leak into the next press. A timer was
    // written first and removed when no sabotage could fell it.
    var caught = false;
    // The finger's velocity, smoothed, in pixels per millisecond. A single frame's delta
    // is too noisy to fling on — one stuttered frame at the end of a swipe would decide
    // the whole glide — so each sample is folded into the last.
    function sample(x, t) {
      var dt = t - lastT;
      if (dt > 0) vx = vx * 0.7 + ((x - lastX) / dt) * 0.3;
      lastX = x; lastT = t;
    }
    // The half of native scrolling that `touch-action: pan-y` gives away, given back by
    // hand: a sideways swipe that ends with the finger moving keeps moving. Without it the
    // axis reads dead — 1:1 with the finger and stopping the instant it lifts, which is
    // not how any other scroll on the phone behaves.
    function glide() {
      var prev = performance.now();
      fling = requestAnimationFrame(function step(now) {
        var gap = now - prev;
        prev = now;
        // An interrupted fling is no fling. Put the page aside and `requestAnimationFrame`
        // stands still; clamping the gap would let the inertia survive the pause and roll
        // on when you come back — the same mistake as a stale velocity sample, and the
        // same rule the sheet's inertia already follows a floor below.
        if (gap > 100) { fling = 0; return; }
        var dt = Math.min(gap, 32) || 16;
        var was = port.scrollLeft;
        port.scrollLeft -= vx * dt;
        // Per millisecond, not per frame: a slow frame must not buy the glide extra life.
        vx *= Math.pow(0.9975, dt);
        // The second test is the edge. `scrollLeft` clamps itself, so a glide that has run
        // into one stops moving, and that is the only signal that says so.
        if (Math.abs(vx) < 0.02 || port.scrollLeft === was) { fling = 0; return; }
        fling = requestAnimationFrame(step);
      });
    }
    stopGlide = function () { if (fling) { cancelAnimationFrame(fling); fling = 0; } vx = 0; };
    // Every touch, not only one that lands in the port: the tap that opens Filter or picks
    // a view from the sidebar starts outside it, and the glide has to end there too.
    // Capture, so a surface that stops the event cannot keep the list moving behind itself
    // — and because this runs *before* the port's own handler, it is also the only place
    // that can still see whether there was a glide to interrupt.
    //
    // Which is the second half: with no movement the browser synthesises a click, so
    // catching a gliding list opened the puck under your thumb (measured: gliding at 246,
    // tapped to stop, the puck page opened). The catch is remembered and the click it
    // produces is eaten below — but only for a touch *inside* the port. A tap on Filter
    // that happens to stop the glide still means Filter.
    document.addEventListener("touchstart", function (e) {
      caught = !!fling && port.contains(e.target);
      stopGlide();
    }, { capture: true, passive: true });
    port.addEventListener("touchstart", function (e) {
      // Two fingers is a pinch, not a pan — and `pinch-zoom` is in the touch-action for
      // exactly that reason, so nothing here may take it over.
      live = e.touches.length === 1;
      axis = null;
      if (!live) return;
      sx = lastX = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      lastT = e.timeStamp;
    }, { passive: true });
    port.addEventListener("touchmove", function (e) {
      // The flag is a receipt for a click that is about to arrive, and only a still finger
      // produces one. Move it — the catch became a drag — and no click follows, so the
      // receipt would sit there and eat the *next* real one instead. The touch checks
      // cannot see that: their next tap is a touch, and its own `touchstart` clears the
      // flag on the way in. A mouse on a hybrid device, or a click from assistive
      // technology, arrives with no `touchstart` at all — measured, the puck stopped
      // opening. Cleared before the single-finger guard: a second finger is no click either.
      if (caught && e.touches[0] &&
          (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8)) caught = false;
      if (!live || e.touches.length !== 1) return;
      var t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (!axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Sideways only counts where there is somewhere sideways to go *in the direction
        // being asked for*. In the board layout this box has no horizontal travel at all
        // — the kanban scrolls itself — and at either edge it has none that way: claiming
        // x there refused the browser's vertical pan and then wrote a `scrollLeft` that
        // clamped, so the gesture moved neither axis (measured at the left edge, dragging
        // further left: 0/0). A finger moving left raises `scrollLeft`, hence the sides.
        var maxX = port.scrollWidth - port.clientWidth;
        var roomX = dx < 0 ? port.scrollLeft < maxX - 1 : port.scrollLeft > 1;
        axis = Math.abs(dx) > Math.abs(dy) && maxX > 1 && roomX ? "x" : "y";
      }
      if (axis !== "x") return;
      // If we cannot refuse the browser's pan, we must not add an axis on top of it. A
      // touchmove is non-cancelable exactly when the browser has already committed to a
      // scroll — which is the reported case, word for word: the list is still moving, a
      // finger lands and drags again. Re-grabbing a moving list makes the first few pixels
      // erratic, so the 8px threshold can read that jitter as sideways; we then claimed x,
      // failed to refuse the vertical pan, and drove `scrollLeft` anyway. Measured with a
      // sideways drag whose only difference was the flag: cancelable → 10 of 10 refused and
      // 200px of x; non-cancelable → **0 refused and the same 200px**, with the browser
      // still panning y underneath. Both axes, which is the one thing this lock exists to
      // prevent.
      //
      // It also only shows up in a group tall enough to still be moving when you re-grab —
      // 142 rows in `No parent` against 8 in the next largest — which is why it read as a
      // property of that one group.
      //
      // The earlier version of this line asked the same question and drew the wrong
      // conclusion: it treated `cancelable` as console hygiene rather than as the browser
      // saying it already owns the gesture. Handed over for the rest of the drag, not just
      // this event, and with the velocity dropped so nothing flings out of a gesture we
      // did not steer.
      if (!e.cancelable) { axis = "y"; vx = 0; return; }
      e.preventDefault();
      var from = lastX;
      sample(t.clientX, e.timeStamp);
      port.scrollLeft -= t.clientX - from;
    }, { passive: false });
    function up(e) {
      // A finger that stopped before it lifted meant to stop: the last sample is stale, so
      // an old velocity would send the list off after a deliberate halt.
      if (axis === "x" && e && e.timeStamp - lastT > 100) vx = 0;
      if (axis === "x" && Math.abs(vx) > 0.05) glide();
      live = false; axis = null;
    }
    port.addEventListener("touchend", up, { passive: true });
    // A cancelled sequence is not a finished one. `touchcancel` means the system took the
    // gesture — a call, an edge swipe, a scroll the browser decided to own — and finishing
    // it through `up` would fling the list on the strength of a swipe the user never
    // completed. It clears instead: no velocity, no glide.
    // A gesture the system takes produces no click either, so the receipt goes with it.
    port.addEventListener("touchcancel", function () { vx = 0; live = false; axis = null; caught = false; }, { passive: true });
    // Capture, so it runs before the row's own listener rather than after it.
    port.addEventListener("click", function (e) {
      if (!caught) return;
      caught = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  // ── the chrome above the port is not a dead zone ────────────────────────────
  // The topbar, the view header and the chip row are *siblings* of the port, and with the
  // document no longer scrolling there is nothing for a wheel over them to move: measured,
  // 300 notches over the topbar left `.work.scrollTop` at 0. Before the fixed height they
  // scrolled the page, which is to say they scrolled the board.
  //
  // Only the main column, not the whole page: the sidebar is a region beside the board
  // rather than above it, and a wheel there that moved the board would be a new behaviour
  // rather than a restored one. The chip row gets first refusal — it scrolls itself when
  // a long query wraps it — so the walk asks each box on the way up whether it has room
  // in the direction being asked for, and only forwards what nobody wanted.
  var wheelArmed = false;
  // A wheel over a column's head or its top gutter belongs to that column. Those are the
  // board's own dead zone, and they are new: `.cards` is the only box that scrolls
  // vertically now, the head is its *sibling*, and `.port` above them is `overflow-y:
  // hidden` — so a gesture starting on the head reached nothing. Measured at 1000×600:
  // 300 notches over the head moved 0, over the cards 300. Codex found it (#54).
  //
  // It is the same rule as `armChromeWheel` one function down — the chrome above a
  // scrollport is not a dead zone — one level in, and the same shape of answer: delegate
  // from the box that contains them all, and give anything that scrolls itself first
  // refusal. Armed on `#board`, which `renderBoard` empties but never replaces.
  var colWheelArmed = false;
  function armColumnWheel(board) {
    if (colWheelArmed || !board) return;
    colWheelArmed = true;
    board.addEventListener("wheel", function (e) {
      if (e.ctrlKey || !e.deltaY) return;              // zoom, or nothing to forward
      var col = e.target.closest && e.target.closest(".column");
      if (!col) return;
      var cards = col.querySelector(":scope > .cards");
      if (!cards || cards.contains(e.target)) return;  // the browser already has it
      if (cards.scrollHeight <= cards.clientHeight + 1) return;  // nothing to move
      // Only the room in the direction asked for. The listener is passive now, so a column
      // at its end no longer *swallows* anything — it just writes a `scrollTop` that clamps
      // to where it already was. The guard is kept because it still says the true thing:
      // this column has no answer to that gesture. Same rule `armAxisLock` states about
      // claiming an axis at an edge, minus the claim.
      var room = e.deltaY < 0 ? cards.scrollTop > 0 : cards.scrollTop < cards.scrollHeight - cards.clientHeight - 1;
      if (!room) return;
      // Passive, and that is the whole per-axis rule here: `preventDefault` cancels a wheel
      // event *whole*, so cancelling to claim the vertical half threw the sideways half away
      // with it — measured over a column head with 490px of port to the right, a diagonal
      // (120, 12) moved the column 12 and the port 0, against 120 when the same gesture
      // landed on a head whose column had nothing to scroll and the handler returned early.
      // A claim on one axis may not cost the other; the rule is `armChromeWheel`'s, and so
      // is the answer. Nothing double-scrolls, because the port is `overflow-y: hidden` and
      // the page below it does not scroll at all: measured, the uncancelled `deltaY` reaches
      // no scroller anywhere (`.work` 0, document 0), so this line is still the only writer.
      cards.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cards.clientHeight : 1);
    }, { passive: true });
  }

  function armChromeWheel(port) {
    if (wheelArmed) return;
    var col = port.parentElement;
    if (!col) return;
    wheelArmed = true;
    col.addEventListener("wheel", function (e) {
      // Ctrl+wheel is the browser's zoom gesture — a trackpad pinch arrives as exactly
      // that — so forwarding its delta would scroll the board out from under someone who
      // is only trying to make it bigger.
      // The guard asks the box that *scrolls*, not the box the chrome sits above, and the
      // two stopped being the same thing when kanban got a scrollport of its own. Codex,
      // #54 — the same shape as the scroll lock one function up, and the same cure.
      //
      // **The case it was reported for is gone, and the rule is kept anyway.** It was the
      // footer: while the board was the port, `.work` held it *outside* that port and 65px
      // of it stood permanently in view, so asking `.work` answered "inside the port, leave
      // it to the browser" about a box that no longer scrolled — 0px against 300 over the
      // topbar. The footer moved inside `.port` a commit later, and with it that strip. No
      // dead zone is reachable today, so nothing fails if this line asks the wrong box;
      // what remains is that asking the wrong box is wrong, and the next box to sit between
      // `.work` and the port would revive the bug rather than introduce it.
      var to = scrollPort() || port;
      if (to.contains(e.target) || scrollLocks || e.ctrlKey) return;
      // In kanban the destination now scrolls sideways only, and a wheel over the chrome
      // has no vertical answer at all — not because the forwarding broke but because the
      // thing it forwarded to stopped existing. The board has no board-level vertical
      // scroll any more; each column has its own, and the pointer is over the topbar,
      // which is above none of them. Picking one (the leftmost, the widest) would be
      // inventing a destination. `to.scrollTop` below is a no-op there and the wheel is
      // simply not taken — which is the honest result, and the reason "the chrome above
      // the port is not a dead zone" is now a rule about the list.
      // First refusal is per axis, and it is a *claim on that axis alone* rather than on
      // the gesture. The chip row scrolls vertically and cannot take a `deltaX` at all,
      // so two things went wrong in turn: asking `deltaY < 0` about a purely sideways
      // swipe (`deltaY === 0`) read it as "downwards" and swallowed it (measured: 150px
      // of sideways wheel moved nothing with 352px of list to the right), and then a
      // diagonal one let the row keep the half it could use *and* the half it could not
      // (measured: chip row 120, list 0). Each axis is followed separately and whatever
      // no one wanted is forwarded.
      //
      // A scroll *container*, not merely a box whose content rounds a few pixels past it:
      // the view-switch button measures 24 against 21 from line-height alone, and asking
      // about overflow only would have let it swallow every wheel over the topbar.
      var takeY = e.deltaY !== 0, takeX = e.deltaX !== 0;
      for (var n = e.target; n && n !== col && (takeY || takeX); n = n.parentElement) {
        var cs = getComputedStyle(n);
        if (takeY && (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
          n.scrollHeight > n.clientHeight + 1 &&
          (e.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop < n.scrollHeight - n.clientHeight - 1)) takeY = false;
        if (takeX && (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
          n.scrollWidth > n.clientWidth + 1 &&
          (e.deltaX < 0 ? n.scrollLeft > 0 : n.scrollLeft < n.scrollWidth - n.clientWidth - 1)) takeX = false;
      }
      if (!takeY && !takeX) return;
      // `to` is resolved at the top of the handler rather than captured when this was
      // armed: arming happens once, at the first `paneRefs()`, and the layout changes many
      // times after it — a captured port would forward every wheel to `.work` on a board
      // that stopped scrolling, and the dead zone this exists to close would open again in
      // the kanban layout only.
      //
      // Lines and pages are real delta modes — Firefox sends lines for a mouse wheel —
      // and forwarding them as pixels would move the board by three.
      var k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? to.clientHeight : 1;
      if (takeY) to.scrollTop += e.deltaY * k;
      if (takeX) to.scrollLeft += e.deltaX * k;
    }, { passive: true });
  }

  // The repo, as a rail value: its dot and its name, and a press that scopes the board
  // to it. `.repo-dot` is the same 8px mark the list row wears, so the colour on the
  // puck page finally has its name written next to it instead of being a code.
  function repoValue(item) {
    var b = el("button", "linklike repo-cell");
    b.type = "button";
    var dot = el("span", "repo-dot");
    dot.style.background = item.repoColor;
    b.appendChild(dot);
    b.appendChild(document.createTextNode(item.repoName));
    b.title = "Show " + item.repoName + " pucks";
    // `keep`: never toggle. The sidebar's row is a place you can step out of; this is a
    // destination, and from a board already scoped to this repo the toggle would have
    // answered "show me this repo" by showing every repo.
    b.addEventListener("click", function () { goToPlace("repo", item.repo, true); });
    return b;
  }

  // A property row: mono key + value node. Add a field = add a row (growable).
  //   field: the model's name for the row, when it differs from the reader's word.
  //   The label is free to change; `data-field` is what the shortcuts and the tests
  //   hang on, so it stays the name the data uses.
  function propRow(k, valNode, cls, field) {
    var row = el("div", "prop" + (cls ? " prop-" + cls : ""));
    row.dataset.field = String(field || k).toLowerCase();
    row.appendChild(el("span", "prop-k", k));
    var v = el("div", "prop-v");
    if (valNode != null) v.appendChild(valNode);
    row.appendChild(v);
    return row;
  }

  // ── overlay primitive ───────────────────────────────────────────────────────
  // One surface, two presentations: an anchored popover on a wide screen, a bottom
  // sheet on a phone. The *content* — a list, a calendar, a form — is written once
  // and knows nothing about which it got; presentation is a parameter, the same
  // move that made grouping a variable in GROUPS.
  //
  // The sheet deliberately does NOT shrink for the keyboard. It keeps its height
  // and the keyboard covers the bottom of it: no reflow when the keyboard comes and
  // goes, the scroll position survives, and there is no visualViewport dance. Three
  // things make that correct rather than sloppy — the field stays pinned at the top,
  // the first rows sit in the band above the keyboard, and the body gets bottom
  // padding while a field is focused so the last row can still be scrolled into
  // view. Without the third, the last option would be unreachable.
  var PHONE = "(max-width: 640px)";
  function isPhone() { return window.matchMedia(PHONE).matches; }

  // While a sheet is up, the page behind it must be inert — scrolling it would move
  // the thing you are about to come back to. `overflow: hidden` alone doesn't hold
  // on iOS, so the body is pinned at its current offset and put back afterwards.
  // Counted, because a sheet can open over the puck modal, which locks too.
  // The scrollport is `.work`, not the page — the shell is a fixed-height column — so
  // this locks that box. Pinning the *body* was the old shape and would now hold
  // nothing: the body no longer scrolls, and the board behind the sheet would move
  // freely. `overflow: hidden` on the port is enough here precisely because it is not
  // the document scroller, which is the case iOS mishandles.
  // The box that is *currently* locked, remembered rather than resolved twice. Before the
  // kanban got a port of its own the question had one answer for the life of a sheet, so
  // asking again on the way out was free; it is not any more. See `unlockScroll`.
  //
  // **Sabotage cannot fell this one, and that is worth stating rather than hiding.** With
  // `relockScroll` below in place the two answers always agree by the time anything
  // unlocks — every path that moves the port under a held lock runs through `renderBoard`,
  // and the lock is taken in exactly one place (a surface's scrim) and released in one.
  // It stays because it is what makes `unlockScroll` independent of that guarantee: two
  // functions that must agree about a mutable answer is the shape this file keeps
  // removing, not one to add.
  var scrollLocks = 0, lockedY = 0, lockedX = 0, lockedEl = null;
  // ── which box actually scrolls ──────────────────────────────────────────────
  // One question, asked in one place. It was asked in four — the wheel forwarder, the
  // scroll lock, the puck page's saved place and the tab stop — and every one of them
  // answered `.work`, which was true right up until kanban got a scrollport of
  // its own. Four copies of a fact is how they come to disagree; this is the same move
  // as `liftArchive()` and `sortChain()`.
  //
  // Two answers, and the layout decides between them:
  //
  // - **In kanban it is `.port`, the box around the board — and it scrolls sideways only.**
  //   The board used to carry `overflow-x: auto` with no height to scroll within, so
  //   `.col-head`'s `position: sticky` pinned against nothing and the sideways scrollbar sat
  //   at the bottom of 4700px of cards instead of at the bottom of the window. The obvious
  //   repair is to give the board a height — and that was built, and it put the footer at
  //   the bottom of the window forever, because a footer cannot go *inside* a box laid out
  //   `grid-auto-flow: column`. So the scroller became one box out, and the board went back
  //   to overflowing visibly: exactly what `.board.as-list` has always done.
  //
  //   **Two things have changed since and neither is visible from here.** The footer left
  //   for the sidebar, so the port holds only the board — the box stays because a sticky
  //   column head must not resolve against the board, which is a separate reason from the
  //   one it was built for. And the vertical axis moved into the columns: `.cards` is what
  //   scrolls downwards now, so what this function answers is *the box that scrolls
  //   sideways*. Anything asking it about a vertical place is asking the wrong box; see
  //   `colPlaces`.
  // - **The list is not.** `.board.as-list` is no scroller — that is what buys the group
  //   heading its vertical pin — so there `.work` is the port, unchanged.
  //
  // And a puck page is neither, which is why the class is asked first: `#board` is
  // `display: none` there but keeps its layout class, so a puck opened from the board
  // would otherwise hand back a hidden box with no scroll range at all. The puck's own
  // content is `.work`'s, always.
  function scrollPort() {
    paneRefs();
    if (!workEl) return null;
    if (document.body.classList.contains("viewing-puck")) return workEl;
    return portEl && boardEl && !boardEl.classList.contains("as-list") ? portEl : workEl;
  }
  // The port is a tab stop and a labelled region, because the page stopped being one —
  // Page Down and Space from the topbar need something to move, and Chrome puts
  // scrollers in the tab order by itself where Safari does not. So the marks follow the
  // port rather than sitting on `.work` in the markup: a box that no longer scrolls is
  // not a stop, and a region with no name is worse than no region.
  // Who the port *is* — its name and its role. Not its tab stop: this runs from
  // `renderBoard` before the board is filled, where every box measures 0, and a stop is a
  // question about size. `markStops` owns `tabindex` for both boxes and is called where
  // measuring is allowed.
  function markPort() {
    var port = scrollPort();
    if (!port) return;
    [workEl, portEl].forEach(function (n) {
      if (!n || n === port) return;
      n.removeAttribute("role");
      n.removeAttribute("aria-label");
    });
    // Both ports are plain `div`s, so both want the role. It is `#board` that must never
    // have it — a `<main>` is already a landmark and `region` would replace it with a
    // weaker one — and the board stopped being a port when `.port` took the job.
    // A named region whether or not it is a stop: landmarks are navigated by name rather
    // than by Tab, so the name costs no keystrokes and the stop is the thing that must be
    // earned. Same sentence `renderColumns` already says about a column.
    port.setAttribute("role", "region");
    port.setAttribute("aria-label", document.body.classList.contains("viewing-puck") ? "Puck" : "Board");
  }
  // Which columns are keyboard stops, and it has two callers on purpose. Chrome puts
  // *overflowing* boxes in the tab order by itself and Safari puts none there; matching
  // the first is the whole point, so an empty or short column is not a stop. What it
  // cannot follow is a resize that changes the answer without a redraw: rare, and a stale
  // stop is a far smaller cost than seven inert ones on every filtered board.
  //
  // The second caller is `closeDetail`, and it is the third face of one rule: **a hidden
  // scroller cannot be measured and cannot be written to.** A board redrawn behind an open
  // puck (`loadWritableRepos` landing, an edit) measures a `display: none` subtree where
  // every box answers 0, so the pass at the end of `renderColumns` runs and decides *no
  // column is a stop* — measured, a 15-card column `tabindex="0"` before, gone after, and
  // still gone once the puck closed and it was scrolling again. Codex found it (#54). The
  // place had both its repairs already (the snapshot on the way in, the restore on the way
  // out); the stop had none, and the comment beside that pass said the opposite — "the
  // pass still runs, because it also decides the tab stops" — which is true of the call
  // and false of the answer.
  // Every `tabindex` the board and its ports carry, decided in one pass, because they all
  // answer the same question — *does this box have anything to scroll?* — and a box that
  // does not is a target where arrows, Page Down and Space do nothing.
  //
  // The port was the one exception, and it was written as an unconditional stop back when
  // it was the only scroller on the board. A kanban view that fits — Inbox, a board
  // filtered to one column — has no range at all: measured at 1400×900, `#port` carrying
  // `tabindex="0"` with 0 of travel on both axes, and no column a stop either, so the
  // keyboard stopped somewhere nothing moves. Codex found it (#54). Either axis counts:
  // the list's `.work` is two-axis, and a list that only overflows sideways is still a box
  // Page Down has an answer for.
  function markStops(board) {
    [workEl, portEl].forEach(function (n) {
      if (!n) return;
      var isPort = n === scrollPort();
      if (isPort && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) n.tabIndex = 0;
      else n.removeAttribute("tabindex");
    });
    markColumnStops(board);
  }
  function markColumnStops(board) {
    if (!board) return;
    // Columns only — the tray is deliberately not a stop, and the reason is its rows rather
    // than its key. A column's cards are `div`s with a click handler and nothing focusable
    // inside, so the scroller is the *only* keyboard route to what is down there; the tray's
    // rows are `<button>`s, so Tab already reaches every eye and the browser scrolls each one
    // into view. Chrome draws the same line by itself: measured in the tab order, a column's
    // `.cards` (0 focusable children) is in it and the tray's (11) is not. Marking the tray
    // would be a new stop rather than the Safari parity this exists for. It still carries
    // `data-col` — the offset snapshots want it, and that is a different question.
    Array.prototype.forEach.call(board.querySelectorAll(".column:not(.hidden-cols) > .cards[data-col]"), function (k) {
      if (k.scrollHeight > k.clientHeight + 1) k.tabIndex = 0;
      else k.removeAttribute("tabindex");
    });
  }
  function lockScroll() {
    if (scrollLocks++) return;
    var port = scrollPort();
    if (!port) return;
    // `overflow: hidden` holds the *user's* scrolling, not ours.
    stopGlide();
    lockedEl = port;
    lockedY = port.scrollTop;
    lockedX = port.scrollLeft;
    port.style.overflow = "hidden";
    // And the columns, which is where the board's vertical scroll went. Hiding the port's
    // overflow stopped holding the thing that moves the moment each column became its own
    // scroller — measured with the Display sheet open on a phone: the port was `hidden`
    // and a column still went 0 → 250 behind it.
    //
    // A class rather than a list of elements, and that is the load-bearing choice. The
    // sheet that locks is the one that re-renders the board (Display changes what is
    // drawn), so a stored set of `.cards` nodes would be detached the moment it mattered —
    // the exact failure `relockScroll` exists to paper over for the port. A selector has
    // no stale reference to keep: whatever the board draws next is already locked.
    document.body.classList.add("board-locked");
  }
  // **Unlock the box that was locked, not the one the question answers now.** The layout
  // segment sits at the top of that very sheet, so switching to List with it open moved
  // the port out from under the lock: `unlockScroll` cleared `.work` and left `#board`
  // with an inline `overflow: hidden` nobody would take off again. Measured with a wheel
  // over the board in that state — 0px against 300 — so the reader could not scroll the
  // board at all, while our own `scrollTop` writes went on working and hid it from every
  // programmatic check. Codex, #54.
  function unlockScroll() {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks) return;
    var port = lockedEl;
    lockedEl = null;
    if (!port) return;
    port.style.overflow = "";
    document.body.classList.remove("board-locked");
    // Hiding the overflow drops the scroll offset, so it is put back — the sheet closes
    // onto the row you opened it from, not onto the top of the list. The columns need no
    // equivalent: `overflow: hidden` on a box that keeps its content keeps its offset too,
    // and unlike the port nothing re-points at them mid-lock.
    port.scrollTop = lockedY;
    port.scrollLeft = lockedX;
  }
  // And the lock follows the port, or the other half of that gesture is a board nobody is
  // holding: the sheet stays up over a list whose port was never locked. That half cannot
  // be measured from a test the way the first one can — `overflow: hidden` has never
  // stopped our own `scrollTop` writes, which is the only scrolling a synthetic check can
  // do — so what is asserted is the transfer itself: the old box released, the new one
  // hidden. The old one gets nothing put back, because its offsets belong to a layout that
  // is no longer drawn; the new one is locked wherever it now stands.
  function relockScroll() {
    if (!scrollLocks) return;
    var port = scrollPort();
    if (!port || port === lockedEl) return;
    if (lockedEl) lockedEl.style.overflow = "";
    lockedEl = port;
    lockedY = port.scrollTop;
    lockedX = port.scrollLeft;
    port.style.overflow = "hidden";
  }

  // The scrim stops the pointer, not the keyboard. A sheet is modal, so the app
  // behind it goes `inert` — otherwise Tab, a switch control or a screen reader
  // walks straight out of the sheet into a board nobody can see, and activating
  // something there edits or navigates behind the surface. `#app` only: the palette
  // is a sibling and is deliberately allowed on top (see the Escape order).
  // One rule instead of a trap per layer: **the top layer is live, everything else
  // on <body> is inert.** A stack, because the layers genuinely nest — the palette
  // opens over a sheet, help over the palette — and the one on top is the only one
  // the keyboard should be able to reach. Writing a focus trap into each of them
  // would be three copies of the same logic and a fourth hole the day a fifth layer
  // arrives.
  //
  // A layer names the nodes that stay live: a sheet keeps its scrim, so tapping
  // outside still dismisses it. Everything else on <body> — the app, the layers
  // below — goes inert, which blocks the pointer, Tab *and* the screen reader.
  var layers = [];
  function pushLayer(nodes) {
    var layer = { nodes: nodes };
    layers.push(layer);
    applyInert();
    return function () {
      var at = layers.indexOf(layer);
      if (at < 0) return;
      layers.splice(at, 1);
      applyInert();
    };
  }
  // `inert` is what actually removes a layer from the tab order — but where it is
  // missing we only get `aria-hidden`, which a screen reader honours and Tab does
  // not. So the stack keeps its own trap: one listener for every layer, instead of
  // the sheet having one and the palette, help and panels having none.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Tab" || !layers.length) return;
    var top = layers[layers.length - 1].nodes.filter(Boolean);
    var f = [];
    top.forEach(function (n) { f = f.concat(focusables(n)); });
    if (!f.length) { e.preventDefault(); return; } // nothing to land on: stay put
    var first = f[0], last = f[f.length - 1], at = document.activeElement;
    // A layer's own container is not part of its cycle: it holds focus right after
    // opening and sits before its children in tab order, so forward Tab lands
    // inside by itself while Shift+Tab would step out of the dialog.
    var out = !top.some(function (n) { return n.contains(at) && at !== n; });
    if (e.shiftKey ? (out || at === first) : (out || at === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }, true);
  function applyInert() {
    var top = layers.length ? layers[layers.length - 1].nodes : null;
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      var off = !!top && top.indexOf(n) === -1;
      if ("inert" in n) n.inert = off;
      // Pre-`inert` browsers get the screen-reader half, which is the part a scrim
      // can't do at all. Tab is handled by the sheet's own trap either way.
      else if (off) n.setAttribute("aria-hidden", "true");
      else n.removeAttribute("aria-hidden");
    }
  }
  // Everything in `root` a Tab can land on, in document order.
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    var all = root.querySelectorAll(FOCUSABLE), out = [];
    for (var i = 0; i < all.length; i++) if (all[i].offsetParent !== null) out.push(all[i]);
    return out;
  }

  // Drag the sheet: down far enough closes it, up snaps it to full height, anything
  // short springs back. Dragging from the body is allowed only when the list is
  // already at the top and the finger is going down — otherwise that gesture is a
  // scroll, and stealing it would make the list feel broken.
  // Drag the sheet: it follows the finger the whole way. Upward it *grows* — the
  // bottom stays put and the top rises, which is what a sheet expanding looks like
  // — and past its natural height it can't shrink further, so downward turns into
  // sliding it off the screen. Let go past the close threshold and it dismisses;
  // otherwise it settles at whichever detent it is nearest.
  //
  // Growing (height) rather than moving (transform) matters: a translated sheet
  // leaves a gap under it and shows the same content moved, while a taller one
  // actually reveals more list — the thing you dragged up to see.
  var SHEET_CLOSE = 96, SHEET_FULL = 0.94;
  function draggableSheet(root, body, close) {
    var startY = 0, dy = 0, slid = 0, pending = false, dragging = false, fromBody = false;
    var atTop = true, wasFull = false, mode = "";
    var baseH = 0, naturalH = 0, maxH = 0, restCap = 0;
    var startTop = 0, lastY = 0, lastT = 0, vy = 0, glide = 0;
    var clock = window.performance && performance.now
      ? function () { return performance.now(); }
      : function () { return +new Date(); };

    function canScroll() { return body.scrollHeight > body.clientHeight + 1; }

    function heights() {
      maxH = Math.round(window.innerHeight * SHEET_FULL);
      if (!root.classList.contains("full")) {
        naturalH = root.offsetHeight;          // innehållets höjd, direkt avläst
        // Vilodetentens tak, läst ur CSS medan regeln som bär det gäller. Vid full
        // höjd är `max-height` full-lägets — och det är just där taket behövs.
        var cap = parseFloat(getComputedStyle(root).maxHeight);
        if (cap) restCap = cap;
        return;
      }
      // Vid full höjd är vilohöjden inte den man ser, och innehållet byts medan arket
      // står uppfällt: filtret går från sin rotlista till en värdelista. En vilohöjd
      // från förra listan ger fel golv att glida ur och fel mittpunkt att snäppa mot —
      // mätt vilade rotlistan på 239, och efter bytet till 34 etiketter tog ett drag på
      // 420 px arket till 506 i stället för att stänga det.
      // Räknas fram i stället för att mätas: att mäta den kräver att `.full` tas av,
      // och en klass som tas av och sätts tillbaka runt en påtvingad layout startar
      // övergången tillbaka. Arkets höjd duger inte som utgångspunkt heller — kroppen
      // växer inte med arket, så en kort lista lämnar tomrum under sig.
      var rr = root.getBoundingClientRect();
      var chrome = body.getBoundingClientRect().top - rr.top
        + (parseFloat(getComputedStyle(root).paddingBottom) || 0);
      var want = chrome + body.scrollHeight;
      naturalH = Math.round(restCap ? Math.min(want, restCap) : want);
      // Aldrig 0: ett ark som nått full höjd utan att ha mätts skulle få `floor = 0`,
      // och ett drag nedåt hade skalat om det i evighet i stället för att glida undan —
      // `slid` växer aldrig, så det kan aldrig passera stängningströskeln.
      if (!naturalH) naturalH = root.offsetHeight;
    }
    function down(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (glide) { cancelAnimationFrame(glide); glide = 0; }
      fromBody = body.contains(e.target);
      // A drag that starts in the list is still the sheet's, unless the list has
      // somewhere to go itself. Downward: only from its top. Upward: only while the
      // sheet is already full — below that there is sheet left to reveal, and
      // revealing it is what the finger meant.
      wasFull = root.classList.contains("full");
      // "At its top" means "has nothing to give this gesture", and below full height a
      // list that cannot scroll at all never has anything to give — whatever offset it
      // is holding. Asking only about the offset discarded the drag on a collapsed
      // sheet whose list still remembered where it stood.
      atTop = !wasFull || body.scrollTop <= 0;
      if (fromBody && !atTop) return;
      heights();
      pending = true; dragging = false; mode = ""; startY = e.clientY; dy = 0; slid = 0;
      startTop = body.scrollTop; lastY = e.clientY; lastT = clock(); vy = 0;
      baseH = root.offsetHeight;
      // Pin the height for the whole gesture, from the very first touch. Putting a
      // finger on the sheet blurs the search field, which drops the keyboard
      // padding — and a content-sized sheet then shrinks by a third *under the
      // finger*, leaving the pointer over the scrim instead of the sheet it holds.
      root.style.height = baseH + "px";
      // Capture from the first touch when the gesture starts on the sheet's chrome:
      // the grip sits a dozen pixels below the top edge, so an upward drag leaves
      // the sheet at once and its pointermoves would go to the scrim instead. Not
      // from the list, though — capture retargets the compatibility mouse events
      // too, so a tap on a row would resolve its click against the sheet and the
      // row's own handler would never run.
      // Nor from a *control* in the chrome, for the very reason the list is excluded: the
      // back chevron sits in the head, so it is chrome by position and a button by purpose,
      // and the capture has to follow purpose. Captured, its click resolved against the
      // sheet and its handler never ran — the sheet drew a way back that did nothing, which
      // is the same class of failure as a control that only fails when you press it.
      var onControl = e.target && e.target.closest && e.target.closest("button, a, input, select, textarea");
      if (!fromBody && !onControl) {
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
      }
    }
    function move(e) {
      if (!pending && !dragging) return;
      dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < 6) return;
        // Up from the list is a scroll only once the sheet is full; down only once
        // the list is at its own top. Two guards, because they are two questions —
        // the old code asked neither for the upward case and simply gave it away.
        if (fromBody && dy < 0 && wasFull) {
          // The list has `touch-action: none` while it sits at its top (syncPan),
          // so this scroll is nobody's unless we do it. See the note there.
          if (!canScroll()) { pending = false; return; }
          mode = "list";
        } else if (fromBody && dy > 0 && !atTop) { pending = false; return; }
        else mode = "sheet";
        dragging = true;
        if (mode === "sheet") root.classList.add("dragging");
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
      }
      if (mode === "list") {
        var t = clock();
        if (t > lastT) vy = (e.clientY - lastY) / (t - lastT);
        lastY = e.clientY; lastT = t;
        body.scrollTop = startTop - dy;
        e.preventDefault();
        return;
      }
      applySheet(e.clientY);
      e.preventDefault();
    }
    function applySheet(clientY) {
      dy = clientY - startY;
      var want = baseH - dy;              // finger up → taller
      var floor = Math.min(naturalH, baseH);
      if (want >= floor) {
        slid = 0;
        root.style.height = Math.min(want, maxH) + "px";
        root.style.transform = "";
      } else {
        slid = floor - want;             // no shorter than it started: slide it away
        root.style.height = floor + "px";
        root.style.transform = "translateY(" + slid + "px)";
      }
    }
    function up() {
      if (!dragging) {
        pending = false;
        // Release the pin only after the click has been dispatched: letting the
        // sheet re-size now would move the row out from under the finger between
        // pointerup and click, and the tap would land on whatever slid into place.
        setTimeout(function () { if (!pending && !dragging) root.style.height = ""; }, 0);
        return;
      }
      pending = false; dragging = false; handOn = false;
      if (mode === "list") {
        mode = "";
        root.style.height = "";
        coast();
        return;
      }
      root.classList.remove("dragging");
      if (slid > SHEET_CLOSE) { close(); return; }
      var h = root.offsetHeight;
      root.style.transform = "";
      root.style.height = "";
      // Settle at the nearer detent, so a drag that got most of the way there
      // finishes the journey instead of springing back.
      if (h > (naturalH + maxH) / 2) root.classList.add("full");
      else {
        // Give the list back its top on the way down. Below full height the body is
        // `overflow: hidden` but still holds whatever offset it had, so the rows above
        // it would be clipped out of a box that can no longer be scrolled — gone until
        // the sheet is expanded again.
        root.classList.remove("full");
        body.scrollTop = 0;
      }
      syncPan();
    }
    // A hand-rolled fling, for the one gesture the browser isn't allowed to have:
    // the first upward drag from the list's top. Every later one is native again —
    // the moment the offset leaves 0, panning is the list's and momentum with it.
    function coast() {
      var v = vy;                                  // px/ms, finger direction
      syncPan();
      // En hastighet är färsk eller ingen alls. Står fingret stilla skickas inga
      // pointermove, så `vy` behåller sitt sista värde hur länge som helst — svep,
      // håll kvar, släpp, och listan flög iväg som om fingret fortfarande rörde sig.
      // Ingen native scroll gör det. En bildruta är 17 ms; 80 räcker för ett glapp i
      // händelseströmmen och är långt under en paus någon hinner uppfatta.
      if (clock() - lastT > 80) return;
      if (Math.abs(v) < 0.05) return;
      var last = clock();
      var step = function () {
        var t = clock(), dt = t - last;
        last = t;
        // Ett avbrutet fling är inget fling. Ställs sidan åt sidan står
        // `requestAnimationFrame` stilla, och att bara klippa `dt` hade låtit
        // trögheten överleva pausen och rulla vidare när man kommer tillbaka — samma
        // fel som ett gammalt hastighetsprov, en våning ned. Förflyttningen klipps
        // ändå, så ett kortare hack ger en långsammare bildruta och inte ett skutt.
        if (dt > 100) { glide = 0; syncPan(); return; }
        body.scrollTop -= v * Math.min(dt, 32);    // finger up (v < 0) → offset grows
        v *= Math.pow(0.995, dt);
        var live = Math.abs(v) > 0.02 && body.scrollTop > 0
          && body.scrollTop < body.scrollHeight - body.clientHeight - 1;
        glide = live ? requestAnimationFrame(step) : 0;
        if (!live) syncPan();
      };
      glide = requestAnimationFrame(step);
    }
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);

    // Överlämningen: gesten webbläsaren redan har tagit.
    //
    // Börjar draget en bit ned i listan äger listan panoreringen — den har någonstans
    // att ta vägen, och `down()` lämnar därför gesten ifred. Men listan tar slut. Drar
    // man vidare nedåt därifrån hände ingenting med arket förrän man släppte och tog
    // om, för vår pointer-ström är död: iOS skickar `pointercancel` så fort den börjat
    // scrolla. `touchmove` fortsätter däremot att komma under hela scrollen, och det
    // är den tråden vi hänger kvar i.
    //
    // Vid listans topp finns inget kvar för webbläsaren att göra med resten av
    // fingerresan — `overscroll-behavior: none` tog bort studsen — så vi tar den. Ingen
    // `preventDefault` behövs eller vore möjlig; vi tävlar inte om gesten, vi ärver den
    // när den lagts ned.
    var handY = 0, handOn = false, handArmed = false;
    // Ankaret måste sättas när fingret landar. Utan det stod `handY` kvar på 0 —
    // skärmens överkant — och första röresen räknades som femhundra pixlars resa
    // nedåt: arket föll ihop till vilohöjd och sköts av skärmen, för att sedan klättra
    // tillbaka med fingret. (Mätt: 506@469 → 654@190 under ett drag *uppåt*.)
    // Armeras på det som är sant när fingret landar: listan äger gesten om den har
    // någonstans att ta vägen — samma villkor som `touch-action` låses vid, och exakt
    // de gester webbläsaren tar ifrån oss. Att i stället vänta på ett `touchmove` som
    // ser `scrollTop > 0` hade missat ett drag som börjar några pixlar från toppen och
    // är nere på 0 redan vid första röresen.
    body.addEventListener("touchstart", function (e) {
      var t = e.touches && e.touches.length === 1 && e.touches[0];
      handY = t ? t.clientY : 0;
      handOn = false;
      handArmed = root.classList.contains("full") && body.scrollTop > 0;
    }, { passive: true });
    function handoff(e) {
      var t = e.touches && e.touches.length === 1 && e.touches[0];
      if (!t) return;
      if (handOn) { applySheet(t.clientY); return; }
      if (pending || dragging) return;                 // gesten är redan vår
      // Bara en gest listan faktiskt tagit går att ärva. Deklinerar pointer-vägen av
      // andra skäl — ett drag uppåt i en lista som inte kan scrolla — finns ingenting
      // att ärva, och överlämningen ska hålla sig utanför den.
      if (!handArmed) return;
      if (body.scrollTop > 0) { handY = t.clientY; return; }
      // Listan står på sin topp. Räkna resan härifrån, och bara nedåt: uppåt finns
      // ingenting att ge arket, och då ska handY följa med så en vändning mäts rätt.
      if (t.clientY - handY < 8) { if (t.clientY < handY) handY = t.clientY; return; }
      heights();
      fromBody = true; atTop = true; wasFull = true; mode = "sheet";
      dragging = true; handOn = true; startY = handY; dy = 0; slid = 0;
      baseH = root.offsetHeight;
      root.style.height = baseH + "px";
      root.classList.add("dragging");
      applySheet(t.clientY);
    }
    body.addEventListener("touchmove", handoff, { passive: true });
    body.addEventListener("touchend", function () { if (handOn) up(); }, { passive: true });
    // Här *ska* ett avbrott avslutas, till skillnad från listans sidledskast en våning upp:
    // det finns ingen tröghet att sjösätta, bara ett ark som står mitt i ett drag med en
    // inline-höjd och `.dragging` kvar. Alternativet till `up()` är ett ark som hänger sig,
    // inte ett som står stilla.
    body.addEventListener("touchcancel", function () { if (handOn) up(); }, { passive: true });
    // Panoreringen är listans bara när listan har någonstans att ta vägen *åt det
    // håll webbläsaren låser sig vid*.
    //
    // `touch-action` läses en gång, vid touch-start, innan någon riktning finns. Den
    // kan alltså inte koda en riktning — bara något som redan är sant då. Ett
    // icke-passivt `touchmove` ser riktningen men kommer för sent: Chromium skickar
    // `pointermove` först och har redan bestämt sig för panoreringen (mätt:
    // preventDefault på första touchmove, `pointercancel` två drag senare ändå).
    //
    // Förra regeln frågade bara *om* listan kunde scrolla. Den räckte för en kort
    // lista, och gick sönder på exakt det fall användaren körde: tolv etiketter som
    // verkligen svämmar över, arket på full höjd, listan vid sin topp — `pan-y`, och
    // det nedåtgående draget gick till webbläsaren som studsade listan i stället för
    // att stänga arket. (Testet höll med, för jag hade skrivit in fel förväntan.)
    //
    // Det som *är* avgjort vid touch-start är listans scrollposition. Vid toppen
    // tillhör nedåt arket, och då får listan inte gesten alls — den uppåtgående
    // scrollen kör vi själva den gången (se `coast`). Så fort positionen lämnat 0 är
    // panoreringen listans igen, med webbläsarens egen tröghet. Räknas om när arket
    // ändrar storlek, innehåll eller scrollposition.
    function syncPan() {
      var scrollable = root.classList.contains("full") && canScroll();
      body.style.touchAction = scrollable && body.scrollTop > 0 ? "pan-y" : "none";
    }
    body.addEventListener("scroll", syncPan, { passive: true });
    root.__syncPan = syncPan;
    syncPan();
    var watchers = [];
    // Två observatörer, för `scrollHeight` kan ändras utan att rutan gör det.
    // `ResizeObserver` ser bara kroppens *ruta*. Filtrerar man en lång lista ned till
    // några rader i ett ark som redan står på full höjd ändras `scrollHeight` men inte
    // kroppens mått, och panoreringen hade blivit kvar hos en lista som inte längre
    // har någonstans att ta vägen. I mina mätningar råkade rutan ändras med innehållet
    // (433 → 360 → 433) och synken höll — men det är en tillfällighet i den här
    // layouten, inte en garanti, och en regel som vilar på en tillfällighet är en regel
    // som faller när layouten rör sig.
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(syncPan);
      ro.observe(body);
      watchers.push(ro);
    }
    if (window.MutationObserver) {
      var mo = new MutationObserver(syncPan);
      mo.observe(body, { childList: true, subtree: true });
      watchers.push(mo);
    }
    // Varje ark får sina egna observatörer, och ett ark lever bara till nästa
    // stängning. Lyssnarna går med noderna de sitter på; observatörerna hänger på
    // dokumentet, så de lämnas tillbaka och kopplas ur av `onDestroy`.
    return function () { watchers.forEach(function (w) { w.disconnect(); }); watchers = []; };
  }

  // Every open surface, so navigation and viewport changes can clear them: a sheet
  // lives on <body>, not inside the puck it belongs to, and would otherwise survive
  // the puck being swapped out under it.
  var openSurfaces = [];
  function closeSurfaces() {
    openSurfaces.slice().forEach(function (s) { s.close(); });
  }

  // Nudge a popover horizontally until it is inside the window, and no further. The
  // margin keeps it off the very edge, where a rounded corner and a shadow would
  // otherwise be cut in half.
  // A popover wider than the window can't be satisfied; pin it to the left edge
  // rather than the right, so it is the *end* of a row that is lost and not the
  // beginning — a truncated label is still readable from its start.
  function wrapOf(root) { return root.parentElement || document.body; }
  // Every clipping ancestor, intersected, and per axis — not the first one found. The
  // kanban board sets `overflow-x: auto`, which makes its computed `overflow-y` `auto`
  // as well, so a first-match walk stopped there and read a bottom edge that is wherever
  // the tallest column ends: measured at 1000×240, a column menu ran to 245 while `.work`
  // ended at 240, with no cap applied because the board's bottom was 473. The nearest
  // clipper is a different box on each axis, so the answer is an intersection.
  function clipBox(node) {
    var box = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    for (var n = node; n && n !== document.documentElement; n = n.parentElement) {
      var cs = getComputedStyle(n);
      var cy = /auto|scroll|hidden/.test(cs.overflowY), cx = /auto|scroll|hidden/.test(cs.overflowX);
      if (!cy && !cx) continue;
      var b = n.getBoundingClientRect();
      if (cy) { box.top = Math.max(box.top, b.top); box.bottom = Math.min(box.bottom, b.bottom); }
      if (cx) { box.left = Math.max(box.left, b.left); box.right = Math.min(box.right, b.right); }
    }
    return box;
  }
  function fitPop(root) {
    var m = 8;
    // Measured as the surface *wants* to be, not as the last fit left it. This runs
    // again whenever the content changes — opening a field's value list grows the panel
    // — and a rect that already carries the previous correction makes them accumulate.
    root.style.transform = "";
    root.style.maxHeight = "";
    root.classList.remove("pop-flip");
    var r = root.getBoundingClientRect();
    // The box that actually cuts, which is not the window: a rail popover lives inside
    // `.work`, whose `overflow: auto` clips at its own top edge — 52px down on a puck
    // page — so a flip measured against the viewport put the menu's first rows behind the
    // topbar with no scroll range above them to bring back (measured: top 8, `.work` top
    // 52, 44px gone). Asking the nearest clipping ancestor answers for every surface at
    // once, and falls back to the viewport when nothing above it clips.
    var box = clipBox(wrapOf(root));
    var dx = 0;
    if (r.right > box.right - m) dx = box.right - m - r.right;
    if (r.left + dx < box.left + m) dx = box.left + m - r.left;
    if (dx) root.style.transform = "translateX(" + Math.round(dx) + "px)";
    // And the same question downwards, which the fixed-height shell made a real one:
    // `.app` clips, and there is no page scroll left, so a popover running past the
    // bottom does not merely look wrong — its lower rows cannot be reached at all.
    // Measured at 1000×420 with the Labels list open: 328px tall, 14 of them below the
    // window.
    //
    // Which side it hangs from is *not* authored, unlike `menu-right`: a rail control
    // near the bottom of a puck page leaves no room below at any width, so capping to
    // what is there gives a 15px menu (measured, status picker at y=247 in a 300px
    // window) or, one row lower, a negative cap — invalid CSS, dropped, and the menu
    // runs off the bottom again. So the side is measured too, and the gap comes from
    // the stylesheet rather than being restated here.
    var wrap = root.parentElement;
    var a = wrap ? wrap.getBoundingClientRect() : r;
    var gap = r.top - a.bottom;
    var below = box.bottom - r.top - m;
    var above = a.top - gap - box.top - m;
    var flip = r.height > below && above > below;
    root.classList.toggle("pop-flip", flip);
    var room = flip ? above : below;
    // `room > 0` guards the one case the flip cannot help with: a window shorter than the
    // trigger itself, where both sides are negative. A cap of zero would hide the menu
    // outright and a negative one is invalid CSS that the browser drops — so there it is
    // left uncapped, which is no worse than before. No test reaches it; a floor with a
    // number in it was written first and removed, since it changed real placements to
    // guard an unreachable one.
    if (room > 0 && r.height > room) {
      root.style.maxHeight = Math.round(room) + "px";
      root.style.overflowY = "auto";
    } else {
      root.style.overflowY = "";
    }
  }

  //   opts: { title, anchorWrap, cls, help, onClose, build(body, api) }
  //   → { close }
  // A level inside a surface says two things: what it is called, and how to leave it. Where
  // those are *drawn* is the shell's business and not the builder's — which is the promise
  // `openSurface` has always made, and the reason this is a function rather than a branch at
  // each call site.
  //
  // A sheet has a head, so the name becomes its title and the way back becomes a chevron
  // beside it. That is the fix for what a phone reported: the way back used to be a row in
  // the body labelled with the level you were *standing in*, which reads as "you are here"
  // rather than "go back" — and it could never line up with the rows under it, since its
  // label sits one chevron in. A popover has no head, so the same two facts stay a row at
  // the top of the body, exactly as before.
  //
  // Called *after* the builder clears the body, because that is what the builders do.
  // `title` omitted means level one: the surface's own name comes back and the way back goes.
  function surfaceLevel(body, title, onBack) {
    var sheet = body.closest && body.closest(".sheet");
    if (sheet) {
      var head = sheet.querySelector(".sheet-head");
      if (!head) return;
      var h3 = head.querySelector(".sheet-title");
      if (h3) h3.textContent = title || head.dataset.title || "";
      var old = head.querySelector(".sheet-back");
      if (old) old.remove();
      if (!onBack) return;
      var b = el("button", "sheet-back");
      b.type = "button";
      b.title = "Back";
      b.setAttribute("aria-label", "Back");
      b.appendChild(icon("chev-left"));
      b.addEventListener("click", onBack);
      head.appendChild(b);
      return;
    }
    if (!onBack) return;
    var row = el("button", "fp-back");
    row.type = "button";
    row.appendChild(icon("chev-left", "fp-chev"));
    row.appendChild(el("span", null, title || ""));
    row.addEventListener("click", onBack);
    body.insertBefore(row, body.firstChild);
  }
  var surfaceSeq = 0; // ids for the sheet headings that name their own dialog
  function openSurface(opts) {
    var phone = isPhone();
    var scrim = null;
    // Where focus came from, so closing hands it back to the control that opened
    // the surface instead of dropping it on <body> — from where the next Tab starts
    // over at the top of the page. The node alone is not enough: committing a value
    // rebuilds the detail pane, so the trigger we remember is detached by the time
    // we look. Remember which row it was in, and take the replacement.
    var lastFocus = document.activeElement;
    var lastField = null;
    if (lastFocus && lastFocus.closest) {
      var owner = lastFocus.closest(".prop");
      if (owner) lastField = owner.dataset.field;
    }
    var popLayer = null;
    var onDestroy = [];
    var root = el("div", (phone ? "sheet" : "pop") + (opts.cls ? " " + opts.cls : ""));
    var body = el("div", "surface-body");
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      var at = openSurfaces.indexOf(handle);
      if (at >= 0) openSurfaces.splice(at, 1);
      setTimeout(flushRefresh, 0); // catch up on any refresh this surface held off
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
      // Take focus back when we still hold it — or when nobody does. A layer that
      // sat on top of us (the palette, a panel) drops focus on <body> when it goes,
      // and a keyboard user closing the sheet next would otherwise be left at the
      // top of the page. What we must not do is *steal* it: closing usually happens
      // because the user aimed at something else, and pulling focus off that target
      // would undo their click as surely as re-rendering under it does.
      var at = document.activeElement;
      var hadFocus = root.contains(at) || !at || at === document.body;
      onDestroy.forEach(function (fn) { fn(); });
      if (popLayer) popLayer();
      if (scrim) { scrim.remove(); unlockScroll(); }
      root.remove();
      // Deferred, and only to something still on screen. Closing is often the first
      // step of navigating away — Back closes the surfaces, then hides the whole
      // detail pane — and handing focus to a trigger inside that pane strands it in
      // a hidden subtree. One turn later we can see which it was, and whether
      // anything else has claimed focus in the meantime.
      // No `document.contains(lastFocus)` here. A review read this as a live bug —
      // "the redraw detaches the trigger, so the guard skips the very case the
      // branch inside was written for" — and it isn't one: propPicker calls
      // `api.close()` *before* `onPick()`, so the trigger is still attached when
      // this runs. Verified by running the restore-after-commit test against the
      // unmodified code; it passed.
      // The guard goes anyway, because it states a requirement the code doesn't
      // have: the branch inside handles a detached node on purpose, so demanding an
      // attached one here is a trap for the first caller that rebuilds before it
      // closes. It also covers `lastFocus` being null while the row is known.
      if (hadFocus && (lastFocus || lastField)) {
        setTimeout(function () {
          var now = document.activeElement;
          if (now && now !== document.body) return;   // someone else took it
          var back = lastFocus;
          if ((!back || !document.contains(back)) && lastField) {
            // Redrawn: find the same row's control in the pane that replaced it.
            var row = document.querySelector('.prop[data-field="' + lastField + '"]');
            back = row ? focusables(row)[0] : null;
          }
          if (!back || !document.contains(back) || !back.offsetParent) return; // gone or hidden
          try { back.focus(); } catch (e2) {}
        }, 0);
      }
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (e.key !== "Escape") return; // Tab is the layer stack's job, for every layer
      // Anything stacked above a surface owns the keyboard: the help overlay, the
      // palette, and the New/Settings/token panels. Otherwise Escape dismisses a
      // surface nobody can see and leaves the visible layer standing. Asking "is
      // something above me?" rather than naming each one is what keeps a future
      // panel from re-opening this hole.
      // Unwind order: help → palette → panel → surface → puck.
      if (cmdkVisible() || helpOpen() || anyModalOpen()) return;
      e.stopPropagation(); // this layer only — the modal beneath stays open
      close();
    }
    // A click that *began* inside the surface is never an outside click, wherever it
    // ends up: dragging the sheet, or selecting text, moves the pointer far from
    // where it started, and the click then reports their common ancestor — the
    // body. Judging by where the gesture started is what makes a draggable sheet
    // survive its own drag.
    // The trigger counts as inside: it sits in the anchor wrapper, not in the
    // popover, so closing on it would race its own toggle — the handler would find
    // the surface already gone and open a fresh one, and the control could never be
    // clicked shut.
    function inside(node) {
      return root.contains(node) || !!(opts.anchorWrap && opts.anchorWrap.contains(node));
    }
    var downInside = false;
    function onDocDown(e) { downInside = inside(e.target); }
    function onDocClick(e) {
      if (downInside) { downInside = false; return; }
      // A surface rebuilds its own contents, which detaches the clicked node before
      // the event reaches the document — a plain contains() check then reads it as
      // "outside" and closes on every inner click.
      if (inside(e.target) || !document.contains(e.target)) return;
      close();
    }

    if (phone) {
      scrim = el("div", "sheet-scrim");
      scrim.addEventListener("click", close);
      document.body.appendChild(scrim);
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.tabIndex = -1; // focus lands on the sheet itself, never on a text field:
                          // that would raise the keyboard before anyone asked
      root.appendChild(el("div", "sheet-grip"));
      var head = el("div", "sheet-head");
      if (opts.help) {
        var h = el("a", "sheet-help", "?");
        h.href = opts.help; h.target = "_blank"; h.rel = "noopener";
        h.title = "What is this field?";
        head.appendChild(h);
      }
      head.dataset.title = opts.title || ""; // level 1 restores this without knowing it
      var h3 = el("h3", "sheet-title", opts.title || "");
      // **Named by the heading, not by a copy of it.** An `aria-label` taken from
      // `opts.title` is written once, and the heading is not: entering a level rewrites it
      // to `Ordering` or `Add a key` while a screen reader went on announcing the surface
      // as `Display`. Pointing at the heading means the accessible name *is* the visible
      // one, with no second thing to keep in sync — the alternative is two writers for one
      // fact, which is how they come to disagree. The id is per surface, since sheets can
      // stack.
      if (opts.title) {
        h3.id = "sheet-title-" + (++surfaceSeq);
        root.setAttribute("aria-labelledby", h3.id);
      }
      head.appendChild(h3);
      root.appendChild(head);
      root.appendChild(body);
      document.body.appendChild(root);
      lockScroll();
      popLayer = pushLayer([root, scrim]); // the scrim stays live: tap-outside still closes
      onDestroy.push(draggableSheet(root, body, close));
      // While a *text field* inside is focused the keyboard is up; pad the scroll
      // area so the last row can still be brought above it.
      //
      // Only text fields: a button takes focus on mousedown too, and padding the
      // body for that grew the sheet mid-tap. Since the sheet is anchored to the
      // bottom, growing moves every row upward — so the tap landed on the row above
      // the one you aimed at, or on nothing at all.
      var typing = function (n) { return n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA"); };
      root.addEventListener("focusin", function (e) { if (typing(e.target)) root.classList.add("kb"); });
      root.addEventListener("focusout", function () {
        setTimeout(function () {
          if (!typing(document.activeElement) || !root.contains(document.activeElement)) {
            root.classList.remove("kb");
          }
        }, 0);
      });
    } else {
      root.appendChild(body);
      (opts.anchorWrap || document.body).appendChild(root);
      if (!opts.anchorWrap) root.classList.add("pop-center");
    }

    var handle = { close: close, el: root };
    openSurfaces.push(handle);
    opts.build(body, { close: close, phone: phone });
    // Slide an anchored popover back into the window if the side it chose puts it
    // over an edge. The side is authored — `menu-right` says which of the trigger's
    // edges the surface hangs from, and that is a design decision about which way a
    // menu should open. Whether it *fits* is not a design decision, and it can't be
    // answered where the class is written: the same trigger sits at 1246px in a
    // 1600px window and at 950px in a 1024px one, so any fixed side is right at one
    // width and wrong at another. Measuring once the content exists answers it at
    // every width, and costs one layout read per open.
    // Only the anchored shell. A sheet spans the window by construction, and
    // `.pop-center` is already placed by transform — shifting either would move a
    // surface that was never out of bounds.
    if (!phone && opts.anchorWrap) {
      fitPop(root);
      // The panel rebuilds itself in place — a field row swaps the list for that field's
      // values — so a fit measured only at open is a fit for the smallest thing the
      // surface will ever be. Watching the body is what makes the cap follow it.
      var refit = new MutationObserver(function () { fitPop(root); });
      refit.observe(body, { childList: true, subtree: true });
      // And when the window changes rather than the content: a shortened window left the
      // flip and the cap that were right for the old one, and with no page scroll the rows
      // that fell outside had nothing to bring them back short of closing the menu.
      var onResize = function () {
        // A window that shrank past the trigger leaves the menu hanging off a control
        // nobody can see any more — measured at 1000×220: the chip's row sits at 250,
        // the port ends at 220, and no cap can bring either back. Refitting answers the
        // case where the anchor survived; the other one is a menu about nothing, so it
        // closes.
        var anchor = wrapOf(root).getBoundingClientRect(), box = clipBox(wrapOf(root));
        if (anchor.bottom > box.bottom || anchor.top < box.top) { close(); return; }
        fitPop(root);
      };
      window.addEventListener("resize", onResize);
      onDestroy.push(function () { refit.disconnect(); window.removeEventListener("resize", onResize); });
    }
    // Give a sheet's search field breathing room before the list, the way the
    // reference apps do. The gap has to belong to the *pinned* element, not sit
    // between it and the list: a margin there is not painted, so rows would scroll
    // through it. Wrapping the field lets the padding be part of what stays put —
    // and an <input> can't carry it itself, since padding-bottom on a field moves
    // its own text instead of adding space beneath it.
    // A builder is not required to produce its field up front — the filter panel
    // renders a plain list first and only inserts a search box once a field has
    // more than eight values. So watch the body rather than pinning once: whatever
    // arrives at the top gets pinned when it arrives.
    if (phone) {
      pinField();
      var watch = new MutationObserver(pinField);
      watch.observe(body, { childList: true });
      onDestroy.push(function () { watch.disconnect(); });
    }
    // Pin the field *and whatever leads up to it* — the filter panel puts a back
    // button above its search box, and pinning the box alone would leave that to
    // scroll away on its own. Anything past the field is the list, and scrolls.
    function pinField() {
      var kids = body.children;
      if (!kids.length || kids[0].classList.contains("sheet-pin")) return;
      var at = -1;
      for (var i = 0; i < kids.length && i < 3; i++) {
        if (kids[i].classList.contains("fp-search") || kids[i].classList.contains("tokenbox")) { at = i; break; }
      }
      if (at < 0) return;
      var held = document.activeElement; // moving a node blurs it — put focus back
      var pin = el("div", "sheet-pin");
      body.insertBefore(pin, kids[0]);
      while (body.children[1] && pin.children.length <= at) pin.appendChild(body.children[1]);
      if (held && pin.contains(held)) { try { held.focus(); } catch (e) {} }
    }
    // Move focus into the sheet unless the builder already placed it (the desktop
    // pickers focus their search field; the phone ones deliberately don't).
    if (phone && !root.contains(document.activeElement)) {
      try { root.focus({ preventScroll: true }); } catch (e) { root.focus(); }
    }
    setTimeout(function () {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("pointerdown", onDocDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    return handle;
  }

  // A surface picks its shell once, at open. Crossing the breakpoint — a phone
  // rotating into landscape — would leave a sheet with none of its media-scoped
  // positioning and the body still locked, so close instead of trying to morph.
  (function () {
    var mq = window.matchMedia(PHONE);
    var onChange = function () { closeSurfaces(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  })();

  // The six statuses are not one scale, and the model already says so in two
  // independent places: `TERMINAL` names the settled pair, and `VIEWS.all` is
  // literally `-status:inbox` — the one status excluded from every board view.
  // Three kinds, then: the queue (where in the order of work), the inbox (not a
  // promise yet), the archive (settled). Drawn flat they read as six steps of one
  // ladder, with `inbox` sitting between `later` and `done` as though it came after
  // "later" and before "done".
  //
  // Derived from those two properties rather than written out, so a status added to
  // STATUSES lands in a group by what it *is*. `inbox` is the only one named here,
  // and it was already special by name in `VIEWS.all`.
  //
  // The order inside is STATUSES' own — the board's column order. Putting `inbox`
  // first would read chronologically and match the sidebar, but it would give the
  // app a second ordering of one list and push the three common targets down a row;
  // fencing it where it stands says the same thing for less.
  function statusOptions() {
    var kind = function (s) { return s === "inbox" ? 1 : TERMINAL[s] ? 2 : 0; };
    var out = [], last = null;
    DATA.statuses.forEach(function (s) {
      var k = kind(s);
      if (last !== null && k !== last) out.push({ sep: true });
      last = k;
      out.push({ value: s, label: STATUS_LABEL[s] || s });
    });
    return out;
  }

  // A Linear-style editable property: a single chip showing the *current* value;
  // click opens a picker popover to change it. Static chip when not editable. This
  // is the growable pattern — a new field is one more propPicker, not a button row.
  //   opts: { editable, current, options:[{value,label}|{sep:true}], valueNode(o), onPick(v) }
  // An option carrying `sep: true` draws a rule instead of a row — the same rule the
  // ⋯ menu uses. It lets a list say "these are different kinds of thing" without the
  // picker learning what the kinds are; only the caller that builds the options knows.
  function propPicker(opts) {
    var cur = null;
    for (var i = 0; i < opts.options.length; i++) {
      if (!opts.options[i].sep && opts.options[i].value === opts.current) cur = opts.options[i];
    }
    var chip = el("button", "pick-chip");
    chip.type = "button";
    function paint(node) { chip.innerHTML = ""; chip.appendChild(node); }
    paint(cur ? opts.valueNode(cur) : el("span", "prop-muted", opts.placeholder || "\u2014"));
    if (!opts.editable) { chip.classList.add("static"); chip.disabled = true; return chip; }
    chip.classList.add("editable");
    // A chip whose value is bare text has nothing of its own to look like, so it
    // carries the box at rest. One whose value already has a shape — a status pill,
    // a date — does not, or the shape would be drawn twice. That is the difference,
    // not which surface it happens to sit on.
    if (opts.boxed) chip.classList.add("boxed");
    var wrap = el("div", "prop-pick");
    var open = null;
    chip.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) { open.close(); return; }
      open = openSurface({
        title: opts.title || "",
        anchorWrap: wrap,
        cls: "pick-menu",
        onClose: function () { open = null; },
        build: function (list, api) {
          opts.options.forEach(function (o) {
            if (o.sep) { list.appendChild(el("div", "menu-rule")); return; }
            var mi = el("button", "row pick-mi" + (o.value === opts.current ? " on" : ""));
            mi.type = "button";
            // The value, not just its label: the option's durable identity, for the
            // same reason `data-field` exists — a hook that doesn't move when the
            // wording does.
            if (o.value != null) mi.setAttribute("data-value", String(o.value));
            mi.appendChild(opts.valueNode(o));
            if (o.value === opts.current) mi.appendChild(icon("check", "pick-check"));
            mi.addEventListener("click", function () {
              api.close();
              if (o.value !== opts.current) opts.onPick(o.value);
            });
            list.appendChild(mi);
          });
          // No "create an option" here, on purpose: status and priority are closed
          // interface fields. An invented value would commit fine and then be
          // dropped by the harvester's normalize*() — a write that looks like it
          // worked and disappears an hour later.
        },
      });
    });
    wrap.appendChild(chip);
    return wrap;
  }

  // A searchable list of pucks \u2014 the control for every field whose value is
  // *another puck* (parent, blockers). Those can't be typed from memory the way a
  // date or an issue number can, and `window.prompt` hands the whole dialog to the
  // browser: on iOS that draws a system sheet in its own shape and colours, which
  // reads as a different app.
  //
  // Impossible choices are left out rather than refused afterwards: what can't be
  // picked shouldn't be pointable.
  //   opts: { current, repo, exclude(item) \u2192 bool, title, placeholder, empty, onPick(item|null) }
  function puckPicker(label, opts) {
    var wrap = el("div", "prop-pick");
    // "\u22ef" is the secondary form — a value is already showing and this only
    // changes it; anything else is the row's whole control and reads as a chip.
    var quiet = label === "\u22ef";
    var btn = el("button", "linklike prop-trigger" + (quiet ? " quiet" : ""));
    btn.type = "button";
    btn.textContent = label;
    if (quiet) btn.setAttribute("aria-label", "Change");
    wrap.appendChild(btn);
    var open = null;

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) { open.close(); return; }
      btn.setAttribute("aria-expanded", "true");
      open = openSurface({
        title: opts.title || "Pick a puck",
        anchorWrap: wrap,
        cls: "pick-menu pick-find",
        help: opts.help,
        onClose: function () { open = null; btn.setAttribute("aria-expanded", "false"); },
        build: function (host, api) {
          // The chosen value lives *inside* the field, as a token with its own ✕ —
          // one control shows the state and takes the query. Single-value fields
          // (parent) carry one token, multi-value ones (blockers) carry several.
          var box = el("div", "tokenbox");
          var search = el("input", "fp-search token-input");
          search.type = "text";
          search.placeholder = opts.placeholder || "Find a puck\u2026";
          search.autocomplete = "off"; search.spellcheck = false;
          host.appendChild(box);
          var list = el("div", "pick-list");
          host.appendChild(list);

          function paintBox() {
            box.innerHTML = "";
            (opts.tokens ? opts.tokens() : []).forEach(function (t) {
              var tok = el("span", "token");
              var dot = el("span", "repo-dot");
              dot.style.background = t.color || "var(--ink-3)";
              tok.appendChild(dot);
              tok.appendChild(el("span", "token-label", t.label));
              var x = el("button", "token-x");
              x.appendChild(icon("x", "x-icn"));
              x.type = "button";
              x.setAttribute("aria-label", "Remove " + t.label);
              x.addEventListener("click", function () { api.close(); t.onRemove(); });
              tok.appendChild(x);
              box.appendChild(tok);
            });
            box.appendChild(search);
          }
          paintBox();

          // Same repo first \u2014 that's where a link usually points \u2014 then the rest,
          // freshest first. An A\u2013Z dump of 138 pucks helps nobody.
          // Adapted pucks are pickable: the harvester resolves references against
          // every item on the board, so a native puck may perfectly well depend on
          // one. What can't be *written to* is a different question from what can
          // be pointed at — `exclude` is where impossible choices belong.
          var pool = DATA.items.filter(function (it) { return !opts.exclude(it); });
          pool.sort(function (a, b) {
            var ar = a.repo === opts.repo ? 0 : 1, br = b.repo === opts.repo ? 0 : 1;
            return ar - br || (b.updated || "").localeCompare(a.updated || "") ||
              a.title.localeCompare(b.title);
          });

          var CAP = 40;
          function paint() {
            list.innerHTML = "";
            var q = lower(search.value.trim());
            var hits = pool.filter(function (it) {
              return !q || lower(it.title).indexOf(q) !== -1 || it.slug.indexOf(q) !== -1 ||
                lower(it.repoName).indexOf(q) !== -1;
            });
            hits.slice(0, CAP).forEach(function (it) {
              var mi = el("button", "row pick-mi" + (it.id === opts.current ? " on" : ""));
              mi.type = "button";
              var dot = el("span", "repo-dot");
              dot.style.background = it.repoColor;
              mi.appendChild(dot);
              mi.appendChild(el("span", "pick-title", it.title));
              // The repo is worth naming only when it isn't the one we're writing in.
              if (it.repo !== opts.repo) mi.appendChild(el("span", "pick-repo", it.repoName));
              if (it.id === opts.current) mi.appendChild(icon("check", "pick-check"));
              mi.addEventListener("click", function () { api.close(); opts.onPick(it); });
              list.appendChild(mi);
            });
            // Search-and-create, the same shape the labels box uses — but a puck is a
            // file in a repo, and that is what both guards below are about.
            //
            // The duplicate is measured **where the file would land**, and by two
            // rules, because there are two ways to be in the way. The *slug* is what
            // `createPuck` refuses on — an id is `<repo>/<slug>` — so offering a row
            // whose commit is rejected on arrival would be a lie. The *title* is what
            // the reader would be confused by: a second "Auth" beside the "Auth"
            // listed right above it. Neither implies the other. The fixture has both
            // ends of that: a puck titled "A parent" whose slug is `a-parent`, which a
            // slug test alone would happily duplicate by title.
            //
            // Both are scoped to the destination repo. A puck called "Auth" in another
            // repo neither collides nor confuses — it is a different project's Auth,
            // and the cross-repo pool this picker offers is full of them.
            //
            // And the row is offered only where the write could land: `canAddMember`
            // deliberately opens the picker when a *foreign* child can be added to an
            // parent in a read-only repo, but creating always writes to this one — so
            // without the second guard the row would promise a commit that is rejected
            // on arrival.
            var writable = opts.create && canCreateIn(opts.create.repo || opts.repo);
            var typed = search.value.trim();
            var dest = opts.create && opts.create.repo || opts.repo;
            var taken = typed && DATA.items.some(function (it) {
              return it.repo === dest && (it.slug === slugify(typed) || lower(it.title) === lower(typed));
            });
            if (writable && q && !taken) {
              var mk = el("button", "row pick-mi pick-create");
              mk.type = "button";
              mk.appendChild(icon("plus", "pick-createmark"));
              mk.appendChild(el("span", "pick-title", "New " + opts.create.noun + " \u201c" + typed + "\u201d"));
              mk.appendChild(el("span", "pick-repo", "in " + repoNameOf(dest)));
              mk.addEventListener("click", function () { api.close(); opts.create.run(typed); });
              list.appendChild(mk);
            }
            if (!hits.length && !(writable && q && !taken)) {
              list.appendChild(el("div", "fp-empty", q ? "No puck matches" : "Nothing to pick"));
            }
            if (hits.length > CAP) list.appendChild(el("div", "fp-empty", "\u2026and " + (hits.length - CAP) + " more \u2014 keep typing"));
          }
          search.addEventListener("input", paint);
          paint();
          // Not on a phone: here the *list* is the content, and raising the keyboard
          // on open buries the choices behind it. Same guard the label picker uses.
          if (!isPhone()) search.focus();
        },
      });
    });
    return wrap;
  }

  // The last thing `window.prompt` was still doing: ask for one value. Same shell as
  // every other surface, so a phone gets a sheet instead of an OS dialog.
  //   opts: { title, value, placeholder, hint, action, help, onSave(text) }
  function inputSurface(anchorWrap, opts) {
    return openSurface({
      title: opts.title,
      anchorWrap: anchorWrap,
      // A caller that anchors at the right edge of its row has to say so — see
      // `.pop.menu-right`, which is the mirror that keeps the menu on-page.
      cls: "inputpop" + (opts.cls ? " " + opts.cls : ""),
      help: opts.help,
      onClose: opts.onClose,
      build: function (host, api) {
        var field = el("input", "fp-search");
        field.type = "text";
        field.value = opts.value || "";
        field.placeholder = opts.placeholder || "";
        field.autocomplete = "off"; field.spellcheck = false;
        host.appendChild(field);
        if (opts.hint) host.appendChild(el("div", "fp-empty", opts.hint));
        var row = el("div", "date-foot");
        var save = el("button", "date-act", opts.action || "Save");
        save.type = "button";
        function done() { var v = field.value; api.close(); opts.onSave(v); }
        save.addEventListener("click", done);
        field.addEventListener("keydown", function (e) { if (e.key === "Enter") done(); });
        row.appendChild(save);
        // A second action belongs *in* the surface, not beside the trigger: two
        // shapes in one row made the rarer action the loudest thing in the block.
        if (opts.alt) {
          var alt = el("button", "row pick-mi alt-act", opts.alt.label);
          alt.type = "button";
          alt.addEventListener("click", function () { api.close(); opts.alt.run(); });
          host.appendChild(alt);
        }
        host.appendChild(row);
        // Not on a phone either, though here the field *is* the content and there is
        // no list to bury: a sheet that opens with the keyboard already up is the
        // thing that felt wrong, whichever surface does it. One rule beats an
        // exception that has to be justified every time someone reads it.
        if (!isPhone()) { field.focus(); field.select(); }
      },
    });
  }

  // Pull the issue number out of "42", "#42", or a full issue URL.
  //
  // The `/issues/N` segment is matched first because a link copied from a comment
  // thread carries a fragment — `.../issues/12#issuecomment-345` — and reading the
  // *trailing* digits took the comment id. That wrote `issue: 345` into the puck, and
  // the harvester then reconciled a stranger's state onto your card with nothing
  // looking wrong. A `?query` did the same. The bare-number form is anchored, so a
  // string that is neither is rejected rather than half-read.
  function parseIssue(s) {
    s = String(s).trim();
    var m = s.match(/\/issues\/(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^#?(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  }
  // The Issue property cell: a link (+ open/closed state) when set, "Link issue"
  // when editable and empty, "—" otherwise. Edit uses a prompt (number or URL).
  function issueValue(item, editable) {
    // Positioned, because inputSurface anchors an absolute popover inside it —
    // without this the nearest containing block is the main column and the editor
    // opens below the whole page instead of beside the control.
    var wrap = el("span", "issue-cell prop-pick");
    // One editor per cell. The trigger sits inside the anchor wrapper, so clicking
    // it no longer counts as an outside click — without a handle to close, a second
    // click would stack a second editor on top of the first.
    var openEditor = null;
    function toggleIssueEditor() {
      if (openEditor) { openEditor.close(); return; }
      openEditor = promptIssue(wrap, item, function () { openEditor = null; });
    }
    if (item.issue) {
      var a = el("a", "issue-link", "#" + item.issue);
      a.href = "https://github.com/" + item.repo + "/issues/" + item.issue;
      a.target = "_blank"; a.rel = "noopener";
      wrap.appendChild(a);
      if (item.issueState) wrap.appendChild(el("span", "issue-state issue-" + item.issueState, item.issueState));
      if (editable) {
        var ed = el("button", "linklike issue-editbtn", "Edit"); ed.type = "button";
        ed.addEventListener("click", toggleIssueEditor);
        wrap.appendChild(ed);
      }
    } else if (editable) {
      var link = el("button", "linklike", "Link issue"); link.type = "button";
      link.addEventListener("click", toggleIssueEditor);
      wrap.appendChild(link);
    } else {
      wrap.appendChild(el("span", "prop-muted", "—"));
    }
    return wrap;
  }
  function promptIssue(wrap, item, onClose) {
    return inputSurface(wrap, {
      title: "Issue",
      onClose: onClose,
      // "New issue" used to sit next to the trigger as a second, differently
      // shaped control. It is the rarer action, so it lives one level in.
      alt: canWrite(item) && !item.issue
        ? { label: "\u002b  New issue in " + item.repoName, run: function () { newIssue(item); } }
        : null,
      value: item.issue ? String(item.issue) : "",
      placeholder: "42 or a full issue URL",
      hint: "The working issue in " + item.repoName + ". Leave blank to unlink.",
      action: item.issue ? "Save" : "Link",
      onSave: function (val) {
        val = String(val).trim();
        if (val === "") { if (item.issue) changeIssue(item, null); return; }
        var n = parseIssue(val);
        if (!n) { toast("\u2717 Use an issue number or URL", true); return; }
        changeIssue(item, n);
      },
    });
  }

  // The Labels cell: the tags as pills, plus the picker when writable.
  function labelsValue(item, editable) {
    var wrap = el("div", "card-tags");
    item.tags.forEach(function (t) { wrap.appendChild(el("span", "tagpill", "#" + t)); });
    if (!item.native) wrap.appendChild(el("span", "adapted-badge", "adapted"));
    if (editable && item.native) {
      wrap.appendChild(labelPicker(item, item.tags.length ? "Edit" : "Add labels"));
    }
    return wrap;
  }

  // Labels are the one field on a puck whose value set is genuinely OPEN — a tag is
  // whatever someone wrote — so this is where "create" belongs. The counterpart of
  // the rule that status and priority get no such row: an invented label survives
  // the harvest, an invented status does not.
  //
  // Multi-select, so the surface stays open while you toggle; the field carries the
  // chosen labels as tokens and doubles as the search box.
  function labelPicker(item, label) {
    var wrap = el("div", "prop-pick");
    var btn = el("button", "linklike issue-editbtn", label);
    btn.type = "button";
    wrap.appendChild(btn);
    var open = null;

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) { open.close(); return; }
      // Multi-select, so the write waits for the close: toggling committed on every
      // tap would be three commits for three labels — and each one re-rendered the
      // detail pane, which tore the surface out of the DOM mid-edit.
      var was = (item.tags || []).slice();
      var chosen = was.slice();
      open = openSurface({
        title: "Labels",
        anchorWrap: wrap,
        cls: "pick-menu pick-find",
        help: "https://github.com/tor2dbear/roadmap/blob/main/CONVENTION.md#frontmatter-the-interface",
        onClose: function () {
          open = null;
          if (chosen.join(",") === was.join(",")) return;
          // Save after the dispatch that closed us finishes. Closing often happens
          // from a click on another control, and changeTags() re-renders the detail
          // pane synchronously — that click would then land on a detached node and
          // appear to do nothing.
          setTimeout(function () { changeTags(item, chosen.slice()); }, 0);
        },
        build: function (host) {
          // The field holds the chosen labels as tokens and the query at once.
          var box = el("div", "tokenbox");
          var search = el("input", "fp-search token-input");
          search.type = "text";
          search.placeholder = "Filter or add a label\u2026";
          search.autocomplete = "off"; search.spellcheck = false;
          host.appendChild(box);
          var list = el("div", "pick-list");
          host.appendChild(list);

          function known() {
            var n = {};
            DATA.items.forEach(function (it) { (it.tags || []).forEach(function (t) { n[t] = (n[t] || 0) + 1; }); });
            return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); });
          }
          function toggle(t) {
            var i = chosen.indexOf(t);
            if (i >= 0) chosen.splice(i, 1); else chosen.push(t);
            search.value = "";
            paintBox(); paintList();
            if (!isPhone()) search.focus(); // desktop keeps typing; a phone would
          }                                 // raise the keyboard over the list
          function paintBox() {
            box.innerHTML = "";
            chosen.forEach(function (t) {
              var tok = el("span", "token");
              tok.appendChild(el("span", null, "#" + t));
              var x = el("button", "token-x");
              x.appendChild(icon("x", "x-icn"));
              x.type = "button";
              x.setAttribute("aria-label", "Remove label " + t);
              x.addEventListener("click", function () { toggle(t); });
              tok.appendChild(x);
              box.appendChild(tok);
            });
            box.appendChild(search);
          }
          function paintList() {
            list.innerHTML = "";
            var q = slugChars(search.value.trim()); // empty query stays empty — see slugify
            var hits = known().filter(function (t) { return !q || t.indexOf(q) !== -1; });
            // Create sits first when what you typed isn't a label yet — the same
            // shape the reference apps use, allowed here because the set is open.
            if (q && known().indexOf(q) === -1) {
              var add = el("button", "row pick-mi pick-new");
              add.type = "button";
              add.appendChild(el("span", "prop-muted", "Create"));
              add.appendChild(el("span", "tagpill", "#" + q));
              add.addEventListener("click", function () { toggle(q); });
              list.appendChild(add);
            }
            hits.forEach(function (t) {
              var on = chosen.indexOf(t) !== -1;
              var mi = el("button", "row pick-mi" + (on ? " on" : ""));
              mi.type = "button";
              mi.appendChild(el("span", "tagpill", "#" + t));
              if (on) mi.appendChild(icon("check", "pick-check"));
              mi.addEventListener("click", function () { toggle(t); });
              list.appendChild(mi);
            });
            if (!hits.length && !q) list.appendChild(el("div", "fp-empty", "No labels yet"));
          }
          search.addEventListener("input", paintList);
          search.addEventListener("keydown", function (e2) {
            if (e2.key === "Enter") {
              var q = slugChars(search.value.trim());
              if (q) { e2.preventDefault(); toggle(q); }
            } else if (e2.key === "Backspace" && !search.value && chosen.length) {
              toggle(chosen[chosen.length - 1]); // backspace eats the last token
            }
          });
          paintBox(); paintList();
          if (!isPhone()) search.focus();
        },
      });
    });
    return wrap;
  }

  // The puck's own ⋯ menu, at the right end of the tab strip. What lives here is
  // everything you do *to the file* rather than to the fields: open it on GitHub,
  // copy a link to it, delete it. They used to sit in a link row under the body —
  // which put a destructive action at the end of a scroll, told apart from two
  // navigation links by colour alone. In a menu the delete is one deliberate step
  // away and can carry a rule above it; the rail keeps every value edit.
  function puckMenu(item) {
    var wrap = el("div", "prop-pick puck-more");
    var btn = el("button", "btn btn--icon");
    btn.type = "button";
    btn.title = "More actions";
    btn.setAttribute("aria-label", "More actions");
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(icon("more"));
    var open = null;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) { open.close(); return; }
      btn.setAttribute("aria-expanded", "true");
      open = openSurface({
        title: "Actions",
        anchorWrap: wrap,
        cls: "pick-menu menu-right",
        onClose: function () { open = null; btn.setAttribute("aria-expanded", "false"); },
        build: function (host, api) {
          var src = el("a", "row");
          src.href = item.sourceUrl; src.target = "_blank"; src.rel = "noopener";
          src.appendChild(icon("external"));
          src.appendChild(el("span", null, "Open source"));
          src.addEventListener("click", function () { api.close(); });
          host.appendChild(src);

          var copy = el("button", "row");
          copy.type = "button";
          copy.appendChild(icon("share"));
          var copyLabel = el("span", null, "Copy link");
          copy.appendChild(copyLabel);
          copy.addEventListener("click", function () {
            copyText(location.origin + location.pathname + "#" + item.id, function () {
              copyLabel.textContent = "Copied";
              setTimeout(api.close, 700);
            });
          });
          host.appendChild(copy);

          // Same gate as every other write in the rail (`editable`): signed in,
          // native, and not known read-only. The old link row skipped the token
          // check, so a signed-out reader was offered a Delete that could only
          // fail — canWrite() alone means "not known to be read-only", not "may".
          if (ghToken() && item.native && canWrite(item)) {
            host.appendChild(el("div", "menu-rule"));
            var del = el("button", "row danger");
            del.type = "button";
            del.appendChild(icon("trash"));
            del.appendChild(el("span", null, "Delete puck"));
            del.addEventListener("click", function () { api.close(); confirmDeletePuck(item); });
            host.appendChild(del);
          }
        },
      });
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // Build the full puck detail into `container` — shared by both surfaces.
  // Structure: breadcrumb → title → tab strip (+ ⋯ menu) → properties rail → body.
  function fillDetail(container, item) {
    container.innerHTML = "";
    container.style.setProperty("--repo", item.repoColor);

    var crumb = el("div", "detail-crumb");
    var home = el("button", "crumb-home");
    home.appendChild(icon("chev-left"));
    home.appendChild(el("span", null, currentViewTitle()));
    home.type = "button";
    home.title = "Back to the board";
    home.addEventListener("click", function () { closeModal(); });
    crumb.appendChild(home);
    // The parent sits in the path, not only in a field far down the rail: a
    // breadcrumb is where a reader learns the shape of things, and it puts the
    // level above one tap away instead of a scroll.
    var up = parentItem(item);
    if (up) {
      crumb.appendChild(sep());
      var upLink = el("button", "crumb-back", up.title);
      upLink.type = "button";
      upLink.title = "Parent: " + up.title;
      upLink.addEventListener("click", function () { openModal(up); });
      crumb.appendChild(upLink);
    }
    crumb.appendChild(sep());
    crumb.appendChild(el("span", "crumb-cur", item.repoName + " · " + item.slug));
    container.appendChild(crumb);

    // Puck glyph — Parent's answer to Linear's project icon, tinted with the repo
    // (project) colour. The single colour marker on the page, and it makes the same
    // parent/member distinction the cards do.
    var pic = el("div", "detail-icon");
    pic.style.color = item.repoColor;
    pic.appendChild(icon((item.children || []).length ? "parent" : "commit"));
    container.appendChild(pic);

    container.appendChild(el("h2", "modal-title", item.title));

    // ── tabs: Overview (the puck) · Activity (git history) · Discussion (linked
    //    issue). Native pucks only; Discussion only when an issue is linked. Both
    //    extra tabs are backed by GitHub primitives — no second store. ──
    var overview = el("div", "tab-panel");
    var extraTabs = [];
    if (item.native) {
      extraTabs.push({ key: "activity", label: "Activity", load: loadActivity });
      if (item.issue) extraTabs.push({ key: "discussion", label: "Discussion", load: loadDiscussion });
    }
    // The strip under the title carries the tabs on the left and the ⋯ menu on the
    // right. It is drawn even when there is only one face to show (an adapted
    // source has no Activity or Discussion): the menu has to live somewhere, and
    // the rule is what separates the heading from the page's content either way.
    var strip = el("div", "detail-tabs");
    var tabList = el("div", "tab-list");
    strip.appendChild(tabList);
    strip.appendChild(puckMenu(item));
    container.appendChild(strip);

    if (extraTabs.length) {
      var defs = [{ key: "overview", label: "Overview", panel: overview }].concat(
        extraTabs.map(function (t) { t.panel = el("div", "tab-panel"); t.panel.hidden = true; return t; }));
      tabList.setAttribute("role", "tablist");
      var tabBtns = {};
      var loadedSet = {};
      var pick = function (name) {
        defs.forEach(function (d) {
          d.panel.hidden = d.key !== name;
          tabBtns[d.key].classList.toggle("on", d.key === name);
          tabBtns[d.key].setAttribute("aria-selected", d.key === name ? "true" : "false");
        });
        var def = defs.filter(function (d) { return d.key === name; })[0];
        if (def && def.load && !loadedSet[name]) { loadedSet[name] = true; def.load(item, def.panel); }
      };
      defs.forEach(function (d) {
        var b = el("button", "tab-btn" + (d.key === "overview" ? " on" : ""), d.label);
        b.type = "button"; b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", d.key === "overview" ? "true" : "false");
        b.addEventListener("click", function () { pick(d.key); });
        tabBtns[d.key] = b;
        tabList.appendChild(b);
      });
      defs.forEach(function (d) { container.appendChild(d.panel); });
    } else {
      container.appendChild(overview);
    }

    // ── Overview: properties rail, in sections ──
    // Thirteen rows with a hairline between every one gave each the same weight,
    // so nothing was scannable. The groups are the model's own joints: the three
    // orthogonal axes first (when in the queue · when in the calendar · how much it
    // matters), then routing, then the references, then the one open value set.
    // A group draws no rules inside itself — the heading does that work.
    var groups = [];
    function group(label) { var g = { label: label, rows: [] }; groups.push(g); return g; }
    var gAxes = group(null), gPeople = group("People"),
        gRel = group("Relations"), gLabels = group("Labels");
    // A heading over one row weighs more than it separates: with no assignee,
    // "People" is a title for `Agent` alone. Then it joins the block above instead.
    gPeople.mergeIfAlone = true;
    var props = gAxes; // rows are pushed into a group; see the render at the end

    var editable = ghToken() && item.native && canWrite(item);
    // Signed in, native, but no write access to this repo → say so (once checked).
    if (ghToken() && item.native && !editable && writableRepos !== null) {
      overview.appendChild(el("div", "detail-note", "Read-only — your token has no write access to " + item.repoName + "."));
    }

    // Repo: where the file lives, and the first thing the rail should answer — a puck
    // page that says everything about a puck except which repo it comes from is missing
    // the fact the whole product is built on. It stood in the in-content breadcrumb
    // (`Etapp · gui-hantverk`) until `body.viewing-puck` hid that in favour of the
    // topbar's, which carries the view and the title and dropped the repo. The
    // information did not move; it was lost in the swap.
    //
    // Not a picker, and it never will be: moving a puck between repos is a git move, not
    // a field. Not dead either — the name goes to that repo's pucks through `goToPlace`,
    // the same one writer the sidebar's chip uses, so there is one answer to "show me
    // this repo" and not two.
    gAxes.rows.push(propRow("Repo", repoValue(item)));

    // Status: current value as a chip; click to pick (editable) — Linear-style.
    gAxes.rows.push(propRow("Status", propPicker({
      title: "Status", // the sheet is a dialog; an unnamed one tells a screen reader nothing
      editable: editable,
      current: item.status,
      options: statusOptions(),
      valueNode: function (o) { return el("span", "status-pill status-" + o.value, o.label); },
      onPick: function (v) { changeStatus(item, v); },
    })));

    // Priority: same pattern. Shown when editable or when the puck has one set.
    if (editable || item.priority) {
      gAxes.rows.push(propRow("Priority", propPicker({
        title: "Priority", // the sheet is a dialog; an unnamed one tells a screen reader nothing
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

    // Target: the horizon. Shown when editable or when the puck declares one —
    // most pucks won't, and an empty row on every card would be noise.
    if (editable || item.target) {
      gAxes.rows.push(propRow("Target", targetValue(item, editable)));
    }

    // No editor for this field (owner is a frontmatter line, not a picker), so an
    // empty row could only ever say "—". Show it when there is someone to show.
    if (item.owner) gPeople.rows.push(propRow("Assignee", ownerEl(item.owner, { name: true, link: true })));

    // Agent: the PO-layer routing row — hand this puck to a discipline as easily
    // as a status flip. Shown when editable or already routed.
    if (editable || item.agent) {
      gPeople.rows.push(propRow("Agent", propPicker({
        title: "Agent", // the sheet is a dialog; an unnamed one tells a screen reader nothing
        editable: editable,
        current: item.agent || null,
        placeholder: "Unassigned",
        options: [{ value: null, label: "Unassigned" }].concat(
          agentOptions().map(function (a) { return { value: a, label: agentLabel(a) }; })),
        valueNode: function (o) {
          if (!o.value) return el("span", "prop-muted", "Unassigned");
          var v = el("span", "agent-inline");
          v.appendChild(agentBadge(o.value));
          return v;
        },
        onPick: function (v) { changeAgent(item, v); },
      })));
    }

    // Issue: link/unlink a GitHub issue (writes the `issue:` frontmatter line).
    // Thin-via-GitHub — the discussion is the issue; this is just a pointer field.
    if (editable || item.issue) {
      gRel.rows.push(propRow("Issue", issueValue(item, editable)));
    }

    if (editable || item.tags.length || !item.native) {
      gLabels.rows.push(propRow("Labels", labelsValue(item, editable), "keyless"));
    }

    // Parent: the level above. One pointer up, so the row is a link + an edit —
    // there is no epic record to open, just another puck.
    if (editable || item.parentRef || item.parent) {
      // "Parent" up and "Pucks" down were two unrelated nouns for the two ends of one
      // edge — a type name and a generic plural — so the row read as its own field
      // rather than as the other half of the pair below. One verb, two directions,
      // the way Blocked by / Blocks already reads. The word "parent" stays where it
      // belongs: on the *value*, and in the board's Parent grouping.
      gRel.rows.push(propRow("Part of", parentValue(item, editable), null, "parent"));
    }

    // …and the level below. With members it becomes a section of its own further
    // down (a comma-separated line works for two pucks and collapses at eight);
    // without them the rail keeps one quiet control, so a parent can be *started*
    // from the parent side instead of only from each child.
    if (!(item.children || []).length && canAddMember(item)) {
      gRel.rows.push(propRow("Contains", addPuckPicker(item), "blocked", "pucks"));
    }

    // Blocked by: the authored `depends` list, editable. It shows landed blockers
    // too (struck through) — `blockedBy` hides them, and you can't remove a
    // dependency the board never showed you.
    if (editable || (item.depends || []).length) {
      gRel.rows.push(propRow("Blocked by", dependsValue(item, editable), "blocked"));
    }

    // …and the other direction, derived: what this puck is holding up.
    if ((item.blocks || []).length) {
      var blocksV = el("div", "prop-blockers");
      blockedItems(item).forEach(function (b, i, arr) {
        var a = el("a", "blocker-link" + (TERMINAL[b.status] ? " done" : ""), b.title);
        a.href = "#" + b.id;
        a.addEventListener("click", function (e) { e.preventDefault(); openModal(b); });
        blocksV.appendChild(a);
        if (i < arr.length - 1) blocksV.appendChild(document.createTextNode(", "));
      });
      gRel.rows.push(propRow("Blocks", blocksV, "blocked"));
    }

    var lastBox = null;
    groups.forEach(function (g) {
      if (!g.rows.length) return;
      if (g.mergeIfAlone && g.rows.length < 2 && lastBox) {
        g.rows.forEach(function (r) { lastBox.appendChild(r); });
        return;
      }
      if (g.label) overview.appendChild(el("div", "sect-label", g.label));
      var box = el("div", "props");
      g.rows.forEach(function (r) { box.appendChild(r); });
      overview.appendChild(box);
      lastBox = box;
    });

    // ── Contains: the parent's members, as rows ──
    // The page where you *run* a parent, not just read that it has one. Direct
    // members only — a sub-parent shows its own count and answers for its subtree,
    // which is what makes the number compose at any depth.
    if ((item.children || []).length) {
      var head = el("div", "sect-label sect-with-badge");
      head.appendChild(document.createTextNode("Contains"));
      if (item.progress) head.appendChild(progressBadge(item));
      overview.appendChild(head);
      var members = el("div", "members");
      childItems(item).forEach(function (k) { members.appendChild(memberRow(k)); });
      // Not `editable`: that asks whether *this* puck's file is writable, and adding
      // a member writes the **child's** `parent:` line. A token that owns another
      // source repo can add from it to a parent it could never edit itself.
      if (canAddMember(item)) members.appendChild(addPuckPicker(item));
      overview.appendChild(members);
    }

    // Created/Updated are derived and never edited, and Activity is the same fact
    // with more detail. A footnote rather than two rows — kept at all because
    // Activity can fail (private repo, rate limit) and `updated` drives the stale
    // flag, so it should not take a round trip to see.

    var sig = signalMessages(item);
    if (sig.length) {
      var flags = el("div", "card-flags");
      sig.forEach(function (m) {
        var f = el("div", "flag");
        f.appendChild(icon("warn"));
        f.appendChild(el("span", null, m));
        flags.appendChild(f);
      });
      overview.appendChild(flags);
    }

    overview.appendChild(el("div", "sect-label", "Details"));
    var body = el("div", "modal-body");
    body.innerHTML = renderMd(item.body || "(no details)");
    overview.appendChild(body);

    if (ghToken() && item.native) {
      var editBtn = el("button", "linklike body-edit", "Edit body");
      editBtn.insertBefore(icon("edit", "inline"), editBtn.firstChild);
      editBtn.type = "button";
      editBtn.addEventListener("click", function () { startBodyEdit(item, body, editBtn); });
      overview.appendChild(editBtn);
    }

    // Source, Copy link and Delete used to be a link row here. They act on the
    // file rather than on this page's content, so they live in the ⋯ menu at the
    // top now — and the issue they also linked is already a link in the rail.

    // Created/Updated: metadata about the file, so it rests at the foot of the tab.
    // Between the rail and the Details heading it sat in the same muted mono voice
    // as that heading, and the two blurred into one grey block.
    var meta = [];
    if (item.created) meta.push("Created " + item.created);
    if (item.updated) meta.push("Updated " + item.updated);
    if (meta.length) overview.appendChild(el("div", "prop-foot", meta.join("  \u00b7  ")));
  }

  // Activity tab: the git history of this puck's file, read live from GitHub's
  // commits API (no second store — the markdown file's history IS the log). Lazy:
  // fetched only when the tab is first opened. Native pucks only.
  // Relative "time ago" from an ISO date — now / 3m / 2h / 5d / 3w, then a date.
  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 45) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    if (s < 7 * 86400) return Math.round(s / 86400) + "d";
    if (s < 30 * 86400) return Math.round(s / (7 * 86400)) + "w";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Type a commit from its subject line. Our GUI/CLI writes structured subjects
  // ("roadmap: <slug> → now", "… priority high", "… → agent backend", "… edit
  // body", "roadmap: add <slug>"), so the history already carries typed events —
  // we classify them here without a second source of truth. Anything else (a
  // hand-written commit) falls back to a generic commit row.
  function classifyCommit(subject, slug) {
    var s = (subject || "").trim();
    // strip a leading "roadmap: <slug> " so the rest reads as the change
    var rest = s.replace(/^roadmap:\s*/i, "");
    var m;
    if ((m = rest.match(/^add\s+/i)) || /^new\s+/i.test(rest)) {
      return { icon: "plus", text: "created this puck" };
    }
    if ((m = rest.match(/(?:^|\s)(?:→|->)\s*(now|next|later|inbox|done|cancelled)\s*$/i))) {
      var st = m[1].toLowerCase();
      var badge = statusPill(st);
      return { badge: badge, text: "moved to" };
    }
    if ((m = rest.match(/priority\s+(urgent|high|medium|low|cleared)\s*$/i))) {
      var lv = m[1].toLowerCase();
      if (lv === "cleared") return { icon: "commit", text: "cleared priority" };
      return { badge: priorityBadge(lv), text: "set priority" };
    }
    if ((m = rest.match(/(?:→|->)\s*agent\s+(.+?)\s*$/i))) {
      var ag = m[1].toLowerCase();
      if (ag === "unassigned") return { icon: "merge", text: "unrouted from agent" };
      return { icon: "merge", text: "routed → " + agentLabel(ag) };
    }
    if (/edit\s+body\s*$/i.test(rest)) {
      return { icon: "edit", text: "edited the body" };
    }
    return { icon: "commit", text: rest || s || "commit" };
  }

  function loadActivity(item, panel) {
    panel.innerHTML = "";
    panel.appendChild(el("div", "activity-loading", "Loading history…"));
    var branch = branchOf(item);
    var url = "https://api.github.com/repos/" + item.repo + "/commits?path=" +
      encodeURIComponent(item.sourcePath) + "&sha=" + encodeURIComponent(branch) + "&per_page=30";
    var headers = { Accept: "application/vnd.github+json" };
    var tok = ghToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    fetch(url, { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("History unavailable (" + r.status + ")"); return r.json(); })
      .then(function (commits) {
        panel.innerHTML = "";
        if (!commits.length) { panel.appendChild(el("div", "activity-empty", "No history for this puck yet.")); return; }
        var list = el("ol", "activity-list");
        commits.forEach(function (c) {
          var li = el("li", "activity-item");
          var subject = ((c.commit && c.commit.message) || "").split("\n")[0];
          var kind = classifyCommit(subject, item.slug);
          var when = (c.commit && c.commit.author && c.commit.author.date) || "";
          var login = (c.author && c.author.login) || "";
          var name = (c.commit && c.commit.author && c.commit.author.name) || login || "unknown";

          // gutter: the author's avatar (falls back to a typed glyph / dot)
          var gutter = el("span", "activity-gutter");
          if (c.author && c.author.avatar_url) {
            var img = el("img", "activity-avatar");
            img.src = c.author.avatar_url + "&s=48"; img.alt = ""; img.loading = "lazy";
            gutter.appendChild(img);
          } else if (kind.icon) {
            gutter.appendChild(icon(kind.icon, "activity-glyph"));
          } else {
            gutter.appendChild(el("span", "activity-dot"));
          }
          li.appendChild(gutter);

          var bodyEl = el("div", "activity-body");
          var line = el("div", "activity-line");
          // small type marker next to the text (glyph or the status/priority badge)
          if (kind.badge) { line.appendChild(kind.badge); }
          else if (kind.icon && c.author && c.author.avatar_url) { line.appendChild(icon(kind.icon, "activity-glyph")); }
          var a = el("a", "activity-msg", kind.text);
          a.href = c.html_url; a.target = "_blank"; a.rel = "noopener";
          line.appendChild(a);
          bodyEl.appendChild(line);
          var who = login ? "@" + login : name;
          bodyEl.appendChild(el("div", "activity-meta", who + " · " + relTime(when)));
          li.appendChild(bodyEl);
          list.appendChild(li);
        });
        panel.appendChild(list);
      })
      .catch(function () {
        panel.innerHTML = "";
        panel.appendChild(el("div", "activity-empty", "Couldn’t load the history here (private repo or rate limit)."));
        var hist = linkEl("View history on GitHub ↗", (item.sourceUrl || "").replace("/blob/", "/commits/"));
        panel.appendChild(hist);
      });
  }

  // Discussion tab: the puck's linked GitHub issue + its comments, read live.
  // Thin-via-GitHub (the convention says discussion = the linked issue) — no
  // second store. Read-only here; composing a comment links out to GitHub. Lazy.
  function loadDiscussion(item, panel) {
    panel.innerHTML = "";
    panel.appendChild(el("div", "activity-loading", "Loading discussion…"));
    var headers = { Accept: "application/vnd.github+json" };
    var tok = ghToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    var base = "https://api.github.com/repos/" + item.repo + "/issues/" + item.issue;
    var issueUrl = "https://github.com/" + item.repo + "/issues/" + item.issue;
    Promise.all([
      fetch(base, { headers: headers }).then(function (r) { if (!r.ok) throw new Error("issue " + r.status); return r.json(); }),
      fetch(base + "/comments?per_page=50", { headers: headers }).then(function (r) { return r.ok ? r.json() : []; }),
    ])
      .then(function (res) {
        var issue = res[0], comments = res[1] || [];
        panel.innerHTML = "";
        var head = el("div", "disc-head");
        var closed = issue.state === "closed";
        head.appendChild(el("span", "disc-state disc-" + (closed ? "closed" : "open"), closed ? "Closed" : "Open"));
        var titleA = el("a", "disc-title", issue.title + " #" + issue.number);
        titleA.href = issue.html_url || issueUrl; titleA.target = "_blank"; titleA.rel = "noopener";
        head.appendChild(titleA);
        panel.appendChild(head);
        if (issue.body && issue.body.trim()) {
          var ib = el("div", "disc-comment");
          ib.appendChild(el("div", "disc-cmeta", (issue.user && issue.user.login ? "@" + issue.user.login : "issue") + " · " + (issue.created_at || "").slice(0, 10)));
          var ibb = el("div", "disc-body"); ibb.innerHTML = renderMd(issue.body); ib.appendChild(ibb);
          panel.appendChild(ib);
        }
        comments.forEach(function (c) {
          var cm = el("div", "disc-comment");
          cm.appendChild(el("div", "disc-cmeta", (c.user && c.user.login ? "@" + c.user.login : "unknown") + " · " + (c.created_at || "").slice(0, 10)));
          var cb = el("div", "disc-body"); cb.innerHTML = renderMd(c.body || ""); cm.appendChild(cb);
          panel.appendChild(cm);
        });
        if (!comments.length) panel.appendChild(el("div", "activity-empty", "No comments yet."));
        var foot = el("div", "card-links");
        foot.appendChild(linkEl("Comment on GitHub ↗", issueUrl));
        panel.appendChild(foot);
      })
      .catch(function () {
        panel.innerHTML = "";
        panel.appendChild(el("div", "activity-empty", "Couldn’t load the discussion here (private repo or rate limit)."));
        panel.appendChild(linkEl("Open issue on GitHub ↗", issueUrl));
      });
  }

  // Router: side pane on desktop, modal on mobile. Both reflect the URL hash.
  function openModal(item) {
    openDetail(item);
    setHash(item.id);
  }
  // A puck opens as a full-width page: the board + view-header hide and the detail
  // fills the content area (same on desktop and mobile). The breadcrumb is "back".
  function openDetail(item) {
    // Claim the pane *before* closing surfaces. A surface's onClose can fire the
    // write it was holding, and that write asks to refresh the puck it belongs to
    // — the one we're navigating away from. Naming the new puck first makes that
    // refresh a no-op instead of a puck popping back over its successor.
    currentDetailItem = item;
    pendingRefresh = null;
    // Navigating from the palette calls this directly — pushState fires neither
    // popstate nor hashchange, so syncHash's cleanup never runs and a sheet would
    // stay up over the puck that replaced its own.
    closeSurfaces();
    paneRefs();
    fillDetail(detailContent, item);
    // Where the board was. Hiding it takes the port's scroll range away, so both
    // offsets clamp to 0 and coming back would land on the top-left of the list —
    // measured 150/250 → 0/0. Captured only on the way *in* from the board: puck →
    // puck keeps the first one, which is the place Back actually returns to.
    // Asked before the class goes on, so the answer is still the board's port — which in
    // the kanban layout is `#board` and not `.work`.
    var from = document.body.classList.contains("viewing-puck") ? null : scrollPort();
    if (from) {
      // `el`: *which box* the offsets were read from, not merely how much. The layout can
      // change while the puck is open — ⌘K still offers `Layout: list/board`, and
      // `setDisplay` does not close the puck — so `scrollPort()` can answer with a different
      // box on the way out than it did on the way in, and the kanban port's `scrollLeft`
      // would be written straight into the list's `.work`. Measured at 700px: the port
      // read at 200, switched to the list behind the puck, and closing left `.work` at
      // **178** — its whole horizontal range, a list opened fully shifted sideways. Codex
      // found it (#54). Same shape and same cure as `lockedEl` in `lockScroll`, which this
      // file already chose for the identical problem: remember the box, not the question.
      boardAt = { el: from, x: from.scrollLeft, y: from.scrollTop, group: boardEl && boardEl.dataset.group, cols: {} };
      // The columns' places too, and *here* rather than at the next render: a hidden
      // scroller reports `scrollTop` as 0 (Chromium remembers it and gives it back when the
      // box is shown, but only for a box that survives). A redraw behind an open puck —
      // `loadWritableRepos` resolving — reads 0 from every column, replaces the nodes, and
      // the place is gone with nothing to put back. Measured: 180 → 0. Codex, #54.
      if (boardEl) Array.prototype.forEach.call(boardEl.querySelectorAll(".cards[data-col]"), function (k) {
        if (k.scrollTop) boardAt.cols[k.dataset.col] = k.scrollTop;
      });
    }
    detailPane.hidden = false;
    document.body.classList.add("viewing-puck");
    // The scrollport is a labelled region (it is the only thing that scrolls, so it is
    // also a tab stop), and what it holds has just changed from the board to one puck —
    // which in the kanban layout also changes *which box* it is.
    markPort();
    // The mobile topbar becomes the puck's context (Linear-style): Pucks › Title,
    // where "Pucks" is the back action and the title truncates.
    var tc = document.getElementById("topCrumb");
    if (tc) {
      tc.innerHTML = "";
      var back = el("button", "crumb-back", currentViewTitle());
      back.type = "button";
      back.addEventListener("click", function () { closeModal(); });
      tc.appendChild(back);
      tc.appendChild(sep());
      tc.appendChild(el("span", "crumb-title", item.title));
    }
    detailContent.scrollTop = 0;
    if (workEl) workEl.scrollTop = 0; // the port, not the page: see lockScroll
    selectedId = item.id;
  }
  function highlightSelected() {
    var nodes = document.querySelectorAll("#board .card, #board .list-row");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle("sel", !!selectedId && nodes[i].getAttribute("data-id") === selectedId);
    }
  }

  function closeModal() {
    if (modalBackdrop) {
      modalBackdrop.hidden = true;
      modalBackdrop.style.top = "";
      document.body.classList.remove("modal-open");
    }
    // Pop the entry this puck pushed, so the URL + history stay in sync and a
    // Forward press re-opens it; popstate then runs closeDetail. When there's no
    // hash (nothing pushed), close directly.
    if (location.hash) history.back();
    else closeDetail();
  }
  // Navigating the sidebar (a view/repo/tag/agent) while a puck is open should
  // return to the board — otherwise the board changes behind the still-open puck.
  // Unlike closeModal (which pops one entry), this normalizes straight to the board:
  // history.back() would only return to the *previous* puck in a board→A→B stack and
  // reopen it over the newly-picked view, so close in place and strip the hash.
  function exitPuckView() {
    if (!document.body.classList.contains("viewing-puck")) return;
    // The place the board was left in belongs to *that* board. This exit is a navigation
    // to a different one — a view, a repo, a tag from the rail — so the offsets are
    // dropped rather than restored: measured, a four-row view opened at `scrollLeft: 150`
    // with its titles off screen because a longer list had been read there.
    boardAt = null;
    closeDetail();
    // And the offset standing in the port right now is the *puck's* — `openDetail` zeroes
    // it on the way in, but the reader may have scrolled the page itself since. Dropping
    // the saved place without dropping the live one just moves the problem: measured, a
    // view picked after reading 300px into a puck opened 186px down its own list.
    // Both boxes, not just the port: `closeDetail` has already run, so the answer is the
    // board's port — while the offset the *puck* was read at is still standing in `.work`.
    // In the list they are the same box and the second write is a no-op.
    [scrollPort(), workEl].forEach(function (n) { if (n) { n.scrollTop = 0; n.scrollLeft = 0; } });
    // And the columns, which is where the same problem moved when they became the board's
    // vertical scrollports. The redraw that follows this navigation would otherwise put the
    // *old* board's places back by key — `now` is `now` in the next view too — and the
    // four-row view measured above would open partway down again, one box further in.
    // Caught by this rule's own check rather than by a report, which is the whole reason
    // the check for it was written the same hour.
    colPlaces = {};
    Array.prototype.forEach.call(document.querySelectorAll(".cards[data-col]"), function (k) {
      k.scrollTop = 0;
    });
    if (location.hash) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
  }
  function closeDetail() {
    paneRefs();
    selectedId = null;
    // Give up the puck *before* closing surfaces, for the same reason openDetail
    // claims the new one first: a surface's onClose can fire the write it held, and
    // that write must not reopen the puck we're in the middle of leaving.
    currentDetailItem = null;
    pendingRefresh = null;
    // Every way out of a puck funnels through here — Back, the breadcrumb, the
    // sidebar, a palette tag. A sheet lives on <body>, so without this it survives
    // the puck it belonged to and can still commit to it.
    closeSurfaces();
    document.body.classList.remove("viewing-puck");
    markPort();
    if (detailPane) detailPane.hidden = true;
    highlightSelected();
    // The board is back and has its scroll range again, so the place it was left in can
    // be. After `highlightSelected`, which is the last thing that touches the rows — and
    // after the class comes off, or the port asked for would still be the puck's.
    var back = boardAt && scrollPort();
    if (back) {
      // **Two questions, and the place goes back only when both answer yes** — because
      // neither implies the other, and each was reported on its own.
      //
      // `el` is the same *box*: the layout can change behind an open puck (⌘K still offers
      // `Layout: list/board`, and `setDisplay` closes no puck), and the kanban port's
      // `scrollLeft` then went into the list's `.work` — measured, 200 read and `.work`
      // opened at 178, its whole range. `.work` and `#port` both outlive every redraw
      // (`renderBoard` replaces the board's children, not its ancestors), so identity is an
      // exact answer where the layout class would only be a proxy for it.
      //
      // The stamp is the same *board*: a grouping change behind the puck keeps the very same
      // `.port`, so identity alone said yes to a board that no longer exists — measured,
      // `all␀␀status` scrolled to 200, switched to `all␀␀repo` from ⌘K, and closing opened a
      // three-column repo board 200px in with 202 of range, Alpha and Beta off screen.
      // Codex found both halves (#54), one after the other.
      //
      // Either way `boardAt` is cleared: that place no longer exists, and keeping it would
      // only defer the same wrong write.
      var sammaBräda = boardAt.group === (boardEl && boardEl.dataset.group);
      if (back === boardAt.el && sammaBräda) {
        back.scrollTop = boardAt.y;
        back.scrollLeft = boardAt.x;
      } else {
        // **Not restoring is not enough — the offset has to be taken away.** Hiding the
        // board empties the port, which clamps it to 0, and *Chromium gives that offset back
        // by itself when the content returns* — the very behaviour `openDetail`'s comment
        // notes one screen up, here working against us. Measured with our restore deleted
        // outright: the port still came back at 200. So the guards above decide whether the
        // place is *ours* to put back; when it is not, the browser's copy is what is left,
        // and zeroing is the only thing that removes it. Same write `exitPuckView` does for
        // a navigation, for the same reason: the place belongs to a board that is gone.
        back.scrollTop = 0;
        back.scrollLeft = 0;
        // Only the box being handed back. Zeroing the *other* one as well — the kanban port
        // left behind when the layout moved — was written first and removed: nothing could
        // fell it. Switching back to kanban gives 200 either way, because Chromium's memory
        // outlives a write made while the box had no range to hold it. And it is right that
        // it does: that is the same board, and the reader did scroll it there. A declaration
        // that cannot apply is not a guard, it is a claim.
      }
      // And each column, from the snapshot taken on the way in. It is written here whether
      // or not the board was redrawn behind the puck: if it was not, the nodes still hold
      // these very numbers and the write is a no-op; if it was, this is the first moment
      // there is a scroll range to write into at all. The same stamp as above — it has
      // always been checked here, for the reason the render-time restore checks it, and the
      // port simply had not been asking the same question yet.
      if (boardEl && boardAt.cols && sammaBräda) {
        Array.prototype.forEach.call(boardEl.querySelectorAll(".cards[data-col]"), function (k) {
          var v = boardAt.cols[k.dataset.col];
          if (v) k.scrollTop = v;
        });
      }
      boardAt = null;
    }
    // The stops, unconditionally — not inside the gate above. A redraw behind the puck
    // took them from every column, and that happened whether or not a place was snapshotted
    // and whether or not the grouping still matches. This is the first moment a column has
    // a layout to be measured in again. See `markStops`.
    markStops(boardEl);
  }

  // A table row — full-width, aligned columns (Name · Priority · Agent · Repo ·
  // Updated), Linear-style. Grid tracks are shared across rows so the columns
  // line up; on mobile the extra columns fold away (see styles.css). Tap → modal.
  // `opts` is the tree's half of the row: `{ depth, fold }`. A row inside the nested
  // list carries its own indent and, when it has parts below it, the caret that folds
  // them — the row *is* the heading of its subtree, so the control belongs on it rather
  // than on a second heading drawn above the same puck.
  //
  // The caret sits in the row's left gutter, not in a grid track of its own: a track
  // would have to exist on every row to keep the columns in register, and then a leaf
  // would reserve space for a control it never gets. The gutter is reserved once, by
  // `.is-tree`, and both rows land in the same place.
  function listRow(item, opts) {
    opts = opts || {};
    var sig = signalMessages(item);
    var r = el("div", "list-row" + (sig.length ? " flagged" : "") + (item.id === selectedId ? " sel" : ""));
    r.setAttribute("data-id", item.id);
    r.style.setProperty("--repo", item.repoColor);
    if (opts.depth) r.style.setProperty("--depth", String(opts.depth));
    r.title = item.repoName;
    r.appendChild(puckGlyph(item));

    // Name: title (truncates) + inline drift/blocked badges.
    var name = el("div", "list-name");
    // The caret lives *in the name cell*, not in the row: the name is the frozen column,
    // and the structure has to stay on screen with the title it describes rather than
    // scrolling off with the metadata. It is absolutely positioned inside the cell's own
    // indent, so its place among the flex children says nothing.
    if (opts.fold) {
      var caret = el("button", "list-fold");
      caret.type = "button";
      caret.setAttribute("aria-expanded", opts.fold === "shut" ? "false" : "true");
      caret.title = (opts.fold === "shut" ? "Expand " : "Collapse ") + item.title;
      caret.appendChild(icon(opts.fold === "shut" ? "chev-right" : "chev-down", "lh-caret"));
      caret.setAttribute("data-fold", item.id);
      caret.addEventListener("click", function (e) { e.stopPropagation(); toggleGroup(item.id, caret); });
      name.appendChild(caret);
    }
    name.appendChild(el("span", "list-title", item.title));
    if (sig.length) name.appendChild(warnBadge(sig)); // never a choice — see PROPS
    PROPS.forEach(function (f) {
      if (f.where === "name" && propOn(f.key) && f.has(item)) name.appendChild(f.make(item));
    });
    r.appendChild(name);

    // One cell per property that is on, in PROPS' order — and the tracks come from the
    // same list (`listTracks`), so a property that is off takes its column with it. An
    // empty cell still holds its track, which is what keeps the rows in register; an
    // absent one must not, or the row would reserve width for a column nobody asked for.
    PROPS.forEach(function (f) {
      if (f.where !== "cell" || !propOn(f.key)) return;
      var cell = el("div", "list-cell " + f.cls);
      if (f.has(item)) cell.appendChild(f.make(item));
      r.appendChild(cell);
    });

    // The dates share one track however many are shown: they are one answer to one
    // question ("when"), and giving each its own would put a column of empty space in
    // every row that happens to have no target.
    //
    // Whether the cell exists is a question about the *view*, never about this puck — the
    // same rule as the cells above, and easy to get wrong here because the emptiness is
    // per-item: skipping the cell for a puck with no date would shift every cell after it
    // one track to the left, so one puck without a target would break the register of the
    // whole list.
    if (dateFields().length) {
      var dt = el("div", "list-cell list-dt");
      dateCells(item, "list-date").forEach(function (d) { dt.appendChild(d); });
      r.appendChild(dt);
    }
    if (propOn("tags")) {
      var tg = el("div", "list-cell list-tags");
      if (PROP_BY_KEY.tags.has(item)) tg.appendChild(PROP_BY_KEY.tags.make(item));
      r.appendChild(tg);
    }

    r.addEventListener("click", function () { openModal(item); });
    return r;
  }

  // ── grouping ────────────────────────────────────────────────────────────────
  // Which field becomes the columns is a variable, not a hard-coded status axis. A
  // group supplies: keyOf (puck → key), keys (the ordered keys to draw), labelOf, an
  // optional column class, and — where the field is writable — a `write`, so
  // dropping a card into a column *sets that field*. Grouping by agent is then the
  // PO console and grouping by repo the fleet view, out of one renderer.
  //
  // `status` has a fixed domain (the ladder), so its columns stand even when empty:
  // an empty column is a real drop target. Open domains (agent, repo, priority) list
  // only the values actually on screen, so they can't produce phantom columns.
  var NO_VALUE = "\u0000"; // the "none" bucket — a key no real value can collide with
  // The tray's own snapshot key. It is the one box on the board that scrolls but is not a
  // grouping value — it holds rows rather than cards — so it needs a key no grouping can
  // produce. Same trick as `NO_VALUE` one line up: a repo, a status, an agent and a tag are
  // all plain text out of a harvest, so a NUL-prefixed string cannot collide with one.
  var TRAY_KEY = "\u0000tray";
  function presentKeys(items, keyOf, rank) {
    var seen = {}, out = [];
    items.forEach(function (it) { var k = keyOf(it); if (!seen[k]) { seen[k] = 1; out.push(k); } });
    return out.sort(function (a, b) {
      if (a === NO_VALUE) return 1; // "none" always sits last
      if (b === NO_VALUE) return -1;
      return rank ? rank(a) - rank(b) : a.localeCompare(b);
    });
  }
  var GROUPS = {
    // No grouping at all: one bucket, no heading. **First in the table, which is what the
    // menus read** — both the Display list and ⌘K walk `Object.keys(GROUPS)`. "None" is the
    // one entry that is not a field to bucket by but the absence of one, so it belongs at
    // the top of that list rather than sorted in among them.
    //
    // It carries **no `field`**, and that is
    // the whole integration — `columnTerm`, `termAboutGroup` and `groupConstrained` each
    // open with `if (!g.field) return …`, so a fieldless group is a shape this file
    // already foresaw. Every optional member is guarded too (`cls`, `tint`, `headExtra`,
    // `write`), so leaving them out is not a special case either.
    none: {
      label: "None",
      headless: true, // the heading is drawn only when the archive has something to say
      keyOf: function () { return NO_VALUE; },
      keys: function (items) { return items.length ? [NO_VALUE] : []; },
      labelOf: function () { return "All pucks"; },
      // The ordering a grouping *proposes*, and `none` is the only one with an opinion —
      // because it is the only one that takes the columns away. `order:` is the puck's
      // declared place **within its column**, so with the columns gone the default chain
      // interleaves a `now` puck ranked 20 between two `done` ones ranked 10 and 30, by a
      // number that never meant anything across that boundary. `status,order` is the
      // board's own reading order flattened — left to right, top to bottom — which is
      // exactly what a board with no columns is. A proposal, not a write: it applies only
      // while the chain is untouched (see `sortChain`).
      sort: "status,order",
    },
    status: {
      label: "Status",
      field: "status",
      fixed: true,
      keyOf: function (i) { return i.status; },
      keys: function () { return columnsForFocus(); },
      labelOf: function (k) { return STATUS_LABEL[k] || k; },
      cls: function (k) { return "col-status-" + k; },
      write: function (item, k) { changeStatus(item, k); },
      preset: function (k) { return { status: k }; },
    },
    agent: {
      label: "Agent",
      field: "agent",
      keyOf: function (i) { return i.agent || NO_VALUE; },
      keys: function (items) { return presentKeys(items, this.keyOf); },
      labelOf: function (k) { return k === NO_VALUE ? "Unrouted" : agentLabel(k); },
      write: function (item, k) { changeAgent(item, k === NO_VALUE ? null : k); },
    },
    repo: {
      label: "Repo",
      field: "repo",
      keyOf: function (i) { return i.repo; },
      keys: function (items) {
        var order = {};
        DATA.sources.forEach(function (s, i) { order[s.repo] = i; });
        return presentKeys(items, this.keyOf, function (k) { return order[k] == null ? 999 : order[k]; });
      },
      labelOf: function (k) { return repoNameOf(k); },
      tint: function (k) {
        var s = DATA.sources.filter(function (x) { return x.repo === k; })[0];
        return s && s.color; // a repo column wears its own colour, like its cards
      },
    },
    // The timeline: columns are months, so it's the same renderer as the board.
    // Dropping a card into a month sets the horizon to that month's last day —
    // the same "by the end of it" reading `roadmap target <slug> 2026-11` uses.
    target: {
      label: "Target",
      field: "target",
      toValue: function (k) { return k === NO_VALUE ? null : endOfMonth(k); },
      keyOf: function (i) { return i.target ? i.target.slice(0, 7) : NO_VALUE; },
      keys: function (items) { return presentKeys(items, this.keyOf); },
      labelOf: function (k) { return k === NO_VALUE ? "No target" : monthLabel(k); },
      write: function (item, k) { changeTarget(item, k === NO_VALUE ? null : endOfMonth(k)); },
    },
    // The parent board: one column per parent, plus the pucks that stand outside
    // every parent. Same renderer again — the level above a puck is a grouping, not
    // a second card type, which is exactly why it costs one registry entry.
    parent: {
      label: "Parent",
      field: "parent",
      keyOf: function (i) { return i.parentRef || NO_VALUE; },
      keys: function (items) {
        var order = {};
        DATA.items.forEach(function (it, i) { order[it.id] = i; }); // parents in board order
        return presentKeys(items, this.keyOf, function (k) { return order[k] == null ? 1e9 : order[k]; });
      },
      labelOf: function (k) {
        if (k === NO_VALUE) return "No parent";
        var p = itemById(k);
        return p ? p.title : k;
      },
      tint: function (k) {
        var p = k === NO_VALUE ? null : itemById(k);
        return p && p.repoColor;
      },
      // No `write`, and that is the one thing this grouping loses by being list-only:
      // `write` is the *drop* writer, and dropping happens between columns. With no
      // parent columns it could never fire, and a writer that cannot be reached is a
      // capability the registry claims and the board does not have. Re-parenting keeps
      // its two real paths — the `Parent` field in the rail (a searchable picker, which
      // is the one a phone can use at all) and `＋ Add puck` on a parent, which writes
      // the relation into the new file.
      // Which puck a column is named after, when it is named after one at all. Only
      // this grouping has an answer: status, repo, agent, priority and target label
      // their columns with categories, and a category has nothing to open.
      //
      // It matters because a puck's name opens it *everywhere else* on the board — the
      // card title, the parent chip, the breadcrumb — and grouping by parent was the
      // one place the rule broke. It is also the place where the puck is otherwise not
      // on screen: it sits in `No parent`, or inside its own parent's column.
      opens: function (k) { return k === NO_VALUE ? null : itemById(k); },
      // The parent's own rollup in the column header — counted over all its pucks,
      // not just the ones the current filter left on screen.
      headExtra: function (k) {
        var p = k === NO_VALUE ? null : itemById(k);
        return p && p.progress ? progressBadge(p) : null;
      },
    },
    priority: {
      label: "Priority",
      field: "priority",
      keyOf: function (i) { return i.priority || NO_VALUE; },
      keys: function (items) {
        return presentKeys(items, this.keyOf, function (k) { return PRIORITY_RANK[k]; });
      },
      labelOf: function (k) { return k === NO_VALUE ? "No priority" : (PRIORITY_LABEL[k] || k); },
      write: function (item, k) { changePriority(item, k === NO_VALUE ? null : k); },
    },
  };
  // The groupings that need the list. `parent` is a hierarchy and cannot be columns;
  // `none` is the absence of columns, which is the same thing said the other way. One
  // table rather than two `=== "parent"` tests, because the second one is exactly how the
  // first came to be forgotten in `effectiveParams`.
  var LIST_ONLY = { parent: 1, none: 1 };
  // Grouping by a field the view has already fixed makes one group named after the
  // view — "INBOX 11" under a header that says "Inbox 11". Derived from the columns
  // the view can show rather than from the view's name, so a future single-status
  // view gets the same treatment without being listed anywhere.
  //
  // The *effective* group falls back; `state.group` keeps what you chose. Visiting
  // the inbox therefore doesn't overwrite the grouping you set elsewhere, and the
  // URL still carries the choice you made.
  // Two questions, and they are not the same one. `groupOffered` is what the menus ask —
  // may this grouping be chosen at all here — and `groupUsable` is what the renderer
  // asks: can it be *drawn* in the layout we are standing in.
  //
  // `parent` is the one grouping that answers them differently, because it is the one
  // grouping that is a hierarchy rather than a facet. A tree spans statuses, so there is
  // no level to draw inside a kanban column — and measured against the real board it is
  // not a close call: 173 pucks, 19 of them in a tree, so `group=parent` drew columns of
  // 2 and 3 cards beside a `No parent` holding 28 (144 with the archive on) in a grid
  // that gives every column the same width. Hierarchy is sparse by nature; that
  // distribution is the normal case, not a phase.
  //
  // So the rule is: **flat facets group the board, the one hierarchy groups the list**.
  // The menus keep offering Parent — `setDisplay` switches the layout with it, visibly —
  // because a row that vanishes depending on the layout teaches nothing.
  //
  // `none` is the exception to that last sentence, and the difference is what the row
  // *names*. `Parent` names a thing to bucket by; the board cannot draw it as columns, so
  // picking it there is a real request the layout switch honours. `None` names the absence
  // of the board's own organising principle — a kanban board with no grouping is not a
  // board with a setting changed, it is a list. So the row is not a grouping you can ask
  // the board for, and offering it would make the layout switch the *whole* effect of
  // pressing it. It comes back the moment you are in the list, where it means something.
  function groupOffered(k) {
    if (k === "none") return state.view === "list";
    return k !== "status" || columnsForFocus().length > 1;
  }
  function groupUsable(k, layout) {
    if (LIST_ONLY[k]) return (layout || state.view) === "list";
    return groupOffered(k);
  }
  function effectiveGroup() {
    if (groupUsable(state.group)) return state.group;
    // `status` is the board's own axis; where the view has already fixed it, `repo` is
    // the fallback the inbox has always used. `state.group` keeps your choice either
    // way, so stepping back into the list restores it.
    return groupUsable("status") ? "status" : "repo";
  }
  function activeGroup() { return GROUPS[effectiveGroup()] || GROUPS.status; }
  // A grouping that draws no heading draws no fold control, so a fold under it is a
  // preference about nothing. Asked by `effectiveParams` about a foreign params object and
  // by `applyParams` about the live state — two domains, one question.
  function headlessGroup(k) { return !!(GROUPS[k] && GROUPS[k].headless); }
  // Whether a hand-placed position is what the eye is reading — which, now that the
  // ordering is a chain, is a question about *rank* and not about mode: `order` first means
  // the list is in the order you put it in, and dragging moves you within it. Further down
  // the chain `order` still breaks ties, but the list is not "manually ordered" any more,
  // so a drag would land somewhere the fields decide rather than where you dropped it.
  // `order` *forward* and first. Reversed (`order-desc`) the list still reads by rank, but a
  // drop would have to write a rank that means the opposite of where the finger let go, so
  // it is not manual ordering any more. The canonical spelling makes that free: a reversed
  // key is `order-desc` and simply is not this string.
  function manualRank() { return sortChain()[0] === "order"; }

  // Bucket the visible pucks by the active grouping. Returns [{ key, label, items }]
  // in the group's own order — the one thing both renderers consume.
  function groupsOf(visible) {
    var g = activeGroup();
    var keys = g.keys(visible);
    var byKey = {};
    keys.forEach(function (k) { byKey[k] = []; });
    visible.forEach(function (it) {
      var k = g.keyOf(it);
      if (byKey[k]) byKey[k].push(it); // a key outside the list (e.g. a filtered status) is dropped
    });
    // A hidden column has to lose its *header*, not just its cards. The derived
    // groupings drop it for free — their keys come from the items that survived the
    // filter — but `status` builds its columns from a fixed list, so `-status:later`
    // emptied LATER and left the empty column standing, which is the one thing "Hide
    // column" must not do. The rule is about the filter, not about hiding: an empty
    // column is a drop target worth keeping until the filter speaks about the very
    // field the columns are made of, and then it is a hole where a column used to be.
    // So filtering by an unrelated field (`tag:ui`) keeps every column as a target,
    // while any term on the grouping's own field takes the emptied ones away — which
    // is `Hide column`, `Show only this` and a hand-typed query, all by one rule.
    // Stated here and not in either renderer: the board and the list share this.
    // …but only the columns the query actually speaks *against*. Asking merely whether
    // the query mentions the grouping's field made hiding one column evict every other
    // empty one with it: with the archive on and `Cancelled` standing empty, hiding
    // `Done` wrote `-status:done`, and Cancelled — which that term says nothing about —
    // vanished from the board and turned up in the tray as though you had hidden it too.
    // One click, two columns moved, and the tray reported the one you never touched.
    // Testing the column instead of the field keeps every case the rule was written for
    // (`-status:later` empties and drops LATER; `Show only this` drops the rest; an
    // unrelated `tag:ui` keeps them all as drop targets) and drops the eviction nobody
    // asked for.
    return keys.filter(function (k) { return byKey[k].length || !columnExcluded(g, k); })
      .map(function (k) { return { key: k, label: g.labelOf(k), items: byKey[k] }; });
  }
  // Does this query value name this column? A value is not always spelled the way the
  // column is keyed: `repo:` accepts `tor2dbear/roadmap`, `roadmap` and `Parent`, and
  // `parent:` accepts the raw `parent:` line, the resolved id and the bare slug — that
  // is `FIELDS[…].vals()`, and it is what `termMatches` asks when it decides which
  // cards the term keeps. Anything comparing the raw value against the column key was
  // therefore asking a narrower question than the filter itself: `-repo:roadmap` hid
  // the Parent column, the tray listed it under its canonical key, and the eye —
  // hunting for "roadmap" among the tray's keys — found nothing and left the term
  // standing. The affordance rendered, clicked, re-rendered, and changed nothing.
  //
  // So ask the data the same question the matcher asks, rather than keeping a second
  // alias table here to drift out of step with that one. A column with no items at all
  // (an empty status) is covered by the direct comparison, since a field with no items
  // to alias has no aliases either.
  function valueNamesColumn(g, value, key) {
    if (lower(value) === lower(key)) return true;
    var f = FIELDS[g.field];
    if (!f || !f.vals) return false;
    for (var i = 0; i < DATA.items.length; i++) {
      var it = DATA.items[i];
      if (g.keyOf(it) !== key) continue;
      if (f.vals(it).filter(Boolean).map(lower).indexOf(lower(value)) !== -1) return true;
    }
    return false;
  }
  // Does the query say this column may not be here? The same vocabulary `columnTerm`
  // writes, read back: a value term keeps only what it names (or, negated, drops it),
  // and the `has:`/`is:member` pair speaks about the absence bucket in one polarity and
  // about every real column in the other. Empty *and* excluded is a hole where a column
  // used to be; empty and merely unmentioned is still a column, and still a drop target.
  function columnExcluded(g, key) {
    var none = key === NO_VALUE;
    var out = false;
    parseQuery(state.query).forEach(function (t) {
      if (!termAboutGroup(t, g)) return;
      if (t.field === "has" || t.field === "is") { if (none ? !t.neg : t.neg) out = true; return; }
      if (none) { if (!t.neg) out = true; return; } // any positive value term excludes "none"
      var names = t.values.some(function (v) { return valueNamesColumn(g, v, key); });
      if (t.neg ? names : !names) out = true;
    });
    return out;
  }

  // ── a column, as a filter term ───────────────────────────────────────────────
  // Linear's column menu has "Hide column", and ours needs no store to match it: a
  // column *is* a value of the grouping field, so hiding one is a negated term in the
  // query we already have. That buys the whole feature for free — it serialises into
  // `?q=`, saves into a view, shows up as a removable `Not Status: Later ×` chip (the
  // way back, and better than a "2 hidden" footer because it names what is hidden),
  // and it is automatically right per grouping, because it is written in the grouping's
  // own field. A `hidden: { status: [...], repo: [...] }` store would have been a
  // second source of truth for something the query can already say.
  //
  // Returns { field, value, hideNeg } or null when the column cannot be named by one
  // term. `hideNeg` is the polarity that *hides* it; showing only this column is the
  // other one. The none-bucket inverts: its key is the absence of a value, so it is
  // `has:<field>` that hides it, not a negation.
  function columnTerm(g, key) {
    if (!g.field) return null;
    // A target column is a *month bucket* over a date, so naming it takes a range —
    // two terms, and negating a conjunction is not something this grammar can say.
    // The "No target" column is still nameable, because absence is a single question.
    if (g.field === "target" && key !== NO_VALUE) return null;
    if (key === NO_VALUE) {
      // The parent grouping buckets on `parentRef` — the *resolved* link — while
      // `has:parent` asks whether the file says anything, and answers yes for a
      // `parent:` that resolves to nothing. Such a puck sits in "No parent" and would
      // have survived hiding it. `is:member` is the same question the column asks.
      if (g.field === "parent") return { field: "is", value: "member", hideNeg: false };
      return { field: "has", value: g.field, hideNeg: false };
    }
    return { field: g.field, value: key, hideNeg: true };
  }
  // Does this term speak about the field the grouping columns by? Asked in three places
  // — is a column constrained, which term hid it, which terms must go when you say
  // "only this" — and getting it wrong in any one of them is a board that disagrees
  // with itself. One predicate, three callers. The three shapes a group can be spoken
  // about in: its own field, the `has:` pair for its absence bucket, and (for parents)
  // `is:member`, which is that bucket said in the grammar the column actually uses.
  function termAboutGroup(t, g) {
    if (!g.field) return false;
    if (t.field === "has") return t.values[0] === g.field;
    // Every value, not the first: an `is:` term carries alternatives now, so
    // `is:parent,member` is as much about the parent grouping as a bare `is:member` —
    // and reading `values[0]` would have answered no for one spelling and yes for the
    // other, which is a board that disagrees with its own tray.
    if (t.field === "is") return g.field === "parent" && t.values.indexOf("member") !== -1;
    return t.field === g.field && t.field !== "text";
  }
  function groupConstrained(g) {
    if (!g.field) return false;
    return parseQuery(state.query).some(function (t) { return termAboutGroup(t, g); });
  }

  // What the tray ended up showing, so the chip row can decline to say it again. Read
  // rather than recomputed: the two renderers already run in order — `renderColumns`,
  // then `renderChips` — and asking `hiddenColumns` a second time would mean rebuilding
  // the groups it needs. Null whenever no tray was drawn, which is what keeps every
  // chip in the list layout, where there is nothing standing in for it.
  var trayColumns = null;
  // The tray, at the end of the board where the columns it holds would have been.
  // Board only: it is a *place* on the board ("these would be over here"), and a flat
  // list has no columns for it to be at the end of — there the chip row still says
  // what is filtered out.
  function renderHiddenTray(g, groups) {
    var hidden = hiddenColumns(g, groups);
    if (!hidden.length) return;
    trayColumns = { g: g, keys: {} };
    hidden.forEach(function (h) { trayColumns.keys[h.key] = 1; });
    var tray = el("div", "column hidden-cols");
    var head = el("div", "col-head");
    // The swatch slot, empty. See `.hidden-cols .col-head .swatch`: it carries no colour,
    // it carries the 18px that every column title stands behind.
    head.appendChild(el("span", "swatch"));
    head.appendChild(el("h2", null, "Hidden"));
    head.appendChild(el("span", "count", String(hidden.length)));
    tray.appendChild(head);
    var list = el("div", "cards");
    // A tall tray scrolls (measured: 469 against 128 with eleven archive-hidden repos in a
    // 300px window), and without a key every offset snapshot walked straight past it —
    // they all ask `.cards[data-col]`. A redraw then threw the reader back to the top of
    // the one list whose whole purpose is the eyes further down it. Codex found it (#54).
    list.dataset.col = TRAY_KEY;
    hidden.forEach(function (h) {
      var b = el("button", "row hidden-col");
      b.type = "button";
      b.title = "Show " + h.label + " again";
      if (g.cls) b.classList.add(g.cls(h.key));
      b.appendChild(el("span", "swatch"));
      b.appendChild(el("span", "hidden-label", h.label));
      // The count is the point: it is what the chip row cannot say, and what you
      // actually want to know before deciding to bring a column back.
      b.appendChild(el("span", "count", String(h.n)));
      b.appendChild(icon("eye"));
      b.addEventListener("click", function () { unhideColumn(g, h.key, h.archive); });
      list.appendChild(b);
    });
    tray.appendChild(list);
    board.appendChild(tray);
  }

  // Ask a question of the board as if the archive toggle were on. Three separate
  // readers consult `state.showDone` — `viewTerms`, `columnsForFocus`, and through it
  // the status grouping's `keys` — and the tray has to put the same question to all
  // three at once: which columns would stand here if nothing were hidden? Threading a
  // parameter through all three would put the archive into the signature of code that
  // is not about the archive. A scoped override puts it where the question is asked,
  // and `finally` means a throw inside can't leave the board in the lifted state.
  function withShowDone(on, fn) {
    var was = state.showDone;
    state.showDone = on;
    try { return fn(); } finally { state.showDone = was; }
  }
  // The board as it would be with this grouping's own filters lifted: which columns
  // would stand, and how many pucks behind each. `archive` lifts the toggle too.
  function wouldShow(g, archive) {
    return withShowDone(archive || state.showDone, function () {
      var free = viewTerms().concat(
        parseQuery(state.query).filter(function (t) {
          // A place is where you navigated, not a column you hid — so its term stays in,
          // and the repos you are not in never show up as "hidden". Whatever the board
          // groups by: `&group=repo` while scoped to one repo made `t.field === g.field`,
          // the guard fell through to the group rule, and every *other* repo was offered
          // in the tray as if you had hidden it — with an eye that would have widened the
          // scope. The old code got this right by accident, because `controlTerms()` was
          // concatenated separately and never filtered at all.
          if (!t.neg && PLACE_FIELDS_ORDER.indexOf(t.field) !== -1) return true;
          return !termAboutGroup(t, g);
        })
      );
      var would = DATA.items.filter(function (it) { return runQuery(it, free); });
      var count = {};
      would.forEach(function (it) { var k = g.keyOf(it); count[k] = (count[k] || 0) + 1; });
      return { keys: g.keys(would), count: count };
    });
  }
  // Which columns are missing from the board, and how much is behind each. A hidden
  // column is otherwise invisible in the one place it matters — the board — and this is
  // now the only place that says so: `Not Status: Later ×` said what was gone but never
  // how much, which is the whole question you ask before deciding to bring it back, so
  // the chip row stands down for it (see `hiddenByTray`) and the count stands here.
  //
  // Terms are stripped from `state.query` only, never from the view's own or a place's.
  // `-status:inbox` is what "All pucks" *means*, not something you hid; a repo place is
  // where you navigated. Dropping those too would list Inbox as hidden on every board.
  function hiddenColumns(g, shown) {
    if (!g.field) return [];
    // Two things take a column off the board, and the tray only ever knew about one.
    // A term in `state.query` hides a column — and so does the archive toggle, which
    // is not a term at all: "Show done & cancelled" writes `-is:done` into
    // `viewTerms()`, where the chip row cannot see it either. So the most-used switch
    // on the board removed two columns and *nothing anywhere said so*. The tray is the
    // place that says a column is missing; it has to answer for both causes, or the
    // one people actually press stays invisible.
    var archiveOff = !state.showDone && ARCHIVABLE[state.focus];
    if (!groupConstrained(g) && !archiveOff) return [];
    var here = {};
    shown.forEach(function (grp) { here[grp.key] = 1; });
    // Two passes, because the two causes need different answers. `byQuery` is the board
    // with the query's own terms lifted and the toggle left as it stands: a column
    // missing from *that* is the toggle's doing, and its eye has to press the toggle
    // rather than mend a term that was never written. It also decides which count is
    // honest — a column the query hid is counted with the archive still off, or hiding
    // one repo while the archive is off would advertise its landed pucks as waiting.
    var byQuery = wouldShow(g, false);
    var full = archiveOff ? wouldShow(g, true) : byQuery;
    var reachable = {};
    byQuery.keys.forEach(function (k) { reachable[k] = 1; });
    // A column the *archive* hid needs no name to come back — its eye presses the
    // toggle, and a toggle takes no argument. Demanding a nameable term anyway lost
    // the Target grouping entirely: a month is a range over a date, two terms whose
    // conjunction this grammar cannot negate, so `columnTerm` returns null for every
    // real month. An archive-only month then had no tray row *and* no chip, which is
    // precisely the silence this whole change exists to end. A column the *query* hid
    // still has to be nameable, because mending that term is the only way back to it.
    return full.keys.filter(function (k) { return !here[k] && (!reachable[k] || columnTerm(g, k)); })
      .map(function (k) {
        var archive = !reachable[k];
        return {
          key: k, label: g.labelOf(k), archive: archive,
          n: (archive ? full.count : byQuery.count)[k] || 0,
        };
      })
      // An eye that would produce nothing is worse than no row. With "Show empty
      // columns" off, restoring a column that turns out to be empty leaves the board
      // exactly as it was and the tray row simply disappears — the affordance promises
      // a column and then swallows it. `n` is already "what the eye would put on the
      // board" for both causes, so one test covers both: the archive's `Cancelled 0`
      // on a default board, and a `-status:x` on a status nothing is in. With the
      // setting on, the same click *does* produce a column — an empty one, which is
      // what that setting asks for — so the row stays.
      .filter(function (h) { return state.showEmpty || h.n > 0; });
  }
  // Putting a column back means editing the term that actually excluded it — which is
  // not always the term that names it. Adding this column's own predicate instead was
  // wrong in a way that showed: with `priority:high` set, the tray listed "No priority",
  // and its eye added `-has:priority`. Terms are ANDed, so `priority:high -has:priority`
  // matches nothing at all — the column stayed hidden and the board went empty.
  //
  // So walk the terms that speak about this grouping and mend each one:
  //   a negation naming me      → take my name out of it
  //   a positive leaving me out → put my name in
  //   the absence pair          → drop it, when it is the polarity that hides me
  // Everything else is left alone, so hiding two columns and restoring one keeps the
  // other hidden.
  //
  // A column can need both edits at once — grouping by status with `-status:done` set
  // *and* the archive off hides Done twice over. So the toggle is lifted here rather
  // than through `setDisplay`: that one ends in a render, which would repaint the board
  // with the archive lifted and the term still standing, and the column would flash
  // back into hiding before the second half ran. The term edit below renders once, for
  // both halves. One eye, one click, one column back — which is the whole point of it.
  // Lifting the archive, from wherever the board admits a card is missing. Two callers
  // — the tray's eye on a whole column, and a column head's own mark on the cards it is
  // hiding — and they have to write the same key, or the Display menu and the sidebar
  // counts end up disagreeing with the board they describe.
  function liftArchive() {
    state.showDone = true;
    rememberDisplay(); // the same write `setDisplay("showDone", …)` makes, into the same view
    refreshDisplayDot();
    refreshNav(); // the sidebar's counts read `state.showDone`
  }
  function unhideColumn(g, key, archive) {
    var t = columnTerm(g, key);
    if (!t && !archive) return; // nothing to mend and no toggle to lift
    if (archive) liftArchive();
    // An unnameable column (a target month) is only ever here for the archive, so the
    // lift above *is* the whole repair; render it, since no term edit will.
    if (!t) { renderBoard(); return; }
    var none = key === NO_VALUE;
    var out = [];
    parseQuery(state.query).forEach(function (term) {
      if (!termAboutGroup(term, g)) { out.push(term); return; }
      var absence = term.field === "has" || term.field === "is"; // `has:x` / `is:member`
      if (none) {
        // The absence bucket has no value to add or remove. `has:<field>` hides it, and
        // so does any *positive* term on the field — there is no term that says "high,
        // or nothing at all", so both have to go. Negations never hide it: a puck with
        // no priority matches `-priority:low` and `-has:priority` alike.
        if (!term.neg) return;
        out.push(term); return;
      }
      // A real value. `-has:<field>` (and `-is:member`) empties every real column.
      if (absence) { if (term.neg) return; out.push(term); return; }
      // *Every* spelling that names me, not the first one found. One term can list the
      // same column twice — `-repo:tor2dbear/roadmap,roadmap` is one exclusion written
      // two ways — and stopping at the first left the other still excluding it. The eye
      // then redrew the very column it had promised to bring back, and since the chip
      // stands down whenever the tray owns the column, that left no working way out at
      // all. Removing one of two names for one thing was never the intent; it only
      // looked like it while aliases were invisible here.
      var kept = term.values.filter(function (v) { return !valueNamesColumn(g, v, key); });
      var vals;
      if (term.neg) vals = kept; // drop every name that excludes me
      else {
        // A positive term lists the columns that may stand. Naming me once is enough,
        // so nothing is removed — add me only when no spelling of me is there already.
        vals = term.values.slice();
        if (kept.length === term.values.length) vals.push(t.value);
      }
      if (vals.length) { term.values = vals; out.push(term); }
    });
    setQueryTerms(out);
  }

  // "Show only this" is a statement, not a switch. `toggleFilterValue` would have taken
  // `now` *out* of `status:now,next` — leaving the opposite column — and cleared a
  // singleton `status:now` back to every column. Both are the command's own negation.
  // So: drop everything the filter says about this grouping, then say the one thing.
  function showOnlyColumn(g, key) {
    var t = columnTerm(g, key);
    if (!t) return;
    if (PLACE_FIELDS_ORDER.indexOf(g.field) !== -1 && key !== NO_VALUE) {
      // Already the sole place → the command is satisfied; `pickScope` would read that
      // as a toggle and widen the board back to all, which is what the label denies.
      var vals = placeValues(g.field);
      if (vals.length === 1 && vals[0] === lower(key)) return;
      scopeToPlace(g.field, key);
      return;
    }
    var rest = parseQuery(state.query).filter(function (term) { return !termAboutGroup(term, g); });
    rest.push({ field: t.field, op: t.field === "has" || t.field === "is" ? "is" : "in",
                values: [t.value], neg: !t.hideNeg });
    setQueryTerms(rest);
  }
  // "Hide column" is a constraint, and a constraint narrows. That is not what a facet
  // tick does: ticking Membership *widens* the board, because a section's values are
  // ORed. So routing the hide through the tick added `member` to `is:standalone` and
  // published `is:standalone,member` — every standalone puck still matched, the column
  // the menu had just promised to hide stayed exactly where it was, and the parent
  // columns appeared beside it. The menu made the board bigger.
  //
  // Only the absence bucket hits this: every other column hides by negation, and a
  // negated term ANDs with the section's without touching it. `No parent` is the one
  // that needs a *positive* `is:member` (a puck can carry a `parent:` that resolves to
  // nothing, so `has:parent` answers about the file while the column buckets on the
  // resolved link), and positive is exactly where it collides with the facet.
  //
  // Setting the section to `member` alone is the honest reading of the command: hiding
  // the pucks that stand outside every parent *is* "show only the ones inside one". It
  // drops the other ticks, and it has to — those ticks are what was keeping the column
  // on screen. `unhideColumn` is the mirror: it drops the term entirely.
  function hideColumnTerm(t) {
    var sec = t.field === "is" && !t.hideNeg ? sectionForState(t.value) : null;
    if (sec) return setSectionValues(sec, [t.value], false);
    toggleFilterValue(t.field, t.value, t.hideNeg);
  }
  // The column head's ⋯ — same shape as the puck's, and the only two things you can
  // say about a column that aren't about the pucks in it.
  function colMenu(g, key, label) {
    var wrap = el("div", "prop-pick col-more");
    var btn = el("button", "btn btn--icon");
    btn.type = "button";
    btn.title = "Column options";
    btn.setAttribute("aria-label", "Options for " + label);
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.appendChild(icon("more"));
    var open = null;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) { open.close(); return; }
      btn.setAttribute("aria-expanded", "true");
      open = openSurface({
        title: label,
        anchorWrap: wrap,
        // Not mirrored, unlike the puck's ⋯ and the saved view's. Mirroring assumes the
        // page's right edge is the one that cuts; here it's the left. The sidebar is
        // `position: sticky` and paints over the board's own scroll box, so a menu that
        // hangs left from a trigger in the *first* column disappears under it — the
        // board starts exactly where the sidebar ends. Hanging right is safe at the
        // other end because `.board` scrolls horizontally and the last column's menu
        // stays inside its own column's width.
        cls: "pick-menu",
        onClose: function () { open = null; btn.setAttribute("aria-expanded", "false"); },
        build: function (host, api) {
          var t = columnTerm(g, key);
          function row(iconName, text, run) {
            var b = el("button", "row");
            b.type = "button";
            b.appendChild(icon(iconName));
            b.appendChild(el("span", null, text));
            b.addEventListener("click", function () { api.close(); run(); });
            host.appendChild(b);
          }
          // "Show only this" on a repo or agent column is *navigation*, not a filter.
          // Those two are the sidebar's places, and `readUrl` already turns a positive
          // `repo:`/`agent:` term back into one on load — so writing it as a query term
          // made the same URL render two different chromes: sidebar dark with a chip
          // right after the click, sidebar lit with no chip after a reload, nothing
          // touched in between. One state, two pictures, and a link that looked
          // different to whoever opened it fresh. `showOnlyColumn` takes the door the
          // model already has, for the positive half of a real value only: there is no
          // place called "not PIA" — which is what `readUrl`'s `!t.neg` guard says — and
          // an absence bucket is not somewhere you can stand.
          row("eye", "Show only this", function () { showOnlyColumn(g, key); });
          row("eye-off", "Hide column", function () { hideColumnTerm(t); });
        },
      });
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // "N archived", in the head of the column that is short of them. Not a label: it
  // presses the same toggle the tray's eye does, so the thing that says what is missing
  // is also the thing that brings it back.
  // `key` is the group it stands in, and only the list passes one: a collapsed section
  // still carries the mark — it is short of those cards whether it is open or shut — so
  // pressing it lifted the archive into a section that stayed closed. A control labelled
  // "Show 3 archived pucks in this column" that visibly shows nothing. Unfolding is part
  // of the repair, not a second click for the reader to find.
  // `where` names the place the pucks are missing from, and it exists because one
  // grouping has no columns: under `group=none` the mark stands over the whole list, and
  // "in this column" would name a thing that is not drawn anywhere on the page.
  function archivedMark(n, key, where) {
    var b = el("button", "col-archived");
    b.type = "button";
    b.title = "Show " + n + " archived " + (n === 1 ? "puck" : "pucks") + " in " + (where || "this column");
    b.setAttribute("aria-label", b.title);
    b.appendChild(el("span", "count", String(n) + " archived"));
    b.appendChild(icon("eye"));
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      if (key != null) state.collapsed.delete(key);
      liftArchive();
      renderBoard();
    });
    return b;
  }
  // How many cards the archive is holding back from each column that *is* on the board.
  //
  // The tray answers for a whole column missing; under a non-status grouping the archive
  // takes cards *inside* the columns instead, and there the tray cannot speak: a repo
  // reaches it only when every one of its pucks is archived. So `?group=repo` with the
  // toggle off showed PIA's 6 open pucks and dropped 39 landed ones with nothing on
  // screen saying so — the one case the "a column → the tray, cards → the chip row" rule
  // did not cover, because the chip row cannot see this switch either (`viewTerms()`
  // holds it as `-is:done`, outside `state.query`).
  //
  // The exemption lives in the *callers*, not here: the data is the data, and only the
  // board can say "the tray already covers this". `order` comes back too, because the
  // list has to slot a fully-archived group into its own place rather than at the end.
  function archivedPerColumn(shownRoots) {
    if (state.showDone || !ARCHIVABLE[state.focus]) return null;
    var count = {}, order = [];
    withShowDone(true, function () {
      var q = activeTerms();
      var all = DATA.items.filter(function (it) { return runQuery(it, q); });
      var gs = groupsOf(all);
      // Counted in the shape the layout actually draws: in the tree a root that *is* a
      // heading is never a row under `No parent`, so it is not one of the rows that
      // column can be short of. `shownRoots` is exactly the set the live board lifted —
      // see `liftRoots` for why "exactly" matters.
      if (shownRoots) liftRoots(gs, shownRoots);
      gs.forEach(function (grp) { count[grp.key] = grp.items.length; order.push(grp.key); });
    });
    return { count: count, order: order };
  }
  // The head's title, for both layouts. A column named after a puck gets a button that
  // opens it and wears the puck's own casing; a column named after a category stays the
  // eyebrow it has always been. `--named` is what carries that to CSS: uppercase plus
  // letter-spacing is right for `NOW` and `ETAPP SITE` and wrong for a title, where it
  // costs 15–20% of the width *and* legibility — measured, `BRAND IT + SPLIT PRODUCT /
  // INSTANCE` against `Brand it + split product / instance`.
  // One button, three heads: the board's, the list's, and the list's archive-only stub.
  // Written once because they promise the same thing — a puck's name opens it — and
  // three copies of that promise is three places for one of them to stop keeping it.
  function openButton(item, label, cls) {
    var b = el("button", "head-open" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.title = "Open " + item.title;
    b.addEventListener("click", function (e) { e.stopPropagation(); openModal(item); });
    return b;
  }
  function headTitle(g, grp) {
    var h = el("h2");
    var opens = g.opens && g.opens(grp.key);
    if (!opens) { h.textContent = grp.label; return h; }
    h.classList.add("named");
    h.appendChild(openButton(opens, grp.label));
    return h;
  }

  // The reader's place in each column, carried across one redraw. `renderBoard` fills it
  // just before it empties the board and `renderColumns` spends it as each column is
  // appended — two functions and one fact, which is a shape this file otherwise avoids.
  // It earns the exception by being write-once-read-once within a single render: anything
  // longer-lived would be a second source of truth for where the reader is.
  var colPlaces = {};
  // The column the keyboard was in when the board was replaced, by the same key as the
  // places above. Null unless focus was actually inside the board — a redraw while the
  // reader is in a sheet, the sidebar or a field must not pull focus onto a column.
  var colFocus = null;
  // Which grouping `colPlaces` was read out of. The keys are the grouping's own values and
  // `NO_VALUE` belongs to four of them, so the key alone cannot say whether a place is this
  // board's.
  var colPlacesGroup = null;
  // What makes a board *this* board, for the purpose of putting a reader's place back: the
  // view, the filter and the grouping. `\u0001` separates them because a query may contain
  // anything printable, and the grouping's own keys reach for `\u0000` already.
  function boardStamp() {
    return state.focus + "\u0001" + canonicalQuery(state.query || "") + "\u0001" + effectiveGroup();
  }
  function renderColumns(groups) {
    var g = activeGroup();
    // No guard for status grouping, and none is needed — which is worth writing down,
    // because the obvious thing to write here is one. Under status grouping an archived
    // card is *by definition* in the Done or Cancelled column, and the toggle has already
    // taken those off the board; a column that still stands can never be holding one
    // back, so `held` is zero for every one of them and no mark is drawn. The tray keeps
    // its job without anyone arranging it. A guard was written first and removed after
    // sabotage failed to break anything: it could not fire in any view.
    var archived = archivedPerColumn();
    groups.forEach(function (grp) {
      if (!grp.items.length && !state.showEmpty) return;
      var col = el("div", "column" + (g.cls ? " " + g.cls(grp.key) : " col-plain"));
      if (g.tint && g.tint(grp.key)) col.style.setProperty("--tint", g.tint(grp.key));
      var head = el("div", "col-head");
      head.appendChild(el("span", "swatch"));
      head.appendChild(headTitle(g, grp));
      if (propOn("count")) head.appendChild(el("span", "count", String(grp.items.length)));
      var held = archived ? (archived.count[grp.key] || 0) - grp.items.length : 0;
      if (held > 0) head.appendChild(archivedMark(held));
      if (g.headExtra && propOn("rollup")) { var hx = g.headExtra(grp.key); if (hx) head.appendChild(hx); }
      // Only where the column can actually be named by a term — a target month
      // cannot, and offering a dead menu item is worse than offering none.
      if (columnTerm(g, grp.key)) head.appendChild(colMenu(g, grp.key, grp.label));
      col.appendChild(head);
      var cards = el("div", "cards");
      // Each column is its own scrollport now, so each is its own keyboard target. The
      // board had one tab stop while it had one scroller; with the vertical axis inside the
      // columns, Page Down on the port moves nothing — it only scrolls sideways. Chrome
      // puts overflowing boxes in the tab order by itself and Safari does not, which is the
      // same asymmetry `markPort()` was written for, so it is said out loud here too.
      // Labelled by the column, because "region" with no name is a landmark you cannot tell
      // from the next one.
      // A named region either way — landmarks are navigated by name, not by Tab, so they
      // cost no keystrokes — but the tab stop waits until the box has something to scroll.
      // See the pass at the end of this function: a stop on an empty column is a target
      // that answers nothing, which is the rule the list's caret gutter already follows.
      cards.setAttribute("role", "region");
      cards.setAttribute("aria-label", grp.label);
      // The key a restored place is found by, and the grouping's own value — so a grouping
      // change simply matches nothing and every column opens at the top, which is what a
      // different arrangement of the same pucks deserves. Same mechanism as `collapsed`.
      cards.dataset.col = grp.key;
      if (grp.items.length === 0) cards.appendChild(el("div", "empty", "—"));
      else grp.items.forEach(function (it) { cards.appendChild(card(it)); });
      col.appendChild(cards);
      // in-column "+" — only where "new puck already in this column" is expressible
      if (ghToken() && g.preset) {
        var add = el("button", "col-add", "");
        add.type = "button";
        add.appendChild(icon("plus"));
        add.setAttribute("aria-label", "New puck in " + grp.label);
        add.addEventListener("click", function () { openNewPuckPanel(g.preset(grp.key)); });
        // Inside the scroller, after the last card — where it was before `.cards` became
        // the column's scrollport. As a *sibling* of the flexed scroller it was pinned to
        // the bottom of the column instead, which costs 31px in every column whether or not
        // anything is drawn there: measured, `opacity: 0` on a hover device and still
        // holding its row. Codex found it (#54). A permanently reachable `+` may well be
        // the better affordance — Linear keeps one in the column head — but that is a
        // design change and this is a restoration.
        cards.appendChild(add);
      }
      // Manual ordering: dropping *between* cards writes `order` (and the status
      // too, when the card also changed column — one move, one commit).
      //
      // Two conditions, both about honesty. The ordering must be Manual, because
      // every other mode derives the position from a field and hand-placing would
      // be a lie. And the grouping must be `status`, because `order` is defined as
      // the rank *within a status column* — placing a card among agent- or
      // priority-grouped neighbours would compute a number against pucks from other
      // statuses and quietly reshuffle the real board. Those groupings keep the
      // plain column drop below, which writes their own field.
      // `effectiveGroup()`, not `state.group`: a view that cannot group by status
      // falls back to repo while the stored choice stays `status`, and reading the
      // stored one enabled the status-only drop handler over repo columns — which
      // computed a rank against another repo's cards and snapped the card back.
      if (manualRank() && ghToken() && effectiveGroup() === "status") {
        cards.addEventListener("dragover", function (e) {
          if (!dragItem) return;
          e.preventDefault();
          e.stopPropagation(); // the column's own handler must not also claim this
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          col.classList.remove("drop-target");
          // Only offer a position we can actually write — refusing after the drop
          // would be worse than not inviting it.
          var over = dropPointAt(cards, e.clientY, grp.items, dragItem);
          if (orderBetween(over.prev, over.next) == null) { clearDropTargets(); return; }
          showDropLine(cards, over.before);
        });
        cards.addEventListener("drop", function (e) {
          if (!dragItem) return;
          e.preventDefault();
          e.stopPropagation();
          var moving = dragItem;
          dragItem = null;
          var at = dropPointAt(cards, e.clientY, grp.items, moving);
          clearDropTargets();
          var order = orderBetween(at.prev, at.next);
          if (order == null) {
            toast("✗ Can’t place below an unranked puck — run `roadmap renumber` first", true);
            return;
          }
          var moved = g.keyOf(moving) !== grp.key;
          changeOrder(moving, order, moved ? grp.key : null, g);
        });
      }

      // Drop = write the grouped field. No writer (repo) → no drop target.
      if (g.write) {
        col.addEventListener("dragover", function (e) {
          if (!dragItem || g.keyOf(dragItem) === grp.key) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          col.classList.add("drop-target");
        });
        col.addEventListener("dragleave", function (e) { if (e.target === col || !col.contains(e.relatedTarget)) col.classList.remove("drop-target"); });
        col.addEventListener("drop", function (e) {
          col.classList.remove("drop-target");
          if (!dragItem || g.keyOf(dragItem) === grp.key) return;
          e.preventDefault();
          g.write(dragItem, grp.key);
          dragItem = null;
        });
      }
      board.appendChild(col);
    });
    // Last, where the columns it holds would have been.
    renderHiddenTray(g, groups);
    // And only now the reader's places, in one pass over a board that is finished.
    //
    // The first version put each one back inside the loop, and its own check caught what
    // that costs: writing `scrollTop` needs the scrollable extent, so it forces a layout —
    // of a board holding two columns out of four. The port is wider than that, so its
    // `scrollLeft` clamped to 0 and the sideways place was lost (measured: 90 → 0). It is
    // the rule at the top of `renderBoard` in a new disguise — nothing may measure the
    // board before it is whole — and the repair is the same: wait until it is.
    //
    // A key that is not in `colPlaces` (a new column, another grouping) opens at the top,
    // and a column that has grown shorter clamps itself.
    // The stamp says which *board* this is, not just how it is grouped, and the second half
    // was a separate finding (Codex, #54). Grouping alone is not identity: navigate All →
    // Ready with both grouped by status and the keys still match, so Ready's `now` opened
    // where All's had been read — measured, 260px down. It is the failure `exitPuckView`
    // names one box out ("a four-row view opened at `scrollLeft: 150` because a longer list
    // had been read there"), and that function cannot catch this one: it returns at once
    // when no puck is open, which is the whole of a board-to-board navigation.
    //
    // View plus query plus grouping, because those are what make a board a different board.
    // A display toggle — the archive, a property — is the same board with more or less
    // drawn, and returning to the place you were reading is right there.
    // `effectiveGroup()`, not `g.key`: the groupings are keyed by their property name in
    // `GROUPS` and carry no `key` member, so that read stamped the string "undefined" and
    // the comparison then failed against a genuine `undefined` on the next pass. Caught by
    // the redraw check within the minute, which is what it is for.
    var gruppering = boardStamp();
    board.dataset.group = gruppering;
    var samma = colPlacesGroup === gruppering;
    // A redraw behind an open puck writes into boxes with no layout, so these offsets go
    // nowhere — and the capture above read 0 from every hidden column in the first place.
    // That case is not this function's to solve: `openDetail` snapshots the columns while
    // the board is still visible and `closeDetail` puts them back. The pass still runs,
    // because it also decides the tab stops.
    Array.prototype.forEach.call(board.querySelectorAll(".cards[data-col]"), function (k) {
      var v = samma ? colPlaces[k.dataset.col] : 0;
      if (v) k.scrollTop = v;
    });
    // And the tab stops, decided here because here is where measuring is allowed — the
    // rule at the top of `renderBoard` forbids it only between the clear and the fill.
    // Behind an open puck this answers "none", which is why `closeDetail` asks again;
    // see `markStops`.
    markStops(board);
    // The keyboard's place, after the stops — a column has to *be* a stop before it can be
    // focused, so the order is load-bearing rather than tidy. Only the same board (the stamp
    // already gates the offsets, for the reason `NO_VALUE` taught), only a column that is
    // still a stop, and never behind an open puck: focus belongs to the puck page there, and
    // `display: none` would make the call a silent no-op anyway.
    // `preventScroll`, because focusing a box scrolls it into view — which would undo the
    // port's `scrollLeft` that was restored three lines above this.
    // Found by scanning rather than by a selector: a key is a grouping's own value — a repo
    // name with a slash in it, `NO_VALUE`'s NUL, `TRAY_KEY` — and none of those belong in an
    // attribute selector. The places pass two lines up compares the same way.
    if (samma && colFocus && !document.body.classList.contains("viewing-puck")) {
      Array.prototype.some.call(board.querySelectorAll(".cards[data-col]"), function (k) {
        if (k.dataset.col !== colFocus || !k.hasAttribute("tabindex")) return false;
        k.focus({ preventScroll: true });
        return true;
      });
    }
    colFocus = null;
  }

  // Fold a group shut or open it. Display state, so it travels the same road as the
  // rest: into `state`, out through the URL, onto the board.
  // A fold rebuilds the board, and a rebuilt board starts at the top — measured, 262 → 0
  // — so the row you had just pressed scrolled out from under your finger and the thing
  // you folded was off screen when it finished. The control is therefore the anchor: its
  // distance from the port's top edge is read before the render and restored after, so
  // the caret stays exactly where you tapped it whatever changed height above it.
  //
  // Found again by its `data-fold` key rather than kept as a node: the render replaces
  // the element, so the old one is detached and measures nothing.
  function toggleGroup(key, control) {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    // A fold is one of the seven, and the one the puck called the worst case: the keys
    // are the *grouping's* own values, so a fold made under `group=parent` carried into a
    // view grouping by something else, where it matched nothing — or worse, matched that
    // grouping's `NO_VALUE` bucket. `setDisplay` already cleared them when the grouping
    // changed, for exactly that reason; a navigation had no equivalent, and now the
    // memory is it.
    rememberDisplay();
    refreshDisplayDot();
    var port = scrollPort();
    var before = port && control ? control.getBoundingClientRect().top - port.getBoundingClientRect().top : null;
    renderBoard();
    if (before == null) return;
    var again = null;
    [].forEach.call(port.querySelectorAll("[data-fold]"), function (e) {
      if (again == null && e.getAttribute("data-fold") === String(key)) again = e;
    });
    if (!again) return;
    port.scrollTop += (again.getBoundingClientRect().top - port.getBoundingClientRect().top) - before;
  }
  // Under `group=parent` the list is a tree, and the flat groups `groupsOf` hands both
  // renderers are already its edges: one group per parent, holding that parent's
  // *direct* children. Three moves turn the one into the other, and none of them re-key
  // anything — the board keeps the flat buckets it was designed around.
  //
  //   1. **A group whose puck is drawn as a row somewhere nests under that row.** That
  //      is the whole of "a child's children go one level further down": the mid puck
  //      used to be two things at once — a row inside its parent's group and, elsewhere
  //      on the page, a heading of its own — and now it is one thing with its parts
  //      beneath it.
  //   2. **A root parent stops being a row in `No parent`** and becomes its own heading.
  //      `No parent` then means what it says: pucks in no tree at all.
  //   3. **A parent whose parts the filter took keeps its place**, as a heading or row
  //      with an empty line under it, rather than silently reading as a leaf.
  //
  // What it deliberately does not do: nest a group whose own puck the filter removed.
  // There is no row to hang it from, so it keeps a top-level heading — the same context
  // heading the list has always drawn for a parent that is not itself on screen.
  function treeMode() { return state.view === "list" && effectiveGroup() === "parent"; }
  // (2), on its own because the archive has to be counted the same way. `No parent`
  // holds rows, and a root is not one of them — so counting a lifted root among the
  // pucks the archive is holding back made the heading advertise one more hidden puck
  // than it had, and could conjure an archive-only `No parent` out of a column whose
  // only remaining rows were roots. Returns them, since the tree needs to know which
  // headings to build.
  // `only` is what makes the archive's copy of this honest. A root is lifted from the
  // count because it is *already on screen as a heading* — so only the roots the live
  // board actually lifted may be lifted here. An archived root has no heading (the
  // archive is hiding the puck itself, not its parts), and lifting it unconditionally
  // deleted the one thing that could bring it back: with a query matching an archived
  // root and none of its parts, the board went completely blank — no rows, no stub, no
  // eye. It stays counted, so `No parent` keeps its mark and the eye still opens it.
  function liftRoots(groups, only) {
    var none = null;
    groups.forEach(function (grp) { if (grp.key === NO_VALUE) none = grp; });
    if (!none) return {};
    var roots = {};
    none.items.forEach(function (it) {
      if ((it.children || []).length && (!only || only[it.id])) roots[it.id] = it;
    });
    none.items = none.items.filter(function (it) { return !roots[it.id]; });
    return roots;
  }
  function listTree(groups, roots) {
    var byKey = {}, visible = {};
    groups.forEach(function (grp) {
      byKey[grp.key] = grp;
      grp.items.forEach(function (it) { visible[it.id] = it; });
    });
    var sections = [];
    groups.forEach(function (grp) {
      var p = grp.key === NO_VALUE ? null : itemById(grp.key);
      if (!(p && p.parentRef && visible[p.id])) sections.push(grp); // (1)
    });
    Object.keys(roots).forEach(function (id) {
      // (3) at the top level: a visible root whose every part the filter took has no
      // group of its own, so its heading has to be built rather than found.
      if (!byKey[id]) sections.push({ key: id, label: roots[id].title, items: [], emptyParent: true });
    });
    // Board order, `No parent` last — the order `presentKeys` would have given. The
    // synthesised headings have to land *in* it, not after everything that was found.
    var rank = {};
    DATA.items.forEach(function (it, i) { rank[it.id] = i; });
    var at = function (k) { return k === NO_VALUE ? 2e9 : rank[k] == null ? 1e9 : rank[k]; };
    sections.sort(function (a, b) { return at(a.key) - at(b.key); });
    return { sections: sections, byKey: byKey };
  }

  function renderList(groups) {
    var g = activeGroup();
    // No exemption for status grouping here, unlike the board. The list has no tray, so
    // nothing else can speak for the archive — and `?layout=list` with the toggle off
    // simply had no Done section, in the *default* grouping, with nothing saying so. The
    // chip row cannot cover it either (`viewTerms()` holds the switch outside
    // `state.query`), which is what left this layout silent in every grouping.
    // The lift comes first, and its result is handed to the archive count: the two have
    // to agree about which roots became headings. Before `shownKeys`, deliberately, so a
    // `No parent` the lift empties can become an archive stub like any other emptied
    // column rather than standing as a column with no rows.
    var roots = treeMode() ? liftRoots(groups) : null;
    // …and "became a heading" is the wider question. A root gets one two ways: the lift
    // takes it out of `No parent`, or a *child's* group supplies it. The second is how
    // an archived root with an open part is drawn — the archive took the puck itself, so
    // the lift cannot see it, but the list draws its heading from the child all the same.
    // Counting it among the rows `No parent` is short of promised a card the eye could
    // not deliver: the mark said 5, the eye gave back 4 and promoted the fifth to the
    // heading it already had.
    var headed = null;
    if (roots) {
      headed = {};
      Object.keys(roots).forEach(function (id) { headed[id] = 1; });
      groups.forEach(function (grp) { if (grp.key !== NO_VALUE && grp.items.length) headed[grp.key] = 1; });
    }
    var archived = archivedPerColumn(headed);
    var shownKeys = {};
    groups.forEach(function (grp) { if (grp.items.length) shownKeys[grp.key] = 1; });
    // A group the archive emptied *entirely* never reaches `groups`, so it has to be put
    // back as a heading with nothing under it — the list's answer to what the tray does
    // on the board. Walked in the archive's own order so it lands in its own place
    // rather than after everything else.
    if (archived) {
      var stubs = {};
      archived.order.forEach(function (k) { if (!shownKeys[k] && archived.count[k]) stubs[k] = 1; });
      // Except where the group's own puck is archived, which under the parent grouping is
      // a thing a group can be: the heading *is* a puck there, not a label. "Archived" is
      // not a state of its own — `TERMINAL` is `done` or `cancelled`, which is what the
      // toggle's label spells out — so a heading whose puck is done is an archived puck
      // drawn on a board that is hiding archived pucks. Measured on the live board: four
      // of six headings, none of them counted in the view's own 32.
      //
      // It is the same rule status grouping gets for free ("a column that still stands can
      // never be holding one back"): a group that still stands is one whose parent is live,
      // and then the mark is right — a live parent, its parts held back, said out loud.
      // Archive all the way up leaves with the archive, and the toggle brings it back.
      //
      // The count keeps it, and that is deliberate rather than an oversight. Such a puck
      // now has no heading at all, so it is one of the ones `No parent` is short of — and
      // it is the *only* thing that can draw a mark when a whole tree is archived and
      // nothing else is: uncounted, a board holding one dead parent and its parts would
      // have no eye anywhere, which is the blank-board failure `liftRoots`' `only` exists
      // to prevent. The cost is that this one returns as a heading rather than as a row
      // (measured: `No parent · 5 archived` gives back 4 rows and one tree), so the number
      // counts pucks held back and not rows added. That is what the mark says it counts.
      Object.keys(stubs).forEach(function (k) {
        var puck = itemById(k);
        if (puck && TERMINAL[puck.status]) delete stubs[k];
      });
      if (Object.keys(stubs).length) {
        var byKey = {};
        groups.forEach(function (grp) { byKey[grp.key] = grp; });
        // Walked in the archive's order so a stub lands in its own place — but only the
        // keys `stubs` named. Mapping the whole order synthesised a group for every key
        // that had merely fallen out of `groups`, count zero included: `repo:aurora` has
        // no cancelled puck at all and still drew `Cancelled · 0 archived`, a heading
        // pointing at nothing with an eye that would redraw the same page. The filter
        // was already written one line up; the map then walked the unfiltered list.
        groups = archived.order.filter(function (k) { return byKey[k] || stubs[k]; })
          .map(function (k) {
            return byKey[k] || { key: k, label: g.labelOf(k), items: [], archivedOnly: true };
          });
      }
    }
    // Nesting *is* what grouping by parent means, so it is not a switch anywhere: any
    // other grouping cuts across the trees (a tree spans statuses) and stays flat.
    var tree = roots ? listTree(groups, roots) : null;
    if (tree) groups = tree.sections;
    groups.forEach(function (grp) {
      // A flat list has no drop targets, so no empty headers — except one the archive
      // emptied, and, in the tree, a parent the filter emptied. Both are exactly the
      // thing that has to be said out loud.
      if (!grp.items.length && !grp.archivedOnly && !grp.emptyParent) return;
      var section = el("section", "list-group" + (tree ? " is-tree" : "") + (g.cls ? " " + g.cls(grp.key) : " col-plain"));
      if (g.tint && g.tint(grp.key)) section.style.setProperty("--tint", g.tint(grp.key));
      // A grouping with no values has nothing to name, so it draws no heading at all —
      // the rows *are* the answer, and a lone `All pucks` above them would be a label
      // that repeats the page. The archive is the one thing that still has to speak: its
      // rule is to say what it is holding back **in the head of the column short of it**,
      // and a group with no head is exactly the silence that rule was written to end. So
      // the head is drawn only when there is something to say, and carries only the mark
      // — no swatch (there is no column colour), no name, no fold control (there is no
      // second group to fold this one away from). Same shape as the archive-only stub one
      // branch down, minus the two parts that name a group.
      if (g.headless) {
        var bare = grp.archivedOnly
          ? archived.count[grp.key]
          : (archived ? (archived.count[grp.key] || 0) - grp.items.length : 0);
        if (bare > 0) {
          // `lh-bare` names the shape rather than carrying style of its own — the same way
          // `dp-row`/`dp-label` stayed on the markup when the layout switch became a
          // `.segmented`. It is the one heading with no `h2` in it, and reaching that from
          // CSS otherwise costs a `:not(:has(h2))` that says nothing about why.
          var bhead = el("div", "list-head lh-bare");
          var binner = el("div", "lh-inner");
          binner.appendChild(archivedMark(bare, grp.key, "this list"));
          bhead.appendChild(binner);
          section.appendChild(bhead);
        }
        grp.items.forEach(function (it) { section.appendChild(listRow(it)); });
        board.appendChild(section);
        return;
      }
      var shut = state.collapsed.has(grp.key);
      if (shut) section.classList.add("shut");
      // The heading is two boxes, and the inner one is why: a sticky box cannot be
      // offset inside a containing block it fills completely, so a full-width heading in
      // a scrolled row simply slid away to the left. `.lh-inner` is only as wide as its
      // own content, which gives `left: 0` the room it needs to pin.
      var head = el("div", "list-head");
      var inner = el("div", "lh-inner");
      head.appendChild(inner);
      // The heading stays a heading and the *button* goes inside it: `role="button"`
      // on the row would have made its contents presentational, and the list's group
      // headings would have dropped out of the heading map. The rollup badge stays
      // outside the button — it is the parent's number, not part of the control.
      var h = el("h2");
      // The casing follows the same rule as the board's: a head named after a puck
      // carries a title, not an eyebrow. Set *before* the `archivedOnly` branch, which
      // returns — a parent whose every child is archived is still a puck title, and it
      // is exactly the arbitrary-length case this rule exists for.
      //
      // What the list does not yet carry is the *opening*: its whole heading is already
      // the fold control, and splitting that in two is a change to a target used on a
      // phone rather than a rename.
      var opens = g.opens && g.opens(grp.key);
      if (opens) h.classList.add("named");
      // The heading names a puck, so it carries that puck's flag. In the tree a root
      // parent is drawn *only* as a heading — its row under `No parent` is exactly what
      // the promotion removes — so without this a `stale` or `rollup-open` on a
      // top-level parent vanished from the list while the puck was still on screen. The
      // ⚠ is the one badge nothing may hide: it says the puck's own claim is false.
      var warn = opens ? signalMessages(opens) : [];
      // A group the archive emptied has nothing to collapse and no visible count worth
      // printing — "Done 0 · 3 archived" says zero twice. So it is a plain heading, not
      // a control: swatch and label, and the mark carries both the number and the way
      // back. The chevron would promise rows that do not exist until the toggle lifts.
      if (grp.archivedOnly) {
        // `lh-stub` alone, never `lh-toggle` too: the shape is shared through the stylesheet's
        // selector list, so wearing the control's class here bought nothing but its cursor
        // and its hover. Correcting that from CSS is a fight over source order that this
        // lost three declarations in a row.
        var stub = el("span", "lh-stub");
        stub.appendChild(el("span", "swatch"));
        // The stub is deliberately not a control — there is nothing to expand until the
        // archive toggle lifts. The *name* is still a puck, though, and under a member
        // filter this heading can be that puck's only representation on the page, so it
        // keeps the one thing a name always does.
        stub.appendChild(opens ? openButton(opens, grp.label, "lh-label") : el("span", "lh-label", grp.label));
        h.appendChild(stub);
        inner.appendChild(h);
        if (warn.length) inner.appendChild(warnBadge(warn));
        inner.appendChild(archivedMark(archived.count[grp.key], grp.key));
        // The same badge, in the same order, as the heading below — this branch returns
        // before that line, so a stub was the one heading where `rollup` drew nothing and
        // the tick therefore said nothing. The number is the puck's own (`progress`, over
        // its children in the payload), not a count of the rows on screen, which is why it
        // is still true of a heading holding none.
        if (g.headExtra && propOn("rollup")) {
          var shx = g.headExtra(grp.key);
          if (shx) inner.appendChild(shx);
        }
        section.appendChild(head);
        board.appendChild(section);
        return;
      }
      // Two things to do, so two controls — but only where there *are* two. A heading
      // named after a puck folds its group and opens that puck; one named after a
      // category (`NOW`, a repo, a month) has nothing to open, and keeps the whole row
      // as one fold target rather than losing it to a split it has no use for.
      //
      // A <button> inside a <button> is invalid, which is why the label moves out
      // rather than gaining a nested one — the same constraint the archive mark and the
      // rollup badge already answer to, two lines below.
      var toggle = el("button", "lh-toggle" + (opens ? " lh-toggle--split" : ""));
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", shut ? "false" : "true");
      toggle.title = (shut ? "Expand " : "Collapse ") + grp.label;
      toggle.appendChild(icon(shut ? "chev-right" : "chev-down", "lh-caret"));
      toggle.appendChild(el("span", "swatch"));
      if (!opens) {
        toggle.appendChild(el("span", "lh-label", grp.label));
        if (propOn("count")) toggle.appendChild(el("span", "count", String(grp.items.length)));
      }
      toggle.setAttribute("data-fold", grp.key);
      toggle.addEventListener("click", function () { toggleGroup(grp.key, toggle); });
      h.appendChild(toggle);
      if (opens) {
        h.appendChild(openButton(opens, grp.label, "lh-label"));
        if (propOn("count")) h.appendChild(el("span", "count", String(grp.items.length)));
      }
      inner.appendChild(h);
      if (warn.length) inner.appendChild(warnBadge(warn));
      // Outside the toggle, for the reason stated above it: a <button> inside a <button>
      // is invalid, and this one has its own click.
      var held = archived ? (archived.count[grp.key] || 0) - grp.items.length : 0;
      if (held > 0) inner.appendChild(archivedMark(held, grp.key));
      // The heading's rollup badge is `rollup` — the same property the row's badge is, so
      // one tick governs both. The swatch and the archive mark are not properties: the
      // swatch is the repo colour (the heading's puck glyph) and the mark is a repair, the
      // same reason ⚠ is not in PROPS.
      if (g.headExtra && propOn("rollup")) { var hx = g.headExtra(grp.key); if (hx) inner.appendChild(hx); }
      section.appendChild(head);
      if (!shut) {
        if (tree) renderNodes(section, grp.items, 0, tree, archived);
        else grp.items.forEach(function (it) { section.appendChild(listRow(it)); });
        // (3) at the top level. Only when the archive is not already answering for it:
        // the mark beside the heading says both what is missing and how to get it back,
        // and "no parts match" would be a second, false explanation for the same hole.
        if (tree && !grp.items.length && held <= 0) section.appendChild(emptyNode(0));
      }
      board.appendChild(section);
    });
  }

  // A puck's parts, directly beneath it, one indent further in. Recursive, and safe to
  // be: `parent-cycle` is cut at harvest, so `children` describes a forest — the same
  // guarantee the rollup walk leans on.
  //
  // The row carries no count of its own. `progress` is already on it and answers a
  // steadier question — how many parts the puck *has* — while a count of the rows below
  // would change with the filter and read as though the puck had lost parts.
  function renderNodes(section, items, depth, tree, archived) {
    items.forEach(function (it) {
      var kids = tree.byKey[it.id];
      var open = !!(kids && kids.items.length);
      var shut = state.collapsed.has(it.id);
      section.appendChild(listRow(it, { depth: depth, fold: open ? (shut ? "shut" : "open") : null }));
      if (open && !shut) renderNodes(section, kids.items, depth + 1, tree, archived);
      // A folded puck says nothing about parts it is deliberately hiding — but only when
      // there was something to fold. A stale fold (collapsed, then a filter took every
      // part) leaves a row with no caret to clear it, so `shut` alone suppressed both
      // lines and left the puck reading as a leaf with no way back.
      if (open && shut) return;
      // What is missing from under this puck, and why — on a line of its own rather than
      // as a badge on the row. Measured on a phone: the row already carries a rollup, a
      // priority, a flag and a date, and an `N archived 👁` badge beside them took the
      // title down to two characters. A line reads as a sentence and costs the row
      // nothing.
      var held = archived ? (archived.count[it.id] || 0) - (kids ? kids.items.length : 0) : 0;
      if (held > 0) section.appendChild(archivedNode(depth + 1, held, it.id));
      else if (!open && (it.children || []).length) section.appendChild(emptyNode(depth + 1));
    });
  }
  // A parent with parts and nothing under it is the one place the tree can lie by
  // omission: it draws exactly like a leaf. So it says so, on a line of its own, at the
  // depth its parts would have had.
  function emptyNode(depth) {
    var e = el("div", "list-empty", "No matching parts");
    if (depth) e.style.setProperty("--depth", String(depth));
    return e;
  }
  // The archive's version of that line. Same shape, and the same repair the heading's
  // mark and the board's tray offer — `liftArchive()` is still the one writer.
  function archivedNode(depth, n, key) {
    var b = el("button", "list-empty list-archived");
    b.type = "button";
    b.title = "Show " + n + " archived " + (n === 1 ? "part" : "parts");
    b.appendChild(el("span", null, n + " archived " + (n === 1 ? "part" : "parts")));
    b.appendChild(icon("eye"));
    if (depth) b.style.setProperty("--depth", String(depth));
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      state.collapsed.delete(key);
      liftArchive();
      renderBoard();
    });
    return b;
  }

  // Client-side sort. "default" is the *manual* order — it mirrors the harvester
  // (manual `order` first, then freshest `updated`, then title) and is labelled
  // "Manual" in the menu; "updated-desc" is the same freshness sort without `order`,
  // for when the hand-ranking should step aside. Every explicit mode drops `order`
  // since the choice is deliberate.
  // Sort by a nullable date field, always pushing items that lack it to the end.
  // dir: 1 = oldest first (ascending), -1 = newest first (descending).
  function byDate(field, dir) {
    return function (a, b) {
      var av = a[field], bv = b[field];
      // 0 rather than a title comparison when the dates match: a key that settles its own
      // ties can never be first in a chain, since nothing behind it would be reached.
      if (av && bv) return dir === 1 ? av.localeCompare(bv) : bv.localeCompare(av);
      if (av) return -1;
      if (bv) return 1;
      return 0;
    };
  }

  // ── the ordering is a chain ──────────────────────────────────────────────────
  // `sort` is a list of keys — `sort=priority,target,updated-desc` — walked in order until
  // one of them answers. Manual rank is therefore **a key among the others** rather than a
  // mode that excludes them, which is the whole complaint: `order:` felt clumsy not because
  // it is the wrong idea but because it was the *default and the only one*, so choosing any
  // real field meant throwing the hand-placed positions away.
  //
  // Nothing is scrapped by this. `order:` stays a valid convention in every source repo; it
  // stops being the thing you cannot combine with anything.
  //
  // Each key answers about **itself alone** and returns 0 for "these two are equal on me" —
  // the chain is the tiebreak. That is the one structural change: `byDate` used to close
  // with `title` itself, and a key that settles ties privately can never be first in a
  // chain, because the keys behind it would never be reached.
  // The catalogue is **fields**, and direction is a property of the key rather than part
  // of its name. It used to be nine entries, which encoded three date fields × two
  // directions as separate keys and baked the direction into the label of the other four
  // (`Priority (high→low)`, `Title A–Z`). So `Recently updated` and `Oldest updated` were
  // two catalogue rows for one question, while `Priority low→high` and `Title Z–A` could
  // not be asked at all. Seven fields with a direction each says the same things and four
  // more besides.
  //
  // The two direction labels are the *values*, not "ascending"/"descending": those words
  // are already what the old key names said, and moving them from the name to a control is
  // the whole change. `asc`/`desc` stay the spelling in the URL, where they mean the
  // literal order of the underlying value.
  var SORT_FIELDS = {
    // `order` is the one field with no direction, and the reason is not symmetry: reversing
    // it would silently switch **dragging** off, since `manualRank()` asks for the exact key
    // `order` at the head of the chain. A control whose only visible effect is to disable a
    // different control is worse than a missing one. And "manual, backwards" is not a second
    // opinion about the rank — the rank *is* the order you put them in.
    order: { label: "Manual", def: "asc",
      rank: function (i) { return i.order == null ? null : i.order; } },
    status: { label: "Status", def: "asc", asc: "now → done", desc: "done → now",
      rank: function (i) {
        // `statusRank` answers Infinity for a status the payload does not name, and that
        // sentinel must not reach the comparator — see `sortCmp`.
        var r = statusRank(i.status);
        return r === Infinity ? null : r;
      } },
    priority: { label: "Priority", def: "asc", asc: "high → low", desc: "low → high",
      rank: function (i) {
        var r = i.priority ? PRIORITY_RANK[i.priority] : null;
        return r == null ? null : r;
      } },
    target: { label: "Target", def: "asc", asc: "soonest → latest", desc: "latest → soonest",
      date: "target" },
    updated: { label: "Updated", def: "desc", asc: "oldest → newest", desc: "newest → oldest",
      date: "updated" },
    created: { label: "Created", def: "desc", asc: "oldest → newest", desc: "newest → oldest",
      date: "created" },
    title: { label: "Title", def: "asc", asc: "A → Z", desc: "Z → A",
      text: function (i) { return i.title; } },
  };
  var SORT_ORDER = Object.keys(SORT_FIELDS); // the catalogue's order, which the picker keeps
  // A key is a field, optionally suffixed with its direction. The suffix is written only
  // when the direction is *not* the field's default, so the shortest spelling is the
  // ordinary one and today's `order`, `status`, `priority`, `target` and `title` are
  // unchanged. `updated-desc` and `created-desc` shorten to `updated`/`created`, which is
  // the same key by another name — they parse identically, so a link that carries the long
  // form still draws the board it always drew.
  function sortField(k) { return k.replace(/-(asc|desc)$/, ""); }
  // Both labels or neither: a field that names its two directions can be turned, one that
  // does not cannot. The suffix is then not merely unused but *ignored* — `order-desc` reads
  // back as `order`, so a hand-written link cannot ask for a board the menu has no control
  // for, nor switch dragging off from the address bar.
  function reversible(field) { return !!SORT_FIELDS[field].asc; }
  function sortDir(k) {
    var f = sortField(k), m = /-(asc|desc)$/.exec(k);
    return m && reversible(f) ? m[1] : SORT_FIELDS[f].def;
  }
  function sortKeyName(field, dir) {
    return reversible(field) && dir !== SORT_FIELDS[field].def ? field + "-" + dir : field;
  }
  // Each key answers about **itself alone** and returns 0 for "these two are equal on me" —
  // the chain is the tiebreak. `byDate` already took a direction; the ranked and textual
  // fields get theirs the same way, by a sign on the answer rather than a second entry in
  // the catalogue.
  //
  // **A puck with no value for the field goes last in *both* directions**, which is the one
  // thing a plain sign cannot express — and `byDate` has said so all along, pushing undated
  // pucks to the end whichever way the dates run. A missing value is not the far end of the
  // scale, it is outside the scale: reversing `high → low` must not promote "no priority" to
  // the top, and `status-desc` must not lead with a status the payload does not name (which
  // `statusRank` deliberately ranks last). Measured before the guard, with the sentinel rank
  // carried through the sign: `priority-desc` put the unprioritised puck first, ahead of Low,
  // under a control whose own label promised "low → high". `rank` therefore answers `null`
  // for absent rather than a sentinel number, so absence cannot be compared by accident.
  function sortCmp(k) {
    var f = SORT_FIELDS[sortField(k)], sign = sortDir(k) === "desc" ? -1 : 1;
    if (f.date) return byDate(f.date, sign);
    if (f.text) return function (a, b) { return sign * f.text(a).localeCompare(f.text(b)); };
    return function (a, b) {
      var ra = f.rank(a), rb = f.rank(b);
      if (ra == null || rb == null) return ra == null && rb == null ? 0 : (ra == null ? 1 : -1);
      return ra === rb ? 0 : (ra < rb ? -sign : sign);
    };
  }
  // The board as it shipped, written out. `sort=default` *was* "order first, then updated",
  // so the migration is to say so — and saying so is what lets you move `order` down the
  // chain or drop it, which was impossible while it was spelled as one word.
  var DEFAULT_SORT = "order,updated";
  // `default` is the only word that expands, and round-tripping is why. Three of the nine
  // old modes were chains written as one word — `priority` was "priority then updated",
  // `status` was "status then order" — but those two words are also *field names*, so
  // expanding them means the chain `priority` can never be written down: the menu removes
  // `updated`, serializes `priority`, and the next read puts it straight back. A control
  // that silently undoes itself is worse than a tiebreak that moved, so those two are read
  // as the fields they name and their old second key becomes `title`, the chain's own
  // ending. `default` is the only one of the three that is not a field, so it is the only
  // one that can expand without eating a spelling.
  //
  // The alternative was measured and rejected: keep all three expansions and give the one-key
  // chain an unambiguous spelling (`priority,title`). It works, at the price of a spelling
  // nobody needs and a second rule about which `✕` may be drawn.
  //
  // It was rejected on the premise that the compatibility had no instance, and **that premise
  // was wrong** — twice over. A doc did name the old meaning, and, the one that mattered, the
  // released menu wrote these words into `roadmap-display` as whole values. So the
  // compatibility is real and lives in `upgradeStoredSort` instead: a migration runs once and
  // then the grammar here is clean, whereas an expansion in this map is forever and takes the
  // one-key chain's spelling with it. Before concluding that nothing reads a value, ask what
  // the *running app* writes — searching the repo answered no twice, and was wrong twice.
  var LEGACY_SORT = { default: DEFAULT_SORT };
  // The keys a value actually names — **possibly none**, which is the whole reason this is
  // split out from `parseSort`. A reader that always hands back a chain cannot tell "this
  // said nothing I understand" from "this said the default", and the two are different
  // answers now that the absence of a choice is its own state.
  function parseSortKeys(v) {
    var raw = String(v == null ? "" : v).trim();
    if (LEGACY_SORT[raw]) raw = LEGACY_SORT[raw];
    var out = [], seen = {};
    raw.split(",").forEach(function (k) {
      k = k.trim();
      var f = sortField(k);
      // A name this board does not know is dropped rather than kept as an inert string —
      // same as `parseProps`, and for the same reason: a stored chain from a newer board
      // must not compare unequal to the one actually being drawn. And one key per *field*,
      // since `updated,updated-asc` is two answers to one question and the second could
      // never be reached anyway.
      if (!SORT_FIELDS[f] || seen[f]) return;
      seen[f] = 1;
      out.push(sortKeyName(f, sortDir(k)));
    });
    return out;
  }
  // The chain to *draw*, which always exists: the comparator has to be handed something.
  // An unreadable value therefore reads as the default here — and the callers that decide
  // whether a **choice** was made ask `parseSortKeys` instead, or an unknown key would be
  // promoted to one. Caught by a reviewer, and the rule was already written one key over:
  // "a name the board does not know falls back to *no* choice rather than the empty one".
  // Measured before the split: `?group=none&sort=futureField` drew `order,updated` — manual
  // rank across status boundaries, the exact ordering the proposal exists to prevent — and
  // rewrote the URL to claim it, while the same link with no `sort` at all drew the
  // proposal.
  function parseSort(v) {
    var out = parseSortKeys(v);
    return out.length ? out : parseSortKeys(DEFAULT_SORT);
  }
  // In the chain's *own* order, not the catalogue's: the order is the meaning here, unlike
  // `props`, where the set is what matters and a stable spelling is all that is wanted.
  function serializeSort(keys) { return keys.join(","); }
  // The chain the board is actually drawing — the chosen one, except where the grouping
  // proposes its own and nothing has been chosen. Same rule as `autoDateField` one storey
  // down: **automation applies in the absence of a choice, never over one.** The absence is
  // `state.sort == null`, its own value rather than a string that could also be chosen —
  // `props` draws the same distinction, and skipping it here made `order,updated` unaskable
  // under any grouping with a proposal.
  //
  // One function rather than a branch per consumer, because the *menu* reads it too: a
  // menu showing a chain the board is not drawing is the failure the last key's missing
  // `✕` exists to prevent, and a proposal the chooser could not see would be that same
  // failure one storey up. Turn any knob on it and the proposal becomes a choice — the
  // same bargain `rememberDisplay` strikes with a link you only looked at.
  // `k` är valfritt: `effectiveParams` normaliserar ett *främmande* params-objekt — en
  // sparad vy vars gruppering inte är brädans — och måste fråga om den grupperingen, inte
  // om den man råkar stå i. Utan argumentet är det den man står i.
  function proposedSort(k) {
    var g = GROUPS[k || effectiveGroup()];
    return (g && g.sort) || DEFAULT_SORT;
  }
  function sortChain() {
    return parseSort(state.sort == null ? proposedSort() : state.sort);
  }
  // Whether the ordering differs from what the board would draw with no choice at all.
  // **Three surfaces ask it** — the URL writer, the Display dot and `Reset ordering` — and
  // one of them asking a slightly different question is exactly how the dot came to stay
  // lit on a board whose URL and whose own submenu both said it was at its default: flip a
  // direction and flip it back, and `state.sort` holds the string `order,updated` while the
  // key's default is `null`, so an identity test against `DISPLAY_DEFAULTS` answered yes
  // forever. Measured on the default board: URL `""`, `Reset ordering` gone, dot on.
  //
  // It asks about the *drawn* chain rather than the stored string, which is the same shape
  // as `propShown` one section down — and deliberately **not** by normalizing a chosen
  // chain back to `null` at write time. That would be one writer too, and it would throw
  // the choice away: an explicit `order,updated` picked under `group=status` has to survive
  // a switch to `group=none`, where the proposal differs. Automation applies in the absence
  // of a choice, never over one — normalizing would erase the absence's opposite.
  function sortChosen() { return serializeSort(sortChain()) !== proposedSort(); }
  // A chain equal to what the grouping proposes is not a distinguishable state. Nothing on
  // screen separates it from having chosen nothing, the link cannot carry it (the URL is
  // written from `sortChosen()`, and the board's older rule that the default chain is never
  // written down has three checks behind it), and a saved view normalizes it away. Kept as
  // a choice anyway, it survived in memory but not through a reload — so the *same link*
  // and the *same click* gave two boards: `?group=none&sort=status,order` then Grouping →
  // Status gave `sort=status,order` live and `order,updated` after F5.
  //
  // That is the exact failure `state`'s own comment at the top of this file was written
  // about — "the same URL drew two different chromes depending on whether you clicked or
  // reloaded" — and the cure there was the same: stop keeping the state that cannot be
  // told apart. So a proposal-equal chain collapses to "no choice" the moment it is set,
  // not one reload later.
  //
  // It costs the reading that an explicit `order,updated` picked under `group=status`
  // travels to `group=none` as itself. That reading was defended here and it was wrong:
  // it only ever held until a refresh, which is not a behaviour but a race with the
  // browser.
  function normalizeSort() {
    if (state.sort != null && state.sort === proposedSort()) state.sort = null;
  }
  function sortComparator() {
    var chain = sortChain().map(sortCmp);
    return function (a, b) {
      for (var i = 0; i < chain.length; i++) {
        var n = chain[i](a, b);
        if (n) return n;
      }
      // `title` closes every chain, whether or not it is in it. Two pucks equal on every
      // chosen key still have to land in a stable order, or the list reshuffles itself on
      // every render for no reason the reader can see.
      return a.title.localeCompare(b.title);
    };
  }

  function renderBoard() {
    // Back to the plain default board is *leaving* the view, and it has to be written
    // down rather than hidden at read time. `editedSavedView()` merely declined to
    // answer, so the name stayed set: remove a view's last chip and add any other
    // filter, and the view you had already walked out of came back as "(edited)" with
    // an Update offering to overwrite it with the new filter. Every mutation ends in a
    // render, so this is where the transition can be seen at all.
    if (state.fromView && !Object.keys(viewParamObject()).length) state.fromView = null;
    // Emptying a scrollport's tall child *would* clamp its offsets to the origin — but the
    // clamp happens at layout, and nothing between here and the appends below reads
    // geometry, so the board is never measured while it is empty. That is what keeps an
    // async redraw (`loadWritableRepos` resolving under a scrolled list) from throwing the
    // reader back to the top. Measured with a forced reflow inserted in this gap: 150/200
    // → 0/0. So: no `getBoundingClientRect`, `offsetHeight` or `scrollHeight` between the
    // clear and the fill. `tests/chrome.test.mjs` holds the guarantee.
    // A glide still running would carry on moving whatever replaces the list it belonged to.
    stopGlide();
    // The paragraph above holds for boxes that *survive* the clear, and the columns do not:
    // each `.cards` is the board's vertical scrollport now and `innerHTML = ""` takes it
    // with the rest. So the reader's place is read out first, by column key, and put back
    // after the fill — Codex found this (#54), and the case is the very one the paragraph
    // names: `loadWritableRepos` resolving on a signed-in board redraws identical content
    // and would have returned a reader partway down a column to its top.
    //
    // Reading `scrollTop` here is safe: it is before the clear, not inside the gap the rule
    // is about. Restoring happens after the appends, outside it too.
    // The grouping the *existing* columns were drawn under, read off the board rather than
    // from `state`: by the time this runs `effectiveGroup()` already answers with the new
    // one, so asking it would compare a board to itself. Codex found what that costs (#54):
    // `NO_VALUE` is the empty bucket for agent, priority, target and parent alike, so
    // scrolling `Unrouted` and switching to Priority restored that offset into
    // `No priority` — a column with nothing to do with it. The comment here used to claim a
    // grouping change "simply matches nothing", and that was true of every key except the
    // one they share.
    colPlacesGroup = board.dataset.group || null;
    colPlaces = {};
    Array.prototype.forEach.call(board.querySelectorAll(".cards[data-col]"), function (k) {
      if (k.scrollTop) colPlaces[k.dataset.col] = k.scrollTop;
    });
    // And which column the keyboard was standing in. Restoring the *offset* is only half of
    // it: the node is replaced, so focus falls back to the document and Page Down then moves
    // nothing at all — measured, focus on `.cards[data-col=now]` and its place both held at
    // 120, and Page Down gave 120 → 120. That is a regression from per-column scroll; while
    // `.work` was the one port it was a stable target that no redraw touched. Codex found it
    // (#54). Same idiom the board already uses twice: `segmented()` puts the pressed segment
    // back after a rebuild, and `toggleGroup` finds its control again by `data-fold`.
    colFocus = null;
    var aktiv = document.activeElement;
    if (aktiv && aktiv.dataset && aktiv.dataset.col && board.contains(aktiv)) colFocus = aktiv.dataset.col;
    board.innerHTML = "";
    // The layout is whatever the toggle says — in every view.
    //
    // Ready and Inbox used to be forced to the list "whatever the toggle says",
    // on the grounds that a focused queue reads better as one. Two things were
    // wrong with that. The premise only holds under *status* grouping, where Inbox
    // is one column and Ready is two — group by repo or agent and those views have
    // as many columns as any other. And the override was silent: Display went on
    // showing Board as the selected layout, so the control claimed a choice that
    // never took effect. (It also let the board-only "Show empty columns" row
    // appear over a list.) A view that reads better as a list is a reason to pick
    // List — and that choice persists — not a reason to overrule the person who
    // picked Board.
    var layout = state.view;
    trayColumns = null; // set again by the tray, if this render draws one
    board.classList.toggle("as-list", layout === "list");
    // The class is what decides which box is the port, so the marks that belong to the
    // port move with it — here rather than only in `openDetail`/`closeDetail`, because
    // the layout switches without a puck ever being opened.
    markPort();
    relockScroll();
    // On the board rather than on each row: one write for the whole list, and the rows
    // inherit it. Written on every render because the set can change without the rows
    // changing at all — ticking a property off is a redraw of the same pucks.
    applyListTracks(board);
    activeQuery = activeTerms();
    var visible = DATA.items.filter(matches).sort(sortComparator());
    var groups = groupsOf(visible);

    if (layout === "list") renderList(groups);
    else renderColumns(groups);

    var shown = visible.length;
    updateViewHeader(shown);
    renderChips();
    buildSavedViews(); // its "active" state tracks the board, like the view rows
    refreshDisplayDot();
    writeUrl(); // every render reflects the view into the URL, so it stays shareable
    // The footer says where the data came from, not what the view is showing: the
    // count of the current view is already in the view header and the sidebar, and
    // a third copy under the fold was the only one that could go stale (it stayed
    // put, reading "1 of 145 shown", while a puck page covered the board).
    // Two nodes, not one string, and the date is the reason. A browser takes a hyphen as
    // a break opportunity, so in the sidebar's 240px column `2026-08-16` broke after the
    // month and left `16 18:29 UTC` starting the next line — a date split across two rows
    // reads as two numbers. The count may wrap; the stamp may not.
    //
    // No trailing separator any more either: this is its own line, with the links on the
    // next. Inline in the board's footer it had to hand over to whatever came after it.
    var fm = document.getElementById("footmeta");
    fm.textContent = "";
    fm.appendChild(el("span", null, DATA.total + " pucks · generated "));
    // Only the date is unbreakable, and that is the whole of the fix. Wrapping the entire
    // stamp in `nowrap` stopped `2026-08-16` breaking after the month — a date split across
    // two rows reads as two numbers — but made the 29-character run itself unbreakable, and
    // the sidebar can be dragged to 190px (`MIN` in `initSidebarResize`). Measured before:
    // 41px of horizontal overflow on a box whose whole job is to scroll vertically, with
    // the stamp 40px past the edge — and 3px of it already at the default 240. Codex found
    // it (#54). The words around the date may wrap; the digits and hyphens may not.
    fm.appendChild(el("span", "fm-stamp", DATA.generatedAt.slice(0, 10)));
    fm.appendChild(el("span", null, " " + DATA.generatedAt.slice(11, 16) + " UTC"));
  }

  // Which status groups the current view shows. Inbox is its own space, so it's
  // absent from every board view except the Inbox view itself.
  // Parameterised, defaulting to the live board: `effectiveParams` has to ask the same
  // question about a *stored* view, whose focus is not the one you are standing in.
  function columnsForFocus(focus, showDone) {
    if (focus == null) focus = state.focus;
    if (showDone == null) showDone = state.showDone;
    if (focus === "inbox") return ["inbox"];
    if (focus === "ready") return ["now", "next"];
    if (focus === "attention") return DATA.statuses; // flagged can be any status
    // A parent is any puck that holds others, so it can sit anywhere — including
    // inbox, which the committed board hides. Without this the sidebar counted one
    // and the board showed none, which is exactly the drift viewCounts exists to
    // prevent. Done still follows the toggle.
    if (focus === "parents") {
      return DATA.statuses.filter(function (s) { return !TERMINAL[s] || showDone; });
    }
    // "all" = the committed board: now/next/later (+done/cancelled when shown), never inbox.
    return DATA.statuses.filter(function (s) {
      return s !== "inbox" && (!TERMINAL[s] || showDone);
    });
  }

  // The consistent view-header reflects the current focus + how many are shown.
  var VIEW_TITLES = {
    all: "All pucks", ready: "Ready to take", inbox: "Inbox",
    parents: "Parents", standalone: "Standalone", attention: "Needs attention",
  };
  function repoNameOf(repo) {
    for (var i = 0; i < DATA.sources.length; i++) if (DATA.sources[i].repo === repo) return DATA.sources[i].name;
    return repo.split("/").pop();
  }
  // The active scope (repo/discipline/agent/priority filters) as human labels, so
  // the view header reflects "you're in a filtered view" — not just a smaller count.
  function scopeParts() {
    var p = [];
    placeValues("repo").forEach(function (r) { p.push(repoNameOf(resolveRepo(r) || r)); });
    placeValues("agent").forEach(function (a) { p.push("→ " + agentLabel(a)); });
    return p;
  }
  // The full view title, place scope included ("Inbox · Parent") — the single
  // source for both the view header and the detail breadcrumb's back label, so a
  // place-scoped view reads the same whether or not a puck is open.
  function currentViewTitle() {
    // A saved view first, because it is the most specific true name for where you
    // are. `activeSavedView()` only answers when the board matches the view
    // *exactly* — every one of VIEW_KEYS — so its name already covers the whole
    // tuple: the query, the grouping, the layout, and any place inside it. There is
    // nothing layered on top to append. Change one thing and the match breaks, and
    // the composition below takes over again.
    // Without this the header said "All pucks" while the sidebar lit "High" and the
    // chip row listed its predicates: three pieces of chrome, two different answers
    // to "where am I". #17 made the right *row* light; the title never asked.
    var saved = activeSavedView();
    if (saved) return saved.name;
    // Still in the view, with changes on top. Without this the header read "All pucks"
    // while the chip row offered `Update "Allt nu"` — the same split brain, one step
    // milder: two pieces of chrome disagreeing about which view you are in.
    var edited = editedSavedView();
    if (edited) return edited.name + " (edited)";
    var base = VIEW_TITLES[state.focus] || "All pucks";
    var scope = scopeParts();
    if (!scope.length) return base;
    // "All pucks" is the default view — when you've navigated into a place (a repo
    // or agent) the place *is* the context, so lead with it instead of prefixing
    // the redundant "All pucks ·". A tag/priority *filter* is a refinement, not a
    // place, so it keeps the view name ("All pucks · #ui"). Named views too.
    if (state.focus === "all" && placeActive()) return scope.join(", ");
    return base + " · " + scope.join(", ");
  }
  function updateViewHeader(shown) {
    var title = currentViewTitle();
    var count = shown != null ? String(shown) : "";
    // Desktop: title lives in the view-header. Mobile: in the topbar (fills the
    // otherwise-empty band between the menu and search). CSS shows one per width.
    ["viewTitle", "topTitle"].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = title; });
    ["viewCount", "topCount"].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = count; });
  }

  // ── filter chips ──
  // What a *place* is worth: clicking a repo or a discipline goes through
  // goToPlace, which resets to the All-pucks board — so the chip's number has to be
  // counted with that view's query, not with the source's grand total. The old
  // number came straight from the harvester and counted the archive too, so "PIA
  // 52" landed you on six cards. Same rule the views already hold themselves to.
  // Archive-aware for the same reason the view counts are: a repo click used to keep
  // `state.showDone`, so with the toggle on it showed its landed cards while the chip's
  // number excluded them. A place counts what its click shows.
  //
  // What it shows is now `all`'s memory, not the live value — a place is not a view of
  // its own, it is `all` with a filter, and `goToPlace` restores `all` accordingly. Read
  // from the board you are standing in, a repo row inside Inbox counted against Inbox's
  // archive setting and landed on All pucks'.
  // Siffran är vad klicket visar — och ett klick på ett repo behåller en aktiv
  // disciplinkö (goToPlace byter bara den dimension man klickade i). Så varje
  // dimension räknas *inuti* den andra: annars kunde ett repo säga 20 och landa på
  // de 3 som är routade till den valda disciplinen.
  function placeCounts() {
    var base = parseQuery(VIEWS.all).concat(willShowDone("all") ? [] : [NOT_DONE]);
    // The *other* active place, read out of the query rather than hand-built: one
    // producer for what a place term looks like, so the two can't drift.
    function withOthers(skip) {
      return base.concat(parseQuery(state.query).filter(function (t) {
        return !t.neg && t.field !== skip && PLACE_FIELDS_ORDER.indexOf(t.field) !== -1;
      }));
    }
    var repoQ = withOthers("repo"), agentQ = withOthers("agent");
    var repo = {}, agent = {};
    DATA.items.forEach(function (it) {
      if (runQuery(it, repoQ)) repo[it.repo] = (repo[it.repo] || 0) + 1;
      if (it.agent && runQuery(it, agentQ)) agent[it.agent] = (agent[it.agent] || 0) + 1;
    });
    return { repo: repo, agent: agent };
  }

  function buildRepoChips() {
    var wrap = document.getElementById("repoFilters");
    if (!wrap) return;
    wrap.innerHTML = ""; // idempotent — refreshNav rebuilds this on every nav change
    var live = placeCounts().repo;
    DATA.sources.forEach(function (s) {
      var chip = el("button", "chip repo");
      chip.dataset.repo = s.repo;
      chip.setAttribute("aria-pressed", placeValues("repo").indexOf(lower(s.repo)) !== -1 ? "true" : "false");
      var dot = el("span", "dot");
      dot.style.background = s.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(s.name));
      // A repo is a permanent place, so its zero is worth showing — unlike a view,
      // which hides its count when empty because an empty view is not navigation.
      var n = el("span", "n", String(live[s.repo] || 0));
      chip.appendChild(n);
      chip.title = s.blurb + (s.native ? "" : " — adapted from " + s.adapter);
      chip.addEventListener("click", function () { goToPlace("repo", s.repo); });
      wrap.appendChild(chip);
    });
  }

  // PO-console: discipline queues in the sidebar. Each routed discipline becomes a
  // filter chip with a count. Rebuilt on every route so counts stay live; the whole
  // section hides when nothing is routed yet. This IS the queue — pucks with an
  // `agent:`, read from git — not a separate scheduler.
  function buildAgentChips() {
    var wrap = document.getElementById("agentFilters");
    var section = document.getElementById("agentSection");
    if (!wrap) return;
    wrap.innerHTML = "";
    // The queue is live work, not history: a discipline whose pucks have all landed
    // has an empty queue, and the same count-is-what-you-land-on rule applies.
    var counts = placeCounts().agent;
    // No pruning any more. A discipline whose pucks have all landed used to be quietly
    // deleted out of `state.agents`, because a *place* that names nothing is a place you
    // are stranded in. As a term it is just a filter that matches nothing — visible in
    // the URL, removable, and honest about why the board is empty.
    var agents = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    if (section) section.hidden = agents.length === 0;
    agents.forEach(function (a) {
      var chip = el("button", "chip agent");
      chip.dataset.agent = a;
      chip.setAttribute("aria-pressed", placeValues("agent").indexOf(lower(a)) !== -1 ? "true" : "false");
      chip.appendChild(icon("agent", "agent-glyph"));
      chip.appendChild(document.createTextNode(agentLabel(a)));
      chip.appendChild(el("span", "n", String(counts[a])));
      chip.addEventListener("click", function () { goToPlace("agent", a); });
      wrap.appendChild(chip);
    });
  }

  function toggleSet(set, key, chip) {
    if (set.has(key)) { set.delete(key); chip.setAttribute("aria-pressed", "false"); }
    else { set.add(key); chip.setAttribute("aria-pressed", "true"); }
  }

  // Sidebar repos/agents are single-select within their own dimension (radio, not
  // checkbox). Clicking a repo scopes to exactly that repo; clicking the one that is
  // already the sole scope clears it (back to All pucks). Repo and agent stay
  // orthogonal, so "Backend, within Parent" still composes — they are two fields, and
  // the query ANDs them for free. The same three behaviours the Set version had, said
  // as a term operation: the radio, the toggle-off, and the replace.
  // `keep` is the difference between a *place you are standing in* and a *destination*.
  // A sidebar row is the first: pressing the one you are already in clears it, which is
  // how you get back to All pucks. A value in a puck's rail is the second — it says
  // "show me this repo's pucks", and from a board already scoped to that repo the toggle
  // answered by showing every repo instead, which is the opposite of what the row reads
  // as. Same writer, one flag, so the question "am I already here?" is still asked in
  // exactly one place.
  function pickScope(field, key, keep) {
    var vals = placeValues(field);
    var wasSole = vals.length === 1 && vals[0] === lower(key);
    var rest = parseQuery(state.query).filter(function (t) { return !sameField(t, field, false); });
    if (!wasSole || keep) rest.push({ field: field, op: "in", values: [key], neg: false });
    setQueryTerms(rest);
  }
  // A place is active → the sidebar is "in" that place, not in a view.
  function placeActive() {
    return PLACE_FIELDS_ORDER.some(function (f) { return placeValues(f).length > 0; });
  }
  // Rebuild the whole sidebar nav so views + repo + agent pressed states stay in
  // sync after any navigation (they're one mutually-exclusive dimension now).
  function refreshNav() {
    var host = document.getElementById("sideViews") || document.getElementById("filters");
    if (host) { host.innerHTML = ""; buildFocusControl(); }
    buildSavedViews();
    buildRepoChips();
    buildAgentChips();
  }
  // Go to a view: clear any place so the view is global ("pure"), not still scoped
  // to the repo/agent you were last in.
  function goToView(key) {
    closeSurfaces(); // same as openDetail: the palette gets here without a hash change
    exitPuckView();
    state.focus = key;
    // Navigation is a fresh start. Clearing only the *places* left the rest of the
    // filter riding along: apply a saved view called High, click Ready, and you were in
    // "Ready, still only high priority" — with the chip the one thing saying so. A saved
    // view is a complete description of the board (`applySavedView` resets everything),
    // so leaving one has to leave all of it, or the rows in the sidebar stop meaning
    // what they say. A refinement is something you add *after* arriving.
    //
    // The display is that same sentence one storey up, and for a while it was the half
    // still riding along: `state.group`, `state.sort`, `state.props` and the folds
    // followed you into every view, so a grouping chosen in All pucks regrouped Ready.
    // They belong to the view they were set in — so this does not merely clear them, it
    // puts back what *this* view was left in. See `restoreDisplay`.
    state.fromView = null; // you have left the view, not modified it
    restoreDisplay(key);
    setQueryTerms([]);
    refreshNav();
    renderBoard();
    maybeCloseMenu();
  }
  // Go to a place: single-select it and reset to its whole board (focus "all"), so a
  // place always shows the same thing regardless of the view you came from.
  // `keep` — see `pickScope`: a sidebar row toggles off when you press the place you
  // are already in, a rail value never does, because it names a destination.
  function goToPlace(field, key, keep) {
    closeSurfaces(); // same as goToView — the board changes under whatever is open
    exitPuckView();
    state.focus = "all";
    // Read the toggle *before* anything is cleared. `pickScope` answers "did you click
    // the row you are already in?" from the query, so wiping the query first made the
    // question unanswerable and the row could never be switched off again — it just
    // re-added itself. Captured here, the radio, the toggle-off and the replace all
    // survive a navigation that also drops the refinement.
    // Navigation, so the provenance goes too — same reason `goToView` drops it.
    // `scopeToPlace` below deliberately does not: that one is a refinement made from
    // inside the board, which is exactly the "you changed the view" case.
    state.fromView = null;
    // And the display with it, for the same reason and by the same key: this navigation
    // sets `focus` to "all" one line up, and `state.focus` is what the memory is keyed
    // by. A repo gets no memory of its own — that is one per repo, more than anyone
    // asked for — it lands on the `all` view, so it restores the `all` view.
    restoreDisplay("all");
    var vals = placeValues(field);
    var wasSole = vals.length === 1 && vals[0] === lower(key);
    // What a place navigation drops: the *refinement* — the tag, the text, the priority
    // you had on top. What it keeps: the other place. The two dimensions are orthogonal
    // on purpose ("Backend, within Parent" composes), and the sidebar counts each one
    // *inside* the other — so clearing the agent while landing on a repo would make
    // every repo number a promise the click immediately breaks.
    var rest = parseQuery(state.query).filter(function (t) {
      return !t.neg && t.field !== field && PLACE_FIELDS_ORDER.indexOf(t.field) !== -1;
    });
    if (!wasSole || keep) rest.push({ field: field, op: "in", values: [key], neg: false });
    setQueryTerms(rest);
    refreshNav();
    renderBoard();
    maybeCloseMenu();
  }
  // Narrow to a place *without* disturbing the rest of the filter, and without leaving
  // the view you are in. This is what the column menu's "Show only this" wants: it is a
  // refinement made from inside the board, not navigation from the sidebar — dropping
  // the tag filter you already had, or throwing you out of Ready, would both be the
  // command doing more than it says.
  function scopeToPlace(field, key) {
    pickScope(field, key);
    refreshNav();
  }

  // Views — the primary navigation: All pucks (the committed board) · Ready (the
  // actionable queue) · Inbox (triage of raw ideas, its own space) · ⚠ Needs
  // attention (drift). Each is a nav row with a live count and a clear active state.
  function viewCounts() {
    var c = {}, qs = {};
    // Counted with the views' own queries, so a row's number can never drift from
    // what clicking it shows — the archive toggle included.
    //
    // This used to pin the archive out whatever the toggle said, "so the count
    // doesn't jump". Turning on Show done then left the sidebar saying 2 and the
    // header saying 4 for one view, which only became visible once two of three
    // parents were done. A number that jumps is explained by the switch you just
    // flipped; two different numbers for one view are never explained.
    Object.keys(VIEWS).forEach(function (k) {
      c[k] = 0;
      // `willShowDone(k)` and not `state.showDone`: every row is a *different*
      // destination now, each with its own remembered archive setting. Standing in Ready
      // with All pucks holding `done: "1"`, the current value said "off" and the All
      // pucks row advertised a number its own click would not produce — and
      // `viewsShown` gates on these, so a row could vanish while its memory would have
      // filled it.
      qs[k] = parseQuery(VIEWS[k]).concat(ARCHIVABLE[k] && !willShowDone(k) ? [NOT_DONE] : []);
    });
    DATA.items.forEach(function (it) {
      Object.keys(qs).forEach(function (k) { if (runQuery(it, qs[k])) c[k]++; });
    });
    return c;
  }
  // The views, named once and read by both the sidebar and the ⌘K palette — a new
  // view can't now appear in one and be missing from the other, which is exactly
  // what happened to Parents (a sidebar row with no command).
  var VIEW_DEFS = {
    // Only Inbox carries a glyph, and that is the point rather than an oversight:
    // it is the one row that is a *room* and not a slice of the board (see
    // VIEW_GROUPS), so it stands in its own section and wears the mark of one.
    // Giving all six an icon would say the opposite — that they are six of a kind.
    inbox: { label: "Inbox", icon: "inbox", title: "Raw ideas to triage — nothing here is a promise yet" },
    all: { label: "All pucks", title: "The committed board — now/next/later" },
    parents: { label: "Parents", title: "The pucks that hold other pucks — each with its rollup" },
    standalone: { label: "Standalone", title: "Pucks in no tree — the loose ones" },
    ready: { label: "Ready", title: "Unblocked now/next — pick one up or hand it to an agent" },
    attention: { label: "Needs attention", title: "Pucks whose declared status disagrees with reality" },
  };
  // Two kinds of row, answering two different questions — *Views* is the slice you
  // chose to look at, *Signals* is the board's own opinion about it. Inbox is
  // neither: it's a room you go to in order to empty it, so it stands above both
  // and its number reads as a to-do rather than as a size. (It is also the one
  // status excluded from every other view — `all` is literally `-status:inbox` —
  // so it was already a room; only the presentation said otherwise.)
  var VIEW_GROUPS = [
    { label: null, keys: ["inbox"] },
    { label: "Views", keys: ["all", "parents", "standalone"] },
    { label: "Signals", keys: ["ready", "attention"] },
  ];
  // Which rows this board has earned — the sidebar is navigation, not a feature
  // list. Each row is gated on the thing it actually adds, not on hierarchy in
  // general: Parents earns its place as soon as one exists (it may sit in the inbox,
  // which the committed board hides — the Parents view is then the only way to see
  // it), while Standalone earns its place only when it *differs* from All pucks,
  // i.e. when at least one member is on the committed board. Gating both on
  // `counts.parents` looked right and rendered "All pucks 31 / Standalone 31" — one
  // list under two names — because the only parent we had was an inbox one.
  function viewsShown(counts) {
    return VIEW_GROUPS.map(function (g) {
      return {
        label: g.label,
        keys: g.keys.filter(function (k) {
          if (k === "parents") return !!counts.parents;
          if (k === "standalone") return counts.standalone !== counts.all;
          if (k === "attention") return !!counts.attention;
          return true;
        }),
      };
    }).filter(function (g) { return g.keys.length; });
  }
  // ── sidebar folding ─────────────────────────────────────────────────────────
  // Chrome, not a view parameter. It says how *you* like the sidebar, not what the
  // board is showing, so it must never reach the URL — and especially not `VIEW_KEYS`,
  // where `collapsed` already means something else entirely (which groups are folded
  // in the list layout). Two different folds, two different stores, and putting this
  // one in the URL would make a shared link rearrange the recipient's furniture.
  var SIDE_FOLD = "roadmap-sidefold";
  function foldedSections() {
    var raw = null;
    try { raw = localStorage.getItem(SIDE_FOLD); } catch (e) {}
    return raw ? raw.split(",").filter(Boolean) : [];
  }
  function setFolded(key, on) {
    var list = foldedSections().filter(function (k) { return k !== key; });
    if (on) list.push(key);
    try { localStorage.setItem(SIDE_FOLD, list.join(",")); } catch (e) {}
  }
  // The heading *is* the switch. A separate chevron button beside it would add a
  // control to the one place this change exists to make quieter, and the heading
  // already names exactly what folds — so there is nothing a second target could say
  // that the first does not.
  function foldHead(label, key, body) {
    var folded = foldedSections().indexOf(key) !== -1;
    var b = el("button", "side-eyebrow eyebrow-fold");
    b.type = "button";
    // Label first, chevron last. Leading it would push the heading off the content
    // line that the rows below sit on — the alignment this sidebar was just fixed for.
    b.appendChild(el("span", null, label));
    b.appendChild(icon("chev-down", "eyebrow-chev"));
    function paint() {
      b.setAttribute("aria-expanded", folded ? "false" : "true");
      b.classList.toggle("folded", folded);
      // `hidden`, not a class of our own. A `.side-folded { display: none }` lost the
      // specificity fight with `.side-views .focusseg { display: flex }` and folded
      // nothing — which is the exact trap `[hidden] { display: none !important }` was
      // added for, after seventeen rules had to carry their own exception. Reuse the
      // answer the stylesheet already gives instead of writing an eighteenth.
      body.hidden = folded;
    }
    paint();
    b.addEventListener("click", function () {
      folded = !folded;
      setFolded(key, folded);
      paint();
    });
    return b;
  }
  function buildFocusControl() {
    var counts = viewCounts();
    // A view reads as active only when nothing more specific already describes the
    // board. That was written for places — "otherwise the sidebar would highlight both
    // 'All pucks' and the repo you navigated into" — and the same sentence is true of a
    // saved view, which was never asked. Apply one and both it and "All pucks" lit up;
    // and `Testvy`, which carries only `empty:0` and no query at all, did it with no
    // filter involved, so "is there a query" would not have caught it either. The
    // question is not what is set, it is whether something more specific is on.
    var inPlace = placeActive(), inSaved = !!activeSavedView();
    var host = document.getElementById("sideViews") || document.getElementById("filters");
    viewsShown(counts).forEach(function (g) {
      var seg = el("div", "focusseg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", g.label || "Inbox");
      g.keys.forEach(function (key) {
        var d = VIEW_DEFS[key];
        var on = state.focus === key && !inPlace && !inSaved;
        var b = el("button", "focusbtn focus-" + key + (on ? " on" : ""));
        b.type = "button";
        b.title = d.title;
        b.setAttribute("aria-pressed", on ? "true" : "false");
        if (d.icon) b.appendChild(icon(d.icon, "focus-icn"));
        b.appendChild(el("span", "focus-label", d.label));
        if (counts[key]) b.appendChild(el("span", "focus-n", String(counts[key])));
        b.addEventListener("click", function () { goToView(key); });
        seg.appendChild(b);
      });
      // The head is appended *after* its body exists, because the fold needs to know
      // what it folds. The unlabelled group (Inbox) has no head and therefore no fold:
      // it is one row, and a fold that hides one row is a worse trade than the row.
      if (g.label) host.appendChild(foldHead(g.label, lower(g.label), seg));
      host.appendChild(seg);
    });
  }
  // Switch the active view (used by the ⌘K palette). Same as a sidebar view click:
  // clears any place so the view is global.
  function setFocus(key) { goToView(key); }

  // ── the view switcher: the title is the control ─────────────────────────────
  // Saving a view happened in the Display menu (top right) and the result appeared
  // in the sidebar (far left, behind a drawer on a phone) — two corners for one
  // action and its result, and the code admitted it: the save hint had to say "and
  // shows in the sidebar". Both now live behind the title, which is already the
  // name of the current view on every width. Switching is one tap instead of
  // opening a drawer.
  //
  // The rows come from viewsShown(), the same call the sidebar makes, so the two
  // lists cannot disagree about which views exist — the drift that produced a
  // palette without Parents, and "All pucks 31 / Standalone 31".
  function buildViewSwitch() {
    ["viewTitleBtn", "topTitleBtn"].forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      var wrap = btn.parentNode;
      var open = null;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (open) { open.close(); return; }
        btn.setAttribute("aria-expanded", "true");
        open = openSurface({
          title: "Views",
          anchorWrap: wrap,
          cls: "pick-menu view-menu",
          onClose: function () { open = null; btn.setAttribute("aria-expanded", "false"); },
          build: function (host, api) {
            var counts = viewCounts(), inPlace = placeActive(), inSaved = !!activeSavedView();
            viewsShown(counts).forEach(function (g, gi) {
              if (gi) host.appendChild(el("div", "menu-rule"));
              g.keys.forEach(function (key) {
                var on = state.focus === key && !inPlace && !inSaved;
                var r = el("button", "row" + (on ? " on" : ""));
                r.type = "button";
                r.title = VIEW_DEFS[key].title;
                if (VIEW_DEFS[key].icon) r.appendChild(icon(VIEW_DEFS[key].icon, "focus-icn"));
                r.appendChild(el("span", "focus-label", VIEW_DEFS[key].label));
                if (counts[key]) r.appendChild(el("span", "focus-n", String(counts[key])));
                if (on) r.appendChild(icon("check", "pick-check"));
                r.addEventListener("click", function () { api.close(); goToView(key); });
                host.appendChild(r);
              });
            });
            var saved = savedViews();
            if (saved.length) {
              host.appendChild(el("div", "menu-rule"));
              host.appendChild(el("div", "vs-section fp-label", "Saved"));
              // Through the producer, not a second `sameParams` of its own: with two
              // entries carrying identical parameters — which is what a duplicate is —
              // an independent test lights both, and only `activeSavedView()` knows
              // which one you are actually in.
              var activeSaved = activeSavedView();
              saved.forEach(function (v) {
                var on = v === activeSaved;
                var r = el("button", "row" + (on ? " on" : ""));
                r.type = "button";
                r.title = v.q || "Saved view";
                r.appendChild(el("span", "focus-label", v.name));
                if (on) r.appendChild(icon("check", "pick-check"));
                r.addEventListener("click", function () { api.close(); applySavedView(v); });
                host.appendChild(r);
              });
            }
            if (ghToken()) {
              host.appendChild(el("div", "menu-rule"));
              var save = el("button", "row vs-save", "Save this view…");
              save.type = "button";
              save.addEventListener("click", function () {
                api.close();
                // After the dispatch that closed us: saveCurrentView opens a surface
                // of its own, and anchoring it inside one that is still unwinding
                // would attach it to a detached node.
                setTimeout(function () { saveCurrentView(wrap); }, 0);
              });
              host.appendChild(save);
            }
          },
        });
      });
    });
  }
  buildViewSwitch();
  // The three headings written in the markup get the same treatment as the two the
  // views emit — upgraded in place, so the fold is one mechanism and not two. Done
  // once at boot: unlike the view groups, these sections are refreshed by filling
  // their bodies, never by replacing their heads.
  [["saved", "savedSection", "savedViews"],
   ["agents", "agentSection", "agentFilters"],
   ["repos", "repoSection", "repoFilters"]].forEach(function (t) {
    var sec = document.getElementById(t[1]), body = document.getElementById(t[2]);
    if (!sec || !body) return;
    var eb = sec.querySelector(".side-eyebrow");
    if (eb) sec.replaceChild(foldHead(eb.textContent, t[0], body), eb);
  });

  // ── theme ──
  // Three states, one control. The sidebar used to carry a fourth piece of furniture
  // for this — a permanent ◐ that only ever flipped light⇄dark, so the third state
  // could not be reached from it and it sat in the sidebar's floor forever to offer
  // something Settings already offers completely. The choice lives in Settings (the
  // full Light/Dark/Auto segment) and in ⌘K (the same three, by name). A theme is set
  // once and then forgotten; it does not earn a permanent seat.
  var root = document.documentElement;
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
  function effectiveIsDark() {
    var t = root.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  // One writer for all three states — and the attribute is not the same thing as the
  // stored choice. The attribute is what the page is *rendering*, and it is always one
  // of the three: the dark palette lives under
  // `@media (prefers-color-scheme: dark) { :root[data-theme="auto"] }`, so `auto` has to
  // be spelled out or a dark device falls through to the light palette with no rule
  // matching it at all. (`index.html` ships `data-theme="auto"` for exactly this reason;
  // removing the attribute was undoing the markup's own default.) The stored value is
  // the *choice*, and there `auto` genuinely is an absence — nothing is written, so a
  // browser that later gains a stored value from somewhere else does not shadow it.
  function setTheme(v) {
    root.setAttribute("data-theme", v);
    try {
      if (v === "auto") localStorage.removeItem("roadmap-theme");
      else localStorage.setItem("roadmap-theme", v);
    } catch (e) {}
    applyThemeColor();
  }
  // Follow the system scheme while on "auto" — the page repaints itself through CSS,
  // but the browser's status bar is painted from a meta tag and has to be told.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyThemeColor);
  }
  applyThemeColor();

  // ── Display: layout · grouping · ordering · what's included wholesale ────────
  // One menu for *how* the chosen pucks are presented, so a new display option is
  // a row here instead of another button in the header. Filter stays next door and
  // answers *which* pucks — the two never overlap. Filter shows what it's doing
  // with chips/a count; Display shows a dot when anything differs from default,
  // because "showing more" must never read as "you have narrowed something".
  var DISPLAY_DEFAULTS = { view: "board", sort: null, group: "status", showDone: false, showEmpty: true };
  var displayBtn = document.getElementById("displayBtn");
  var displayDot = document.getElementById("displayDot");
  function displayDirty() {
    for (var k in DISPLAY_DEFAULTS) {
      // `sort` is skipped for the same reason `props` is not in the table at all: its
      // default is `null` and this loop compares by identity, so every chosen chain reads
      // as changed — including one deliberately returned to what the board draws anyway.
      // `sortChosen()` is the question the URL writer and the ordering menu already ask.
      //
      // `view` — the layout — is skipped because it is not an *arrangement* of this board
      // but a choice about how you read it, and the menu already says so with its shape:
      // a segmented control at the top, above and apart from the field rows. This file
      // conceded as much when the display became per-view ("the one that reads as a
      // preference about the device"), and kept it in only so the built-in views would
      // not differ from the saved ones by exactly one key. The dot lighting for
      // board → list was that concession showing on screen. It stays in the URL, in a
      // saved view and in the view's memory — only these two controls stop calling it a
      // change. Skipping it here **requires** the reset below to leave it alone, per the
      // rule stated two lines down.
      if (k !== "sort" && k !== "view" && state[k] !== DISPLAY_DEFAULTS[k]) return true;
    }
    if (sortChosen()) return true;
    // Not in DISPLAY_DEFAULTS because its default is `null` and the loop above compares by
    // identity — every Set would read as changed, including one holding every property.
    if (state.props) return true;
    // A folded group is a display change like any other, so the dot has to see it —
    // otherwise "Reset to default" would change something the dot said was default.
    return state.view === "list" && state.collapsed.size > 0;
  }
  function refreshDisplayDot() { if (displayDot) displayDot.hidden = !displayDirty(); }
  function setDisplay(key, value) {
    // A fold belongs to the columns it was folded in. Changing the grouping replaces
    // every column, so carrying the keys over means folding a group nobody touched —
    // and the "none" bucket is keyed the same (NO_VALUE) under Agent, Target, Parent
    // and Priority, so collapsing "Unrouted" would silently collapse "No priority".
    if (key === "group" && value !== state.group) state.collapsed.clear();
    state[key] = value;
    // Picking the hierarchy picks the layout that can draw it, and the segment moves so
    // you can see it happen. The alternative — falling back silently — is the mistake
    // this file already names one screen down: a control that claims a choice which
    // never took effect. The write below carries it, so the switch is as durable as if
    // you had pressed List yourself.
    if (key === "group" && !groupUsable(value)) state.view = "list";
    // After the layout, because `effectiveGroup()` reads it — and for a `group` change too,
    // not only a `sort` one: moving the grouping moves the proposal under a chain that did
    // not change.
    normalizeSort();
    // One write, of the whole board, into the view you are standing in — see
    // `rememberDisplay`. It replaces a `saveDisplay(key, value)` per setting, and the
    // line above is why that shape had to go: picking the hierarchy moves the *layout*
    // too, so the write following a `group` change was never only about `group`. It also
    // means `props` needs no special case for being a Set rather than a string, since
    // what is stored is `viewParamObject`'s serialization and not the raw value.
    rememberDisplay();
    refreshDisplayDot();
    // The sidebar's numbers read `state.showDone` now, so a display change can move
    // them — and which rows exist at all, since a view whose count is zero is not
    // navigation. Rebuilding for a layout or sort change costs nothing and means the
    // rule is "a display change refreshes the chrome", not a list of which ones do.
    refreshNav();
    renderBoard();
  }
  var displaySurface = null;
  function toggleDisplayMenu() {
    var wrap = displayBtn && displayBtn.parentNode;
    if (!wrap) return;
    if (displaySurface) { displaySurface.close(); return; }
    displayBtn.setAttribute("aria-expanded", "true");
    displaySurface = openSurface({
      title: "Display",
      anchorWrap: wrap,
      cls: "filter-pop display-pop",
      onClose: function () { displaySurface = null; displayBtn.setAttribute("aria-expanded", "false"); },
      build: function (pop) { renderDisplayRoot(pop); },
    });
  }
  // The two fields the menu offers — the columns' own field, and the order inside a
  // group. `usable` keeps a grouping out where the view has already fixed it.
  var DISPLAY_FIELDS = [
    { key: "group", label: "Grouping",
      current: function () { return effectiveGroup(); },
      options: function () {
        return Object.keys(GROUPS).filter(function (k) { return groupOffered(k); }).map(function (k) {
          return { value: k, label: GROUPS[k].label };
        });
      } },
    // A chain, so the row names the key the eye is following and says how many break its
    // ties — `Priority (high→low) +2`. Spelling the whole chain out would be the honest
    // thing on a wide menu and an ellipsised smear on a phone, and the primary key is the
    // half you glance at this row to check.
    { key: "sort", label: "Ordering", chain: true,
      current: function () {
        var c = sortChain();
        return SORT_FIELDS[sortField(c[0])].label + (c.length > 1 ? " +" + (c.length - 1) : "");
      },
      options: function () {
        return SORT_ORDER.map(function (k) { return { value: k, label: SORT_FIELDS[k].label }; });
      } },
    // The third row is a different shape: not one value out of a list but a subset, so
    // level 2 draws checkboxes instead of a radio list. It reuses the same two levels
    // because the alternative — a picker of its own — is the mistake this menu was
    // rewritten to fix: on a phone a second surface takes this sheet's place and leaves
    // no way back.
    { key: "props", label: "Properties", multi: true,
      current: function () {
        if (!state.props) return "Default";
        if (!state.props.size) return "None";
        if (state.props.size === PROPS.length) return "All";
        return String(state.props.size) + " of " + PROPS.length;
      },
      options: function () {
        return PROPS.map(function (f) { return { value: f.key, label: f.label }; });
      } },
  ];
  function displayLabel(f) {
    var cur = f.current(), hit = null;
    if (f.multi || f.chain) return cur; // a subset and a chain both name themselves
    f.options().forEach(function (o) { if (o.value === cur) hit = o; });
    return hit ? hit.label : cur;
  }
  // Level 1. Level 2 replaces it *in place*, exactly the way the filter panel does
  // it — that is the point of this rewrite. The two settings used to open a
  // separate picker surface, which on a phone took this sheet's place and left no
  // way back: the only exit was to dismiss and start over. One overlay primitive had
  // grown two ways to reach a sub-list, and only one of them could be reversed.
  function renderDisplayRoot(pop) {
    pop.innerHTML = "";
    surfaceLevel(pop); // level one: the surface's own name back in the head, no way back
    var seg = segmented(
      [["list", "List", "list"], ["board", "Board", "grid"]],
      state.view,
      function (v) {
        setDisplay("view", v);
        // The **whole** level, not just the wholesale block. That targeted repaint was
        // right while the layout only governed the empty-columns row; it stopped being
        // right when `groupOffered` started reading `state.view`, and the staleness landed
        // one storey above where a reviewer looked for it. The submenu is fine — level 2
        // calls `f.options()` on entry, so it reads the layout you are standing in — but
        // *this* level's rows are drawn once, and their value is `displayLabel(f)`.
        // Measured: standing in the list under `group=none` and pressing Board left the
        // row reading `Grouping · None` over a board drawing Now / Next / Later. A menu
        // claiming a grouping the board is not drawing is the same failure the ordering
        // menu's missing `✕` exists to prevent, one key over.
        //
        // Rebuilding costs the pressed segment its focus, so it is put back — the button
        // is gone by then, and the new one for the same value takes its place.
        var wasSeg = document.activeElement && document.activeElement.closest
          && document.activeElement.closest(".dp-seg");
        renderDisplayRoot(pop);
        if (wasSeg) {
          // By `aria-pressed`, which is what `segmented()` actually emits — the first
          // attempt reached for a `data-value` the helper does not set, so the branch
          // matched nothing and quietly did not restore anything.
          var again = pop.querySelector('.dp-seg [aria-pressed="true"]');
          if (again && again.focus) again.focus();
        }
      });
    seg.classList.add("dp-seg");
    [].forEach.call(seg.children, function (c) { c.classList.add("dp-segbtn"); });
    pop.appendChild(seg);

    // Grouping (the columns' field — the row that turns one board into an agent
    // queue or a fleet view) and Ordering ("Manual" is the puck's own `order`; every
    // other mode deliberately ignores it). Both read the way iOS writes a setting
    // that has a sub-list: name on the left, the value it currently holds on the
    // right, and a chevron saying there is somewhere to go.
    DISPLAY_FIELDS.forEach(function (f) {
      if (f.options().length < 2) return; // one option is a fact, not a choice
      var row = el("button", "fp-row dp-row");
      row.type = "button";
      // `dp-row`/`dp-label` stay on the markup as hooks, the way `dp-seg` did when
      // the layout switch became a `.segmented`.
      row.appendChild(el("span", "dp-label", f.label));
      row.appendChild(el("span", "fp-cur", displayLabel(f)));
      row.appendChild(icon("chev-right", "fp-chev"));
      row.addEventListener("click", function () { renderDisplayValues(pop, f); });
      pop.appendChild(row);
    });

    // Wholesale inclusion — not filters: these say how complete the list is. Each is
    // offered only where it can change something, which is the rule this menu was
    // breaking twice over: the archive toggle can't matter in a view whose statuses
    // are never terminal (that's what ARCHIVABLE already says), and empty columns
    // are read by renderColumns alone — renderList drops empty groups unconditionally,
    // so in list layout the box was checked and inert in *every* view.
    // Its own container and repainted by the layout toggle above, because one of the
    // two conditions is the layout: flipping to List while the menu is open has to
    // take the empty-columns row with it, or the menu shows a control it has just
    // made inert.
    var wholeHost = el("div", "dp-wholesale");
    pop.appendChild(wholeHost);
    paintWholesale();
    function paintWholesale() {
      wholeHost.innerHTML = "";
      var rows = [];
      // The toggle is where "archived" is *defined*, because it is the only place that
      // can be. There is no `archived` status — `TERMINAL` is `done` or `cancelled` — so
      // the marks scattered across the board ("137 archived 👁") name a category the data
      // does not have, and a reader who has never opened this menu has nothing to check it
      // against. One definition, in the control that acts on it, is what lets every mark
      // stay short and still be answerable.
      //
      // It sits on a **line of its own**, not inside the label and not in a tooltip. A
      // parenthesis in the name read as the interface explaining a word it had just
      // chosen; a `title` reached nobody who needed it, which a reviewer caught and is the
      // sharper objection — hover is not a thing on a phone, and the bottom sheet *is* the
      // phone. The definition would have been missing in the one place the marks are
      // hardest to look up from. Length never decided any of this — putting the statuses on
      // the marks themselves fits too (148px against 92px, 41px still spare in the tightest
      // column head at 390px) — so what is left is that a name and its definition are two
      // things, and the row can hold both without the first swallowing the second.
      if (ARCHIVABLE[state.focus]) rows.push(["showDone", "Show archived", "Done and cancelled pucks."]);
      if (state.view === "board") {
        rows.push(["showEmpty", "Show empty columns", "An empty column is still a drop target."]);
      }
      if (!rows.length) return;
      wholeHost.appendChild(el("div", "dp-rule"));
      rows.forEach(function (w) {
        var row = el("label", "fp-toggle");
        // The state key on the markup, as a hook — the same reason `dp-row`/`dp-label`
        // carry theirs. Without it the only handle on this row is its own label text, so
        // rewording the copy broke a check about the *sidebar's counts*, which is a test
        // reaching for the wrong thing rather than a rule changing.
        row.dataset.key = w[0];
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = state[w[0]];
        cb.addEventListener("change", function () { setDisplay(w[0], cb.checked); });
        row.appendChild(cb);
        var txt = el("span", "fp-toggle-txt");
        var name = el("span", "fp-toggle-name", w[1]);
        name.id = "tgl-n-" + w[0];
        txt.appendChild(name);
        // **Named by the name, described by the hint** — and wired explicitly, because a
        // label that wraps its control hands over *all* of its text. Left implicit, the
        // accessible name would have become "Show archived Done and cancelled pucks.",
        // which is the parenthesis back again with a screen reader reading it aloud every
        // time. `aria-labelledby` narrows the name to the name; `aria-describedby` is what
        // makes the second line a description rather than more of the first.
        cb.setAttribute("aria-labelledby", name.id);
        if (w[2]) {
          var hint = el("span", "fp-toggle-hint", w[2]);
          hint.id = "tgl-h-" + w[0];
          cb.setAttribute("aria-describedby", hint.id);
          txt.appendChild(hint);
        }
        row.appendChild(txt);
        wholeHost.appendChild(row);
      });
    }

    pop.appendChild(el("div", "dp-rule"));
    // "Save as view" used to sit here, and the saved view then appeared in the
    // sidebar — the action in one corner, its result in another. It lives behind
    // the title now, next to the views it joins. (It is still Linear's "set default
    // for everyone", git-native: it writes board.config.json and repo permissions
    // decide who may.)
    var reset = el("button", "resetbtn dp-reset");
    reset.type = "button";
    reset.appendChild(icon("reset"));
    reset.appendChild(el("span", null, "Reset to default"));
    reset.addEventListener("click", function () {
      // The layout is not what this button resets — see `displayDirty`. The two are one
      // decision, not two: reset it while the dot ignores it and the press would change
      // something the dot had just called default, which is the invariant the folds are
      // held to one function up. `clearDisplay` still puts it back, because applying a
      // *saved view* goes through the same function and a view with no `layout` means the
      // default one; so it is restored here rather than exempted there.
      var layout = state.view;
      clearDisplay();
      state.view = layout;
      // Which also *forgets* this view: `rememberDisplay` deletes an entry that has
      // nothing non-default left in it, so a reset view opens at the defaults next time
      // rather than at a stored copy of them. Reset is per view, like everything else
      // here — the button is in the menu that changed this one board.
      rememberDisplay();
      refreshDisplayDot();
      // Navigation, inte bara brädet: `viewCounts()` och `placeCounts()` läser
      // `showDone`, så en reset som släcker arkivet lämnade sidomenyns siffror — och
      // rader som bara arkivet fyllde — kvar i sitt gamla läge. Samma väg som
      // `setDisplay` går, av samma skäl.
      afterEdit();
      toggleDisplayMenu();
    });
    pop.appendChild(reset);
  }
  // Level 2: the values, with a way back. Picking one returns to level 1 rather than
  // closing the menu — a display choice is rarely the only one you came to make, and
  // the Display menu holds five.
  function renderDisplayValues(pop, f) {
    // The chain draws its *own* surface, back row included, so it is delegated to before
    // this one clears anything — see the invariant on `renderSortChain`.
    if (f.chain) { renderSortChain(pop, f); return; }

    pop.innerHTML = "";
    surfaceLevel(pop, f.label, function () { renderDisplayRoot(pop); });

    if (f.multi) { renderFieldChecks(pop, f); return; }

    var cur = f.current();
    f.options().forEach(function (o) {
      var row = el("button", "row" + (o.value === cur ? " on" : ""));
      row.type = "button";
      row.setAttribute("data-value", o.value);
      row.appendChild(el("span", null, o.label));
      if (o.value === cur) row.appendChild(icon("check", "pick-check"));
      row.addEventListener("click", function () {
        if (o.value !== cur) setDisplay(f.key, o.value);
        renderDisplayRoot(pop);
      });
      pop.appendChild(row);
    });
  }
  // Level 2, the chain shape: one row per key, in order — `[↑] Field  direction  ✕` — then
  // one row to add and one to reset. **The order is the setting**, which a list of
  // checkboxes cannot say: a tick can report that `priority` is in the chain but never that
  // it comes before `target`, and that is the difference between "sort by priority" and
  // "priority within each horizon".
  //
  // It used to be two lists — the chain, then the whole catalogue underneath — and the only
  // thing telling them apart was a small ordinal and some icons at the far edge. Nine
  // near-identical rows on a phone, which is why the surface carried a sentence explaining
  // which were which. **A note that says what the structure should have said is a diagnosis,
  // not copy**: the catalogue moved behind `＋ Add a key`, one list was left, and the
  // sentence had nothing to do.
  //
  // One row rather than a card per key, though a card is the roomier shape on a phone: the
  // row is the shape that survives *both* presentations. `openSurface` promises the builder
  // never learns which shell it got, and a card three rows tall is wrong in an anchored
  // popover — so a card would have had to break that promise to be drawn well.
  //
  // Reordering is `↑` and not a drag. A drag is the obvious gesture and the wrong one here:
  // on a phone this list lives inside a bottom sheet that is itself draggable — down to
  // dismiss, up to snap — so a row drag would compete with its own container for the same
  // finger. It *would* work in the popover, which is not draggable, and that is exactly the
  // trade refused: one mechanism that is second-best on the desktop costs less than the
  // first crack in the rule the whole surface layer rests on.
  //
  // The chain can never be emptied: `parseSort` answers with the default for an empty
  // value, so a menu that let you remove the last key would show a chain the board is not
  // drawing. The last row keeps its `✕` off rather than refusing the press — a control that
  // only fails when you press it is not gated, it is decorated.
  //
  // **A renderer anything can jump back into owns its surface.** This one clears and draws
  // its own way back, rather than trusting a caller to have done it — which is not style but
  // the fix for a bug that shipped twice. The first time, `apply()` called this function
  // directly and appended a second copy of the chain under the first: three clicks, seven
  // rows. That was patched by routing `apply()` through `renderDisplayValues`, which clears —
  // and the patch held only while this function had exactly one caller. Adding level 3 gave
  // it three more (the picker's back row, and its two ways of choosing a field), and the bug
  // came back in the shape reported from a phone: pressing `‹ Add a key` drew the chain
  // *below* the picker, twice, three times. A convention that has to be remembered at every
  // call site is not a convention.
  function renderSortChain(pop, f) {
    pop.innerHTML = "";
    surfaceLevel(pop, f.label, function () { renderDisplayRoot(pop); });

    var chain = sortChain();
    function apply(next) {
      setDisplay("sort", serializeSort(next));
      renderSortChain(pop, f); // stay on the list: building a chain is many clicks, not one
    }
    chain.forEach(function (k, i) {
      var field = sortField(k), dir = sortDir(k), spec = SORT_FIELDS[field];
      var row = el("div", "dp-sort");

      // The field, swappable in place. Before this the only way to change the *first* key
      // was to remove it — leaving a chain of one fewer — and add it again, where it landed
      // last. Rewriting it here is what makes `↑` a rarity rather than the main path.
      var pick = el("button", "dp-sort-field");
      pick.type = "button";
      pick.title = "Change " + spec.label;
      pick.appendChild(el("span", null, spec.label));
      pick.appendChild(icon("chev-right", "dp-sort-chev"));
      pick.addEventListener("click", function () { renderSortPick(pop, f, i); });
      row.appendChild(pick);

      // Direction: a toggle, not a picker. There are exactly two, so a chevron would
      // promise a list with two rows in it and cost a second tap to say the same thing.
      // The label is the *values* — `high → low`, `newest → oldest` — because that is what
      // the old key names said before the direction became a control.
      //
      // `Manual` draws none, and the ragged row that leaves is the honest shape: there is no
      // question to answer there, and a disabled control or a dead label would both claim
      // otherwise.
      if (reversible(field)) {
        var flip = el("button", "dp-sort-dir");
        flip.type = "button";
        flip.title = "Reverse " + spec.label;
        flip.appendChild(el("span", null, spec[dir]));
        flip.addEventListener("click", function () {
          var next = chain.slice();
          next[i] = sortKeyName(field, dir === "asc" ? "desc" : "asc");
          apply(next);
        });
        row.appendChild(flip);
      }

      // Both controls sit at the *end* of the row, which is what lets every name in the
      // surface start on one line. `↑` used to lead the row, from when there was an ordinal
      // beside it to be near; the ordinals went when the menu became one list, and the arrow
      // was left indenting the field name 46px past every other row in the sheet — reported
      // from a phone, with the margins drawn on. The first row has no `↑` and gets a spacer
      // instead of a disabled button: a control that answers nothing is worse than no
      // control, but `✕` still has to land in one column. The spacer carries its *own* class
      // rather than the control's — it shared `.dp-sort-act` first, which made "how many
      // controls does this row have" a question with the wrong answer.
      if (i > 0) {
        var up = el("button", "dp-sort-act");
        up.type = "button";
        up.title = "Move " + spec.label + " up";
        up.setAttribute("aria-label", up.title);
        up.appendChild(icon("arrow-up"));
        up.addEventListener("click", function () {
          var next = chain.slice();
          next.splice(i - 1, 0, next.splice(i, 1)[0]);
          apply(next);
        });
        row.appendChild(up);
      } else {
        row.appendChild(el("span", "dp-sort-gap"));
      }

      if (chain.length > 1) {
        var rm = el("button", "dp-sort-act");
        rm.type = "button";
        rm.title = "Remove " + spec.label;
        rm.setAttribute("aria-label", rm.title);
        rm.appendChild(icon("x"));
        rm.addEventListener("click", function () {
          apply(chain.filter(function (o) { return o !== k; }));
        });
        row.appendChild(rm);
      }
      pop.appendChild(row);
    });

    if (chain.length < SORT_ORDER.length) {
      var add = el("button", "row dp-sort-add");
      add.type = "button";
      add.appendChild(icon("plus"));
      add.appendChild(el("span", null, "Add a key"));
      add.addEventListener("click", function () { renderSortPick(pop, f, null); });
      pop.appendChild(add);
    }
    // A narrow reset, and it needs to be narrow: Display's own "Reset to default" puts back
    // every one of the seven display keys, so there was no way to drop an ordering without
    // also dropping the grouping, the layout and the properties you had just set.
    // Drawn when the chain differs from what the board would draw with no choice at all —
    // the grouping's proposal, not `DEFAULT_SORT`. Against the constant it offered a Reset
    // on an untouched board whose press landed back on the very same rows; against
    // `state.sort != null` it offers one for a chain deliberately re-picked to equal the
    // proposal, which is the same empty promise one step further in. It resets to *no
    // choice* rather than to a chain, because storing the proposal is what would end it.
    if (sortChosen()) {
      var res = el("button", "row dp-sort-add");
      res.type = "button";
      res.appendChild(icon("trash"));
      res.appendChild(el("span", null, "Reset ordering"));
      res.addEventListener("click", function () {
        setDisplay("sort", null);
        renderSortChain(pop, f);
      });
      pop.appendChild(res);
    }
  }
  // Level 3: which field. In place in the same surface with a way back, never a second
  // overlay — on a phone a new sheet takes this one's place and the way back with it, which
  // is the same reason `props` draws checkboxes here instead of opening a picker.
  //
  // `idx` is the row being rewritten, or `null` to append. A field already in the chain is
  // not offered, since a chain holding one field twice has a key that can never be reached;
  // the row being rewritten is the exception, where it stands as the current answer.
  function renderSortPick(pop, f, idx) {
    pop.innerHTML = "";
    var chain = sortChain();
    surfaceLevel(pop, idx == null ? "Add a key" : "Change key", function () {
      renderSortChain(pop, f);
    });

    var fields = chain.map(sortField);
    SORT_ORDER.forEach(function (field) {
      var at = fields.indexOf(field);
      var mine = idx != null && at === idx;
      if (at !== -1 && !mine) return;
      var row = el("button", "row" + (mine ? " on" : ""));
      row.type = "button";
      row.setAttribute("data-value", field);
      row.appendChild(el("span", null, SORT_FIELDS[field].label));
      if (mine) row.appendChild(icon("check", "pick-check"));
      row.addEventListener("click", function () {
        // Re-picking the field already there is not a change, and must not read as one: a
        // direction you had flipped would be reset by a tap that looked like a no-op.
        if (mine) { renderSortChain(pop, f); return; }
        var next = chain.slice(), key = sortKeyName(field, SORT_FIELDS[field].def);
        // A swapped-in field takes its own default direction rather than the old field's:
        // `newest → oldest` is not a thing `priority` can be.
        if (idx == null) next.push(key); else next[idx] = key;
        setDisplay("sort", serializeSort(next));
        renderSortChain(pop, f);
      });
      pop.appendChild(row);
    });
  }
  // Level 2, the subset shape: a checkbox per property, and a way back to no choice at
  // all. That last row is not decoration — "no choice" is a state the ticks cannot reach,
  // since unticking everything is the *empty* choice and means a row with no metadata on
  // it. Without it there would be no way back to letting the board pick the date.
  function renderFieldChecks(pop, f) {
    var chosen = state.props;
    if (!chosen) {
      // First tick starts from what is on screen — so ticking one property off does that
      // and nothing else. Starting from empty would read as the board throwing the row
      // away because you touched one checkbox. "On screen" is `propShown`, not `propOn`:
      // the dates are chosen for you one at a time until a view names them.
      var note = el("div", "dp-note",
        "Chosen for you: everything the grouping does not already say. Tick to take over.");
      pop.appendChild(note);
    }
    f.options().forEach(function (o) {
      var row = el("label", "fp-toggle");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = propShown(o.value);
      cb.setAttribute("data-field", o.value);
      cb.addEventListener("change", function () {
        var next = new Set();
        PROPS.forEach(function (g) { if (propShown(g.key)) next.add(g.key); });
        if (cb.checked) next.add(o.value); else next.delete(o.value);
        setDisplay("props", next);
        renderDisplayValues(pop, f); // stay on the list: choosing a set is many clicks, not one
      });
      row.appendChild(cb);
      row.appendChild(el("span", null, o.label));
      pop.appendChild(row);
    });
    if (state.props) {
      pop.appendChild(el("div", "dp-rule"));
      var auto = el("button", "fp-back dp-auto");
      auto.type = "button";
      auto.appendChild(el("span", null, "Back to default"));
      auto.addEventListener("click", function () {
        setDisplay("props", null);
        renderDisplayValues(pop, f);
      });
      pop.appendChild(auto);
    }
  }
  if (displayBtn) displayBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleDisplayMenu(); });
  refreshDisplayDot();

  // ── search + title suggestions ──
  var searchInput = document.getElementById("search");
  var suggestEl = document.getElementById("searchSuggest");
  var suggestItems = []; // items currently offered
  var suggestIndex = -1; // highlighted row (-1 = none)

  // Title matches only (v1): startsWith ranks above a mid-string hit. Suggestions
  // span all items — clicking jumps to any card, even one the board is hiding.
  // Where a ⌘K quick-capture lands: the single scoped repo if you're in one,
  // else this board's own aggregator repo, else the first source.
  function defaultCaptureRepo() {
    var scoped = placeValues("repo");
    if (scoped.length === 1) return resolveRepo(scoped[0]) || scoped[0];
    var agg = aggregatorRepo();
    if (agg && DATA.sources.some(function (s) { return s.repo === agg; })) return agg;
    return DATA.sources[0] && DATA.sources[0].repo;
  }
  // ⌘K is a command palette, not just search: actions (create, views, settings,
  // theme, account) alongside pucks and tag filters. Each action carries its own
  // run(); nothing here is a second source of truth — they just drive the same
  // functions the chrome buttons do.
  function paletteCommands() {
    var cmds = [], signedIn = !!ghToken(), vc = viewCounts();
    if (signedIn) cmds.push({ __cmd: true, label: "New puck…", hint: "Create", icon: "plus", run: function () { openNewPuckPanel(); } });
    // Straight off the sidebar's own definition, in the same order and under the
    // same conditions — the palette can't fall behind a view the sidebar has.
    viewsShown(vc).forEach(function (g) {
      g.keys.forEach(function (key) {
        cmds.push({ __cmd: true, label: "Go to " + VIEW_DEFS[key].label, hint: "View", icon: "list",
          run: function () { setFocus(key); } });
      });
    });
    // Saved views are views. The comment above holds for them too: the palette can't
    // fall behind a view the sidebar has, and a saved view is the only kind that used
    // to be reachable from exactly one control.
    savedViews().forEach(function (v) {
      cmds.push({ __cmd: true, label: "Go to " + v.name, hint: "Saved view", icon: "list",
        run: function () { applySavedView(v); } });
    });
    // …and so is making one. The chip row is where you actually finish building a
    // filter and the title is where the result lands; this is the keyboard's way to
    // the same call, so ⌘K never has less reach than the chrome.
    if (signedIn) {
      cmds.push({ __cmd: true, label: "Save this view…", hint: "Saved view", icon: "plus",
        // Deferred for the same reason the switcher defers it: this opens a surface of
        // its own, and the pointer event that picked the command is still unwinding —
        // its tail would reach the new surface as an outside click and shut it.
        run: function () { setTimeout(function () { saveCurrentView(null); }, 0); } });
    }
    // Display options belong in the palette too — the palette is the extensibility
    // surface, so a new display choice never has to become another button.
    Object.keys(GROUPS).filter(function (k) { return groupOffered(k); }).forEach(function (k) {
      if (k === effectiveGroup()) return;
      cmds.push({ __cmd: true, label: "Group by " + GROUPS[k].label.toLowerCase(), hint: "Display", icon: "sliders", run: function () { setDisplay("group", k); } });
    });
    cmds.push({ __cmd: true, label: state.view === "list" ? "Layout: board" : "Layout: list", hint: "Display", icon: state.view === "list" ? "grid" : "list", run: function () { setDisplay("view", state.view === "list" ? "board" : "list"); } });
    // The footer button is where the staleness is *stated*, so that is where the repair
    // belongs; this is the keyboard's way to the same call, so ⌘K never has less reach
    // than the chrome. Same gate, asked the same way.
    if (canSync()) cmds.push({ __cmd: true, label: "Sync now", hint: "Workspace", icon: "sync", run: function () { runSync(); } });
    cmds.push({ __cmd: true, label: "Settings", hint: "Workspace", icon: "sliders", run: function () { openSettingsPanel(); } });
    cmds.push({ __cmd: true, label: "Keyboard shortcuts", hint: "Help", icon: "list", run: function () { toggleShortcutHelp(); } });
    // Named states rather than a flip. The objection that killed a three-state *button*
    // — "auto looks identical to dark on a dark-set device", so you cannot tell what a
    // press did — does not apply to a list that says which state each row is. And a
    // list is the only place the keyboard can reach `auto` at all.
    var curTheme = root.getAttribute("data-theme") || "auto";
    [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["auto", "Auto (follow system)", "sliders"]]
      .forEach(function (t) {
        if (t[0] === curTheme) return; // the state you are already in is not a command
        cmds.push({ __cmd: true, label: "Theme: " + t[1], hint: "Theme", icon: t[2],
          run: function () { setTheme(t[0]); } });
      });
    if (signedIn) {
      cmds.push({ __cmd: true, label: "Change token", hint: "Account", icon: "key", run: function () { openTokenPanel(afterAuth); } });
      cmds.push({ __cmd: true, label: "Sign out", hint: "Account", icon: "key", run: function () { setGhToken(""); afterAuth(); } });
    } else {
      cmds.push({ __cmd: true, label: "Sign in to edit", hint: "Account", icon: "key", run: function () { openTokenPanel(afterAuth); } });
    }
    return cmds;
  }
  function computeSuggestions(q) {
    var raw = (q || "").trim();
    q = q.toLowerCase();
    var cmds = paletteCommands();
    if (!q) return cmds; // empty ⌘K → the command palette home
    var matchedCmds = cmds.filter(function (c) { return c.label.toLowerCase().indexOf(q) !== -1; });
    // Discipline shortcuts: matching labels not already active, as filter actions.
    var tagCounts = {};
    DATA.items.forEach(function (it) { it.tags.forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
    var tags = Object.keys(tagCounts)
      .filter(function (t) { return t.indexOf(q) !== -1 && filterValues("tag", false).indexOf(t) === -1; })
      .sort(function (a, b) { return tagCounts[b] - tagCounts[a] || a.localeCompare(b); })
      .slice(0, 3)
      .map(function (t) { return { __tag: t, count: tagCounts[t] }; });
    // Pucks by title (startsWith ranks above a mid-string hit).
    var starts = [], contains = [];
    DATA.items.forEach(function (it) {
      var i = it.title.toLowerCase().indexOf(q);
      if (i === 0) starts.push(it);
      else if (i > 0) contains.push(it);
    });
    var out = matchedCmds.concat(tags).concat(starts.concat(contains).slice(0, 6));
    // Quick-capture: type a line → create an inbox stub straight from ⌘K.
    if (ghToken() && raw) out.push({ __create: true, title: raw });
    return out;
  }

  // Swallow the very next click at the capture phase (once), so a tap that acted on
  // pointerdown and closed an overlay can't fall through to whatever is now beneath
  // the pointer. Self-clears on that click, or after a short window if none fires.
  function swallowNextClick() {
    var shield = function (ev) { ev.stopPropagation(); ev.preventDefault(); clearTimeout(t); document.removeEventListener("click", shield, true); };
    var t = setTimeout(function () { document.removeEventListener("click", shield, true); }, 700);
    document.addEventListener("click", shield, true);
  }

  function renderSuggestions() {
    suggestEl.innerHTML = "";
    if (!suggestItems.length) {
      suggestEl.hidden = true;
      searchInput.setAttribute("aria-expanded", "false");
      return;
    }
    suggestItems.forEach(function (it, idx) {
      var li = el("li", "row suggest-item" + (it.__tag ? " suggest-tag" : "") + (it.__create ? " suggest-create" : "") + (it.__cmd ? " suggest-cmd" : ""));
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", idx === suggestIndex ? "true" : "false");
      if (it.__cmd) {
        var cm = el("span", "suggest-cmdmark");
        cm.appendChild(icon(it.icon || "list"));
        li.appendChild(cm);
        li.appendChild(el("span", "suggest-title", it.label));
        if (it.hint) li.appendChild(el("span", "suggest-hint", it.hint));
      } else if (it.__create) {
        var mk = el("span", "suggest-createmark");
        mk.appendChild(icon("plus"));
        li.appendChild(mk);
        li.appendChild(el("span", "suggest-title", "Create “" + it.title + "”"));
        li.appendChild(el("span", "suggest-hint", "New puck · " + repoNameOf(defaultCaptureRepo())));
      } else if (it.__tag) {
        li.appendChild(el("span", "suggest-tagmark", "#"));
        li.appendChild(el("span", "suggest-title", it.__tag));
        li.appendChild(el("span", "suggest-hint", "Filter · " + it.count));
      } else {
        var dot = el("span", "suggest-dot");
        dot.style.background = it.repoColor;
        li.appendChild(dot);
        li.appendChild(el("span", "suggest-title", it.title));
        li.appendChild(statusPill(it.status));
      }
      // pointerdown (not click): fires before blur and preventDefault keeps the
      // input focused, so the selection lands instead of the dropdown vanishing.
      li.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        chooseSuggestion(it);
        // Acting on pointerdown hides the overlay before this tap's trailing click
        // (and iOS's ~300ms ghost click) fires — which would otherwise fall through
        // to the card/puck now revealed underneath. Swallow that next click once.
        swallowNextClick();
      });
      if (idx === suggestIndex) li.scrollIntoView({ block: "nearest" });
      suggestEl.appendChild(li);
    });
    suggestEl.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  function updateSuggestions() {
    suggestItems = computeSuggestions(queryText()); // field terms filter; only text suggests
    // Spotlight-style: highlight the top row so Enter runs it immediately.
    suggestIndex = suggestItems.length ? 0 : -1;
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
    // Every palette choice changes what the screen shows — another puck, the board
    // under a new filter, a panel. None of the destinations wants the surface that
    // belonged to where you were, and the branches below reach the board by several
    // different routes (a tag filters in place without ever entering goToView).
    closeSurfaces();
    if (it.__cmd) {
      closeCmdk();
      if (typeof it.run === "function") it.run();
      return;
    }
    if (it.__create) {
      // Quick-capture → the same capture dialog, title prefilled, repo defaulted
      // (always shown so you confirm it — the repo is permanent).
      closeCmdk();
      openNewPuckPanel({ title: it.title });
      return;
    }
    if (it.__tag) {
      // Label shortcut → apply it as a filter and return to the board. closeCmdk
      // drops the typed text but keeps the term we just added.
      exitPuckView();
      toggleFilterValue("tag", it.__tag, false);
      closeCmdk();
      refreshFilterBadge();
    } else {
      closeCmdk();
      openModal(it);
    }
  }

  // ── ⌘K command palette (holds the search input) ──
  // Opened from the sidebar Search button (desktop) or the topbar icon (mobile,
  // where the sidebar is behind the menu) — both are plain buttons, not fake inputs.
  var cmdkOverlay = document.getElementById("cmdkOverlay");
  var cmdkTriggers = [document.getElementById("sideSearch"), document.getElementById("topSearch")];
  // What the palette edits: the free text, on top of whatever predicates are
  // already active. Those are captured when it opens and re-applied on every
  // keystroke, so searching for a title can't quietly drop the filters behind it.
  // Type `status:now` here and it still becomes a filter — it just replaces that
  // field rather than everything.
  var paletteBase = [];
  var popCmdkLayer = null;
  function openCmdk() {
    if (!cmdkOverlay) return;
    cmdkOverlay.hidden = false;
    document.body.classList.add("cmdk-open");
    // Takes the top of the stack, so a sheet underneath goes inert and Tab can't
    // walk out of the palette into it.
    popCmdkLayer = pushLayer([cmdkOverlay]);
    paletteBase = parseQuery(state.query).filter(function (t) { return t.field !== "text"; });
    searchInput.value = queryText();
    updateSearchClear();
    searchInput.focus();
    searchInput.select();
    updateSuggestions();
  }
  function closeCmdk() {
    if (!cmdkOverlay || cmdkOverlay.hidden) return;
    cmdkOverlay.hidden = true;
    document.body.classList.remove("cmdk-open");
    if (popCmdkLayer) { popCmdkLayer(); popCmdkLayer = null; }
    // The palette is navigation, not a lingering board filter — its free text is
    // dropped on close, as before. Field terms are different: `status:now` typed
    // here is a *filter*, indistinguishable from one built in the panel, so it
    // stays and shows up as a chip. Text goes, predicates remain.
    if (searchInput.value) {
      searchInput.value = "";
      setQueryTerms(parseQuery(state.query).filter(function (t) { return t.field !== "text"; }));
      updateSearchClear();
    }
    hideSuggestions();
  }
  cmdkTriggers.forEach(function (t) { if (t) t.addEventListener("click", function () { openCmdk(); maybeCloseMenu(); }); });
  if (cmdkOverlay) cmdkOverlay.addEventListener("mousedown", function (e) { if (e.target === cmdkOverlay) closeCmdk(); });

  // ── keyboard shortcuts (Linear-inspired) ──
  // A single global keydown layer. Gating: never fire while typing in a field, and
  // never let a bare key act while a modal/palette owns the keyboard.
  function isTyping(t) {
    return !!(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
  }
  function cmdkVisible() { return !!(cmdkOverlay && !cmdkOverlay.hidden); }
  function anyModalOpen() {
    // The New/Settings panels + prompts add .modal-open; the puck detail never does
    // (it uses .viewing-puck), so this is true exactly when such a panel owns the
    // screen — including when it was launched over an already-open puck.
    return document.body.classList.contains("modal-open");
  }
  function detailOpen() { return document.body.classList.contains("viewing-puck"); }
  function helpOpen() { return !!document.querySelector(".shortcut-help"); }

  // Click the editable control of a detail property row (status/priority/agent/labels).
  function triggerField(field) {
    if (!detailOpen()) return false;
    var row = document.querySelector('.prop[data-field="' + field + '"]');
    if (!row) return false;
    var btn = row.querySelector(".prop-v .pick-chip.editable, .prop-v .linklike");
    if (!btn) return false;
    btn.click();
    return true;
  }

  // "G then <letter>" jumps to a view, Linear-style. A short-lived pending flag.
  var gPending = false, gTimer = null;
  function armG() { gPending = true; clearTimeout(gTimer); gTimer = setTimeout(function () { gPending = false; }, 1200); }
  function clearG() { gPending = false; clearTimeout(gTimer); }

  document.addEventListener("keydown", function (e) {
    var k = e.key.toLowerCase();

    // ⌘K / Ctrl-K toggles the palette from anywhere (even while typing).
    if ((e.metaKey || e.ctrlKey) && k === "k") {
      // …but not over a panel: a panel owns the screen, and the palette's own
      // commands open panels — that is the route by which they would stack. Still
      // preventDefault: "does nothing" has to mean nothing, and Chrome would
      // otherwise take Ctrl-K for its address bar and pull focus out of the modal.
      e.preventDefault();
      if (!cmdkVisible() && anyModalOpen()) return;
      cmdkVisible() ? closeCmdk() : openCmdk(); return;
    }

    // Escape unwinds exactly one layer: help → palette → (else) the puck detail,
    // which the modal-backdrop's own Escape listener closes. Consume the event for
    // the layers we handle so that later listener can't also fire and unwind two.
    if (k === "escape") {
      if (helpOpen()) { closeShortcutHelp(); e.stopImmediatePropagation(); return; }
      if (cmdkVisible()) { closeCmdk(); e.stopImmediatePropagation(); return; }
      // An open picker/sheet is the top layer, but openSurface() closes itself from
      // a capture-phase listener and stops the event there — so by the time this
      // runs there is no surface left. Removing the node here instead would strand
      // its scrim on screen and lock the page.
      return; // a bare puck: let the backdrop listener run closeModal()
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // While the shortcut-help overlay is open it owns the keyboard: only "?" (to
    // toggle it back off) does anything; every other bare key is swallowed.
    if (helpOpen()) {
      if (k === "?") { e.preventDefault(); closeShortcutHelp(); }
      return;
    }

    // Suppress bare commands while typing, while the palette is open, or while a
    // modal panel (New/Settings/prompt) owns the screen — including over an open puck.
    if (isTyping(e.target) || cmdkVisible() || anyModalOpen()) return;

    // "G <letter>" view jumps.
    if (gPending) {
      var jumped = true;
      // Samma tillgänglighetsvillkor som sidomenyn, titelväxlaren och paletten:
      // en vy som inte finns i någon av dem ska inte nås av en genväg heller.
      var open = {};
      viewsShown(viewCounts()).forEach(function (g) { g.keys.forEach(function (x) { open[x] = 1; }); });
      // `e` is kept beside `p`: it is what the row was called, and muscle memory is not
    // worth breaking to save a letter nobody else uses.
    var want = { a: "all", r: "ready", i: "inbox", p: "parents", e: "parents", s: "standalone", t: "attention" }[k];
      if (want && open[want]) setFocus(want);
      else jumped = false;
      clearG();
      if (jumped) { e.preventDefault(); return; }
    }

    // Field shortcuts only make sense with a puck open — and only when no surface
    // is up. Otherwise S/P/A/L stacks a second sheet on the first, and one Escape
    // takes them both (a capture listener does not stop its siblings on document).
    // The layers above a surface keep their keys: "?" and the palette are meant to
    // open on top of one, which is why this sits here and not in the guard above.
    if (detailOpen() && !openSurfaces.length) {
      if (k === "s") { if (triggerField("status")) e.preventDefault(); return; }
      if (k === "p") { if (triggerField("priority")) e.preventDefault(); return; }
      if (k === "a") { if (triggerField("agent")) e.preventDefault(); return; }
      if (k === "l") { if (triggerField("labels")) e.preventDefault(); return; }
    }

    // Global commands.
    if (k === "c") { e.preventDefault(); openNewPuckPanel(); return; }
    if (k === "/") { e.preventDefault(); openCmdk(); return; }
    if (k === "g") { e.preventDefault(); armG(); return; }
    if (k === "?") { e.preventDefault(); toggleShortcutHelp(); return; }
  });

  // ── shortcut help overlay ("?") ──
  var SHORTCUTS = [
    { keys: ["C"], desc: "Capture a new puck" },
    { keys: ["/"], desc: "Search / command palette" },
    { keys: ["⌘", "K"], desc: "Command palette" },
    { keys: ["G", "then", "A"], desc: "Go to All pucks" },
    { keys: ["G", "then", "R"], desc: "Go to Ready" },
    { keys: ["G", "then", "I"], desc: "Go to Inbox" },
    { keys: ["G", "then", "P"], desc: "Go to Parents" },
    { keys: ["G", "then", "T"], desc: "Go to Needs attention" },
    { keys: ["S"], desc: "Set status (open puck)" },
    { keys: ["P"], desc: "Set priority (open puck)" },
    { keys: ["A"], desc: "Set agent (open puck)" },
    { keys: ["L"], desc: "Edit labels (open puck)" },
    { keys: ["Esc"], desc: "Close / back out" },
    { keys: ["?"], desc: "This help" },
  ];
  var popHelpLayer = null;
  function closeShortcutHelp() {
    var o = document.querySelector(".shortcut-help");
    if (o) o.remove();
    if (popHelpLayer) { popHelpLayer(); popHelpLayer = null; }
  }
  function toggleShortcutHelp() {
    if (helpOpen()) { closeShortcutHelp(); return; }
    var overlay = el("div", "shortcut-help");
    var card = el("div", "sc-card");
    var head = el("div", "sc-head");
    head.appendChild(el("h2", "sc-title", "Keyboard shortcuts"));
    var x = el("button", "sc-close"); x.type = "button";
    // The "✕" it drew was also its accessible name; a path is aria-hidden, so the
    // name has to be said out loud now.
    x.setAttribute("aria-label", "Close");
    x.appendChild(icon("x", "x-icn"));
    x.addEventListener("click", closeShortcutHelp);
    head.appendChild(x);
    card.appendChild(head);
    var list = el("div", "sc-list");
    SHORTCUTS.forEach(function (s) {
      var row = el("div", "sc-row");
      var keys = el("div", "sc-keys");
      s.keys.forEach(function (kk) {
        if (kk === "then") keys.appendChild(el("span", "sc-then", "then"));
        else keys.appendChild(el("kbd", "sc-key", kk));
      });
      row.appendChild(keys);
      row.appendChild(el("div", "sc-desc", s.desc));
      list.appendChild(row);
    });
    card.appendChild(list);
    overlay.appendChild(card);
    // Click the backdrop (not the card) to dismiss. Esc is handled globally.
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeShortcutHelp(); });
    document.body.appendChild(overlay);
    // Take the keyboard, the way the palette does with its input. Without this the
    // overlay is only visually on top: focus stays wherever it was — in the sheet
    // underneath — and Tab walks that sheet's controls behind a panel the reader is
    // looking at. It also gives a screen reader something to announce.
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Keyboard shortcuts");
    overlay.tabIndex = -1;
    popHelpLayer = pushLayer([overlay]);
    try { overlay.focus({ preventScroll: true }); } catch (e) { overlay.focus(); }
  }

  var searchClear = document.getElementById("searchClear");
  searchClear.appendChild(icon("x", "x-icn"));
  var cmdkHint = document.getElementById("cmdkHint");
  function updateSearchClear() { searchClear.hidden = !searchInput.value; if (cmdkHint) cmdkHint.hidden = !!searchInput.value; }

  searchInput.addEventListener("input", function (e) {
    var typed = parseQuery(e.target.value.trim());
    var typedFields = {};
    typed.forEach(function (t) { if (t.field !== "text") typedFields[t.field + (t.neg ? "!" : "")] = 1; });
    // Predicates you didn't touch survive; a field you typed replaces that field.
    var kept = paletteBase.filter(function (t) { return !typedFields[t.field + (t.neg ? "!" : "")]; });
    setQueryTerms(kept.concat(typed));
    updateSuggestions();
    updateSearchClear();
  });
  searchInput.addEventListener("focus", function () {
    updateSuggestions(); // empty query shows the command palette
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
  // ── Filter popover (view-header) — refinements: Show done · Priority · Labels.
  // Sidebar = places (views/agents/repos); this popover = what narrows the view.
  // The chip row *is* the filter's display, so the button only needs to say whether
  // anything is on. Places are counted too: they narrow the board just as much.
  function activeFilterCount() {
    return chipsData().length;
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
  // ── the filter panel ────────────────────────────────────────────────────────
  // Additive, not a fixed set of sections: pick a field, then values. A new field
  // is a row in this registry — the growth problem the properties rail solved for
  // the detail view, solved here too.
  //
  // Repo and agent are deliberately absent. They are the sidebar's *places*, one
  // navigation dimension; their chips still show below the header so an active
  // place is visible and clearable, but you set them where you navigate.
  var FILTER_FIELDS = [
    {
      key: "status", label: "Status",
      values: function () {
        return DATA.statuses.map(function (s) { return { value: s, label: STATUS_LABEL[s] || s }; });
      },
    },
    {
      key: "priority", label: "Priority",
      values: function () {
        return PRIORITIES.map(function (p) { return { value: p, label: PRIORITY_LABEL[p] }; });
      },
    },
    {
      key: "tag", label: "Labels", search: "Filter labels…",
      values: function () {
        var n = {};
        DATA.items.forEach(function (it) { (it.tags || []).forEach(function (t) { n[t] = (n[t] || 0) + 1; }); });
        return Object.keys(n)
          .sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); })
          .map(function (t) { return { value: t, label: "#" + t }; });
      },
    },
    {
      // Parent: a real field (unlike repo/agent, which are places), so it filters
      // here. Only pucks that actually *are* parents are offered — a value that
      // matches nothing would be a trap.
      key: "parent", label: "Parent", search: "Filter parents…",
      values: function () {
        return DATA.items.filter(function (it) { return (it.children || []).length; })
          .map(function (it) { return { value: it.id, label: it.title }; });
      },
    },
    {
      key: "owner", label: "Owner",
      values: function () {
        var seen = {};
        DATA.items.forEach(function (it) { if (it.owner) seen[it.owner] = 1; });
        return Object.keys(seen).sort().map(function (o) { return { value: o, label: "@" + o }; });
      },
    },
    // Derived states — not fields, so they share the `is:` namespace, and `states`
    // marks a section as owning part of it.
    //
    // Three sections, not one list called State, because they were never one question.
    // A single list has to answer two ticks with one rule, and neither rule is right
    // for both cases: within a dimension a tick widens, so `parent` + `standalone` must
    // be a union — it asks for two of the three ways a puck can sit in the hierarchy,
    // and gave *nothing*; across dimensions each tick narrows, so `ready` + `member`
    // must stay an intersection — "ready, and inside a parent" is a question worth
    // asking, and a flat OR would have thrown it away to fix the first case.
    //
    // Not because a section's values exclude each other — they do not. A puck can be
    // `blocked` and `blocking` at once, and a parent nested in another parent is
    // `parent` and `member` both. Union is the facet convention rather than a fact
    // about the values: `tags` has always OR'd, and nobody reads two ticked labels as
    // "carries both". Ticking Blocked and Blocking others therefore asks for pucks
    // tangled in dependencies *either* way, and the pair that is both is simply in it
    // — the narrower "both directions at once" is the one reading this costs, and it
    // was never reachable from the panel anyway.
    //
    // Split, the panel's ordinary rule — or within a section, and between them — is
    // exactly right, with no special case for `is:` at all. The grouping also stops
    // being invisible: two ticks behave differently depending on which rows they are,
    // and now the reader can see why before clicking.
    {
      key: "dep", label: "Readiness", states: ["ready", "blocked", "blocking"],
      values: function () {
        return [
          { value: "ready", label: "Ready" },
          { value: "blocked", label: "Blocked" },
          { value: "blocking", label: "Blocking others" },
        ];
      },
    },
    {
      // Named for the question, not for the code's word for it (`hierarchy`): this
      // sits next to the Parent field, and the pair reads as *which* parent against
      // *whether* one.
      key: "membership", label: "Membership", states: ["parent", "member", "standalone"],
      values: function () {
        return [
          { value: "parent", label: "Is a parent" },
          { value: "member", label: "Has a parent" },
          { value: "standalone", label: "Standalone" },
        ];
      },
    },
    {
      // `adapted` is a property of the source rather than a drift signal, so this is
      // not "Signals" — the three are alike in being marks on the record, which is
      // what the name has to carry.
      key: "flags", label: "Flags", states: ["flagged", "stale", "adapted"],
      values: function () {
        return [
          { value: "flagged", label: "Needs attention" },
          { value: "stale", label: "Stale" },
          { value: "adapted", label: "Adapted source" },
        ];
      },
    },
  ];
  // A section writes `is:` terms, so its own key is not the field its values live
  // under. Everything that reads the query has to ask for the field; everything that
  // reads *this section's* part of it has to ask for the section.
  function qfieldOf(f) { return f.states ? "is" : f.key; }
  function sectionForState(v) {
    for (var i = 0; i < FILTER_FIELDS.length; i++) {
      if (FILTER_FIELDS[i].states && FILTER_FIELDS[i].states.indexOf(v) !== -1) return FILTER_FIELDS[i];
    }
    return null;
  }
  function ownsState(f, v) { return !f.states || f.states.indexOf(v) !== -1; }
  // The values of this section that are set. Three sections share one query field, so
  // a raw lookup would hand each of them the other two's ticks.
  function sectionValues(f, neg) {
    return filterValues(qfieldOf(f), neg).filter(function (v) { return ownsState(f, v); });
  }
  // Does this term belong to this section? A term is written per section, but a
  // hand-typed or older query can mix a section's values across several terms, so this
  // asks about the values rather than assuming the shape.
  function termInSection(t, f, neg) {
    return sameField(t, qfieldOf(f), neg) &&
      (!f.states || t.values.some(function (v) { return ownsState(f, v); }));
  }
  // Set this section to exactly `next`, as one term. Written by rebuild rather than by
  // edit-in-place: a query that already spread the section over several terms (an old
  // link, a typed query) is consolidated on the first tick instead of growing a fourth.
  function setSectionValues(f, next, neg) {
    var out = [];
    parseQuery(state.query).forEach(function (t) {
      if (!termInSection(t, f, neg)) { out.push(t); return; }
      var kept = t.values.filter(function (v) { return !ownsState(f, v); });
      if (kept.length) { t.values = kept; out.push(t); }
    });
    if (next.length) out.push({ field: qfieldOf(f), op: f.states ? "is" : "in", values: next, neg: !!neg });
    setQueryTerms(out);
  }
  function toggleSectionValue(f, value, neg) {
    if (!f.states) return toggleFilterValue(f.key, value, neg);
    var cur = sectionValues(f, neg);
    var at = cur.indexOf(value);
    setSectionValues(f, at === -1 ? cur.concat([value]) : cur.filter(function (v) { return v !== value; }), neg);
  }
  // Can this value match anything at all in this view? One that can't is a trap: it
  // commits, the board empties, and nothing says why. In Inbox that was every status
  // but `inbox`, plus `is:ready` and `is:done`. The Parent field already followed this
  // rule inside its own `values()` — this makes it the panel's rule instead of one
  // field's.
  //
  // Judged against the *view*, never against the filters already set, so ticking one
  // box never makes other values vanish from under your hand. (`countFor` answers a
  // different question — how many pucks the click would leave — and models the
  // toggle, so it stays non-zero for a value that matches nothing.) An active value
  // always survives, or there would be no way to un-tick it.
  function valueReachable(f, value) {
    var probe = viewTerms();
    probe.push({ field: qfieldOf(f), op: f.states ? "is" : "in", values: [value], neg: false });
    for (var i = 0; i < DATA.items.length; i++) if (runQuery(DATA.items[i], probe)) return true;
    return false;
  }
  function reachableValues(f) {
    var active = sectionValues(f, false).concat(sectionValues(f, true));
    return f.values().filter(function (v) {
      return active.indexOf(v.value) !== -1 || valueReachable(f, v.value);
    });
  }
  function fieldByKey(k) {
    for (var i = 0; i < FILTER_FIELDS.length; i++) if (FILTER_FIELDS[i].key === k) return FILTER_FIELDS[i];
    return null;
  }
  // How many pucks each candidate value would leave — counted against the *other*
  // active terms, so the numbers describe the click you're about to make.
  // How many of the cards you are looking at carry this value. One sentence, and the
  // same one on every row whether it is ticked or not.
  //
  // It used to model the *click* instead — "how many you would get if you pressed
  // this" — which for a ticked row meant "if you unticked it". Two different sentences
  // on rows that look identical, with nothing to say which you were reading: ticking
  // `Is a parent` on a board of 33 made its own number jump from 1 to 32, and 32 read
  // as a claim about how many parents there are.
  //
  // The other sections still apply, so the numbers describe the board you are on;
  // only this section's own ticks are lifted, or every unticked sibling would read 0
  // as soon as you ticked one of them. The values within a section overlap (a puck can
  // be blocked and blocking), so the numbers do not add up to what two ticks give —
  // which is true of every facet count anywhere and is not what they are for.
  function countFor(f, value) {
    // Strip this section's values rather than dropping whole terms: a *mixed* term —
    // `is:stale,member`, which the panel does not write but a link or a saved view can
    // carry — would otherwise take its `stale` half out of the count with it, and the
    // row would be counted against a board nobody is looking at.
    var probe = [];
    activeTerms().forEach(function (t) {
      if (!termInSection(t, f, false)) { probe.push(t); return; }
      var kept = t.values.filter(function (v) { return !ownsState(f, v); });
      if (kept.length) probe.push({ field: t.field, op: t.op, values: kept, neg: t.neg });
    });
    probe.push({ field: qfieldOf(f), op: f.states ? "is" : "in", values: [value], neg: false });
    var n = 0;
    DATA.items.forEach(function (it) { if (runQuery(it, probe)) n++; });
    return n;
  }

  var filterSurface = null;
  function toggleFilterMenu() {
    var wrap = filterBtn && filterBtn.parentNode;
    if (!wrap) return;
    if (filterSurface) { filterSurface.close(); return; }
    filterBtn.setAttribute("aria-expanded", "true");
    // The panel rebuilds itself in place (field list to value list), which detaches
    // the element you just clicked; openSurface's closer ignores targets that have
    // left the document, so a rebuild can't close the surface out from under you.
    filterSurface = openSurface({
      title: "Filter",
      anchorWrap: wrap,
      cls: "filter-pop",
      onClose: function () { filterSurface = null; filterBtn.setAttribute("aria-expanded", "false"); },
      build: function (body) { renderFieldList(body); },
    });
  }
  // Level 1: which field. Level 2 replaces it in place (with a way back), so the
  // popover never grows a third column on a phone.
  function renderFieldList(pop) {
    pop.innerHTML = "";
    surfaceLevel(pop); // level one: the surface's own name back in the head, no way back
    pop.appendChild(el("div", "fp-label", "Add filter"));
    FILTER_FIELDS.forEach(function (f) {
      if (!reachableValues(f).length) return; // nothing here could change this view
      var row = el("button", "fp-row");
      row.type = "button";
      row.appendChild(el("span", null, f.label));
      var on = sectionValues(f, false).length;
      if (on) row.appendChild(el("span", "fp-n", String(on)));
      row.appendChild(icon("chev-right", "fp-chev"));
      row.addEventListener("click", function () { renderValueList(pop, f); });
      pop.appendChild(row);
    });
  }
  function renderValueList(pop, f) {
    pop.innerHTML = "";
    surfaceLevel(pop, f.label, function () { renderFieldList(pop); });

    var all = reachableValues(f);
    var box = el("div", "fp-values");
    var searchBox = null;
    if (f.search && all.length > 8) {
      searchBox = el("input", "fp-search");
      searchBox.type = "text"; searchBox.placeholder = f.search;
      searchBox.autocomplete = "off"; searchBox.spellcheck = false;
      pop.appendChild(searchBox);
    }
    pop.appendChild(box);

    var CAP = 12, expanded = false;
    var more = el("button", "fp-more"); more.type = "button"; more.hidden = true;
    pop.appendChild(more);

    function paint() {
      box.innerHTML = "";
      var active = sectionValues(f, false);
      var q = searchBox ? searchBox.value.trim().toLowerCase() : "";
      var matches = all.filter(function (v) { return !q || v.value.indexOf(q) !== -1; });
      var collapsed = !q && !expanded && matches.length > CAP;
      (collapsed ? matches.slice(0, CAP) : matches).forEach(function (v) {
        var isOn = active.indexOf(v.value) !== -1;
        var row = el("label", "fp-val" + (isOn ? " on" : ""));
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = isOn;
        cb.addEventListener("change", function () { toggleSectionValue(f, v.value, false); paint(); });
        row.appendChild(cb);
        row.appendChild(el("span", "fp-vlabel", v.label));
        row.appendChild(el("span", "fp-n", String(countFor(f, v.value))));
        box.appendChild(row);
      });
      if (!matches.length) box.appendChild(el("div", "fp-empty", "Nothing to filter by"));
      if (!q && matches.length > CAP) {
        more.hidden = false;
        more.textContent = expanded ? "Show fewer" : "Show all " + matches.length;
      } else { more.hidden = true; }
    }
    more.addEventListener("click", function () { expanded = !expanded; paint(); });
    if (searchBox) searchBox.addEventListener("input", paint);
    paint();
  }

  // ── saved views ─────────────────────────────────────────────────────────────
  // A view is the whole tuple — scope + filter + grouping + ordering + layout —
  // named, in `board.config.json`. That file is *configuration*, not truth, so this
  // adds no second source: the pucks are still the only data. Saving one is a
  // commit, and who may save is decided by repo permissions — which is how we get
  // Linear's "set default for everyone" without building a role model.
  function savedViews() {
    var vs = (DATA.config && DATA.config.views) || [];
    return vs.filter(function (v) { return v && v.name; });
  }
  function paramsOf(v) {
    var o = {};
    VIEW_KEYS.forEach(function (k) {
      if (v[k] != null && v[k] !== "") o[k] = String(v[k]);
    });
    if (o.q) o.q = canonicalQuery(o.q); // compare like against like — see canonicalQuery
    // Through the same normaliser as the live board, or the two disagree — see
    // `effectiveParams`. This is the half that was missing.
    return effectiveParams(o);
  }
  function sameParams(a, b) {
    for (var i = 0; i < VIEW_KEYS.length; i++) {
      if ((a[VIEW_KEYS[i]] || "") !== (b[VIEW_KEYS[i]] || "")) return false;
    }
    return true;
  }
  function applySavedView(v) {
    exitPuckView();
    applyParams(paramsOf(v), true); // a saved view describes the whole board
    state.fromView = v.name; // after applyParams — its reset branch clears this
    refreshNav();
    renderBoard();
    maybeCloseMenu();
  }
  // Which saved view, if any, describes the board exactly as it stands. Asked in three
  // places — which saved row lights, and whether a built-in row should light in the
  // sidebar and in the title switcher — and all three must agree, or the chrome marks
  // two rows at once.
  function activeSavedView() {
    var now = viewParamObject(), vs = savedViews(), first = null, from = null;
    for (var i = 0; i < vs.length; i++) {
      if (vs[i].name === state.fromView) from = vs[i];
      if (!first && sameParams(paramsOf(vs[i]), now)) first = vs[i];
    }
    // Parameters are not an identity — duplicate a view and two entries describe the
    // board equally well — so provenance decides whenever it names a view that still
    // exists, and a match on some *other* view never outvotes it. Editing A until it
    // happened to equal B retitled you into B and took away A's own Update: you were
    // looking at B with no way to save the thing you were editing.
    if (from) return sameParams(paramsOf(from), now) ? from : null;
    // No provenance, or it named a view since deleted: the board was not reached
    // through a row (a pasted link, a reload) and can only speak for itself.
    return first;
  }
  // The saved view you are *in*, with changes on top. `activeSavedView()` answers
  // "does the board match a view exactly"; this answers "did you come from one and
  // change it", which no amount of looking at the board can tell you — hence the
  // remembered name. Both are needed and they are never both true: the pair is what
  // lets the chip row offer Update instead of a name field you have to retype.
  // A name whose view has since been deleted answers null, so the row can't offer to
  // update something that is gone.
  function editedSavedView() {
    if (!state.fromView || activeSavedView()) return null;
    // Emptied all the way back to the plain default board. That is not a view with
    // changes on top, it is having left the view — and the chip row is hidden here, so
    // an "(edited)" title would be the only thing left claiming you were still in one.
    if (!Object.keys(viewParamObject()).length) return null;
    var vs = savedViews();
    for (var i = 0; i < vs.length; i++) if (vs[i].name === state.fromView) return vs[i];
    return null;
  }
  // The ⋯ on a saved-view row. Its own positioned wrapper, because the surface anchors
  // inside it — and a <button> inside the row's <button> would be invalid, so the
  // wrapper is what the row actually contains.
  function savedViewMenu(v) {
    var wrap = el("span", "filter-wrap saved-more-wrap");
    // This wrapper sits inside the row's own <button>, and `openSurface` appends the
    // menu *into* it — so without this every click on a menu row also activated the row
    // behind it: `applySavedView` → `refreshNav` → the sidebar rebuilt and took the
    // still-open menu with it, before the action it had just picked could run. The ✕
    // this replaced guarded its single click the same way; a menu has more clicks than
    // one, so the guard belongs on the container rather than on each of them.
    wrap.addEventListener("click", function (e) { e.stopPropagation(); });
    var btn = el("button", "saved-more");
    btn.type = "button";
    btn.title = "Rename, duplicate or remove this view";
    btn.setAttribute("aria-label", "Actions for saved view " + v.name);
    btn.appendChild(icon("more"));
    var open = null;
    btn.addEventListener("click", function (e) {
      e.stopPropagation(); // the row behind navigates; the ⋯ is not navigation
      e.preventDefault();
      if (open) { open.close(); open = null; return; }
      open = openSurface({
        title: v.name,
        anchorWrap: wrap,
        // Mirrored, so the menu opens *into* the sidebar. `.sidebar` is a scroll
        // container (`overflow-y: auto`), which clips in both axes — hanging right from
        // a trigger at the sidebar's right edge put the labels behind that edge. This is
        // the one anchoring that fits: the menu is narrower than the sidebar's minimum.
        cls: "pick-menu menu-right",
        onClose: function () { open = null; },
        build: function (host, api) {
          function row(iconName, text, cls, run) {
            var b = el("button", "row" + (cls ? " " + cls : ""));
            b.type = "button";
            b.appendChild(icon(iconName));
            b.appendChild(el("span", null, text));
            // Deferred past the click that picked it, like the view switcher's own save
            // row: Rename opens a surface anchored in this same wrapper, and the tail of
            // the pointer event that closed us would reach it as an outside click.
            b.addEventListener("click", function () {
              api.close();
              setTimeout(run, 0);
            });
            host.appendChild(b);
          }
          row("edit", "Rename…", null, function () { renameSavedView(v); });
          row("plus", "Duplicate", null, function () { duplicateSavedView(v); });
          host.appendChild(el("div", "menu-rule"));
          row("trash", "Remove view", "danger", function () { removeSavedView(v); });
        },
      });
    });
    wrap.appendChild(btn);
    return wrap;
  }
  function buildSavedViews() {
    var host = document.getElementById("savedViews");
    var section = document.getElementById("savedSection");
    if (!host || !section) return;
    var views = savedViews();
    section.hidden = !views.length;
    host.innerHTML = "";
    if (!views.length) return;
    var active = activeSavedView(); // one producer — see the note in the title switcher
    var seg = el("div", "focusseg");
    views.forEach(function (v) {
      var on = v === active;
      var b = el("button", "focusbtn" + (on ? " on" : ""));
      b.type = "button";
      b.title = v.q || "Saved view";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.appendChild(el("span", "focus-label", v.name));
      b.addEventListener("click", function () { applySavedView(v); });
      // A ✕ and nothing else was the whole of "what can happen to this view once it
      // exists" — so renaming meant saving a copy under the new name and deleting the
      // old one: two commits, and two identical-looking rows in between. Three actions
      // do not fit on one button, so it becomes the same ⋯ the columns use.
      if (ghToken()) b.appendChild(savedViewMenu(v));
      seg.appendChild(b);
    });
    host.appendChild(seg);
  }
  // Both writes go through the same helper: read the config, change `views`, commit.
  function writeViews(views, message, done) {
    var repo = aggregatorRepo();
    if (!repo) { toast("✗ No aggregator repo configured", true); return; }
    toast("Saving…");
    // Where the board stood when the request left. A commit is a network round trip,
    // and every one of these callbacks claims a provenance — so if you navigate while
    // one is in flight, the reply would land on top of where you went: the destination
    // titled as the view you just wrote, with an Update aimed at overwriting it with
    // the destination's own parameters. Your navigation is the newer truth. The write
    // still lands; only the claim on "which view you are in" defers to it.
    var wroteFrom = state.fromView;
    commitViews(repo, views, message)
      .then(function () {
        DATA.config = DATA.config || {};
        DATA.config.views = views; // optimistic: the harvest will confirm it
        // Before the repaint, not after: every one of these callbacks adjusts the
        // provenance the repaint is about to read. Renaming the view you were editing
        // ran it afterwards, so the paint in between looked up a name that no longer
        // existed, decided you were in no view at all, and dropped the edited title and
        // its Reset/Update — with nothing scheduled to paint again and put them back.
        if (done && state.fromView === wroteFrom) done();
        // The same repaint a navigation does, and for the same reason: this write
        // changes the answer to "which saved view describes the board", which the
        // header, the built-in view rows and the saved rows all read. Rebuilding
        // only the saved rows left the other two on the previous answer — the
        // header naming a view you just deleted, and `All pucks` still lit beside
        // the view you just saved. One store, one repaint.
        refreshNav(); renderBoard();
        toast("✓ Saved — live in ~1 min");
      })
      .catch(function (err) { toast("✗ " + err.message, true); });
  }
  function commitViews(repo, views, message) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + repo + "/contents/board.config.json";
    var errItem = { repo: repo, repoName: repo };
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api, { headers: headers })
      .then(function (r) { assertOk(r, errItem); return r.json(); })
      .then(function (info) {
        var cfg = {};
        try { cfg = JSON.parse(b64decode(info.content)); } catch (e) {}
        if (views.length) cfg.views = views; else delete cfg.views;
        var out = JSON.stringify(cfg, null, 2) + "\n";
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: message, content: b64encode(out), sha: info.sha }),
        });
      })
      .then(function (r) { assertOk(r, errItem); });
  }

  // ── Sync now: ask CI for a fresher harvest, from the board ──────────────────
  // The board is a static artifact. What it shows was harvested by `sync.yml` at
  // `generatedAt` and is frozen until that workflow runs again — hourly, or on a push
  // to this repo. So a puck edited in *this* repo lands within a minute, and a puck
  // edited in any other source repo waits up to an hour. The person doing the waiting
  // is, by definition, standing at the board looking at the date in the footer.
  //
  // Hence one button, next to that date, driving one GitHub primitive:
  // `workflow_dispatch`, which `sync.yml` already accepts. No relay, no webhook, no
  // always-on service, no second source of truth — the same "close thin, via GitHub"
  // rule the write path follows, and the Worker stays a pure assets Worker.
  //
  // What it costs: the token needs `Actions: write` on the aggregator repo, which the
  // editing token does not carry (`Contents: write` on the source repos is a different
  // permission). That is the likely failure, so it gets a sentence naming the fix
  // rather than a status code — see `syncError`.
  var SYNC_POLL_MS = 4000;
  // The run clones seven repos, harvests and deploys — a minute or two, plus whatever
  // queue GitHub puts it in. Five minutes is long enough that expiring means something
  // went wrong, and short enough that the button comes back while you still care.
  var SYNC_TIMEOUT_MS = 5 * 60 * 1000;
  var syncing = false;
  var syncWrap = null, syncBtn = null, syncBar = null;
  // The receipt has to outlive the page that earned it: `finishSync` reloads, which
  // destroys every toast and the state that knows the run succeeded. So the fact is
  // handed across the reload in sessionStorage — per tab and per origin, which is
  // exactly this receipt's scope, and dropped by the browser on its own.
  //
  // What is stored is the generatedAt the board had *before* the sync, so the message
  // after boot can be checked rather than asserted: a different timestamp is proof the
  // data moved, and an identical one is its own honest sentence instead of a "✓ Synced"
  // over unchanged data.
  var SYNCED_KEY = "roadmap-synced-from";

  // Config, not truth — an instance that harvests some other way sets `syncWorkflow`
  // to false and the button is simply absent, rather than offering a dispatch that
  // resolves to no workflow.
  function syncWorkflow() {
    return CFG.syncWorkflow === undefined ? "sync.yml" : CFG.syncWorkflow;
  }
  function syncRef() { return CFG.syncBranch || "main"; }
  // The workflow lives in the aggregator repo, never in a puck's source repo: an edit
  // commits to whichever repo owns the puck, but the harvest runs in exactly one place.
  function canSync() { return !!ghToken() && !!syncWorkflow() && !!aggregatorRepo(); }
  function syncApi(tail) {
    return "https://api.github.com/repos/" + aggregatorRepo() + "/actions/workflows/" +
      encodeURIComponent(syncWorkflow()) + tail;
  }
  function syncError(r) {
    // 403 is the permission the token most likely lacks; 404 is what GitHub answers
    // for a workflow the token cannot see, which has the same fix. Naming the
    // permission is the difference between one checkbox and a hunt through the docs.
    if (r.status === 403 || r.status === 404) {
      return new Error("no permission to sync — your token needs Actions: write on " + aggregatorRepo());
    }
    return new Error("sync failed (" + r.status + ")");
  }
  function syncGet(url) {
    return fetch(url, { headers: { Authorization: "Bearer " + ghToken(), Accept: "application/vnd.github+json" } })
      .then(function (r) { if (!r.ok) throw syncError(r); return r.json(); });
  }
  // The newest dispatched run, or null. Runs come back newest-first.
  function latestRun() {
    return syncGet(syncApi("/runs?event=workflow_dispatch&per_page=1"))
      .then(function (d) { return ((d && d.workflow_runs) || [])[0] || null; });
  }
  // Wait for *our* run, then for it to finish. Two waits and not one: the run does not
  // exist yet when the dispatch returns its 204, and treating "no newer run" as "done"
  // would reload the page onto exactly the data it already had.
  //
  // It is told from the run before it by id, never by timestamp. `created_at` has
  // second granularity and comes from GitHub's clock rather than this browser's, so a
  // time comparison mis-picks whenever the two disagree — and the two failures that
  // buys are a poll that waits on an already-finished run, and one that reloads before
  // its own run has started. Ids only ever increase, and need no clock at all.
  function awaitRun(since, deadline) {
    return latestRun().then(function (run) {
      var mine = run && run.id > since ? run : null;
      if (mine && mine.status === "completed") return mine;
      if (Date.now() > deadline) return null;
      return new Promise(function (ok) { setTimeout(ok, SYNC_POLL_MS); })
        .then(function () { return awaitRun(since, deadline); });
    });
  }
  // The board reads `window.__ROADMAP__` once, at boot, and every derived thing —
  // the columns, the counts, the signal flags — is built from that one read. Rendering
  // a freshly fetched payload in place would mean a second boot path to keep in step
  // with the first, so the page reloads instead. `data/roadmap.js` is served with an
  // ETag and no far-future max-age, so the reload revalidates and gets the new file.
  //
  // This one step is *not* behind the demo's fetch seam, because it is not a fetch.
  // The demo answers GitHub inside the page and keeps its edits in memory, so a reload
  // there would throw away the work the visitor just did and re-seed from the fixture
  // — a "sync" that undoes your changes is not the feature being demonstrated.
  function finishSync() {
    if (DEMO) { toast("✓ Sync finished — the live board reloads here"); return; }
    try { sessionStorage.setItem(SYNCED_KEY, DATA.generatedAt || ""); } catch (e) {}
    location.reload();
  }
  // Read at boot: the other half of the reload. Without it the run ends by restoring
  // the page to exactly the state it started in — the button back at `sync now`, no
  // message, the one changed fact below the fold — which is indistinguishable from
  // having pressed nothing, and is why the button got pressed twice.
  function reportSyncOnBoot() {
    var before;
    try {
      before = sessionStorage.getItem(SYNCED_KEY);
      sessionStorage.removeItem(SYNCED_KEY); // a receipt is shown once, not on every reload
    } catch (e) { return; }
    if (before == null) return;
    var now = DATA.generatedAt || "";
    var at = now.slice(11, 16); // HH:MM of the harvest this page is showing
    // Unchanged is not a failure and not a success worth dressing up: the harvest is
    // idempotent, so a run over sources nobody touched legitimately produces the same
    // payload — and a cached `data/roadmap.js` would look the same from here. One
    // sentence covers both without claiming which.
    toast(now && now !== before
      ? "✓ Synced — data from " + at + " UTC"
      : "✓ Sync finished — no change since " + at + " UTC");
  }
  function runSync() {
    if (syncing || !canSync()) return;
    syncing = true;
    refreshSyncButton();
    var deadline = Date.now() + SYNC_TIMEOUT_MS;
    latestRun()
      .then(function (prev) {
        var since = prev ? prev.id : 0;
        return fetch(syncApi("/dispatches"), {
          method: "POST",
          headers: {
            Authorization: "Bearer " + ghToken(),
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: syncRef() }),
        }).then(function (r) {
          if (!r.ok) throw syncError(r);
          return awaitRun(since, deadline);
        });
      })
      .then(function (run) {
        if (!run) { toast("Sync is taking longer than usual — it will finish on its own; reload then.", true); return; }
        if (run.conclusion === "success") return finishSync();
        // `sync.yml` runs under `concurrency: cancel-in-progress`, so a push landing
        // mid-run cancels ours — and the run that replaced it harvests the same
        // sources, so nothing was lost and there is nothing to repair. Calling that
        // "failed" would send someone to read a log about a run cancelled on purpose.
        if (run.conclusion === "cancelled") {
          toast("A newer sync replaced this one — reload in a minute.", true);
          return;
        }
        toast("✗ Sync " + (run.conclusion || "failed"), true);
      })
      .catch(function (err) { toast("✗ " + err.message, true); })
      .then(function () { syncing = false; refreshSyncButton(); });
  }
  function refreshSyncButton() {
    // Ahead of the guard: the bar is the signal for the case where the footer is not
    // on screen, so it must not be gated on the footer's own elements existing.
    if (syncBar) syncBar.hidden = !syncing;
    if (!syncWrap || !syncBtn) return;
    syncWrap.hidden = !canSync();
    syncBtn.disabled = syncing;
    // The label says what the button is doing; `.syncbar` says the run is alive. It
    // used to be the whole progress indicator, which was only true where the footer is
    // visible — and the wait is a minute or two spent scrolled down the board or inside
    // a puck, neither of which shows it.
    syncBtn.textContent = syncing ? "syncing…" : "sync now";
  }

  function saveCurrentView(wrap, cls) {
    var params = viewParamObject();
    // The title switcher and ⌘K offer this door unconditionally and lean on the refusal
    // here, so this is the one place the rule can live for all three. It used to ask
    // only whether the board was the *default*, which let an untouched built-in view
    // through: "Ready" would commit to board.config.json as a saved view identical to
    // the row above it.
    if (!Object.keys(ownParams()).length) {
      toast(params.view
        ? "✗ Nothing to save — “" + ((VIEW_DEFS[params.view] || {}).label || params.view) + "” is already a view"
        : "✗ Nothing to save — this is the default board", true);
      return;
    }
    inputSurface(wrap || null, {
      cls: cls,
      title: "Save view",
      placeholder: "Name this view",
      hint: DEMO
        ? "It joins the list behind the title — in this browser only, nothing is committed."
        : "Saved to board.config.json as a commit — it joins the list behind the title.",
      action: "Save",
      onSave: function (name) {
        name = String(name).trim();
        if (!name) return;
        // Same name = replace, **in place**. It used to filter the old one out and push
        // the new one on the end, so saving over a view silently moved it to the bottom
        // of the sidebar: an edit that reorders the list is doing something it never
        // said it would.
        writeViews(withView(savedViews(), name, params), "roadmap: save view “" + name + "”",
          function () { state.fromView = name; }); // you are now in the view you just made
      },
    });
  }
  // The one place a view's parameters are written into the list: replace the entry of
  // that name where it stands, or append when the name is new. Save and update both go
  // through it, so neither can invent its own ordering rule.
  function withView(views, name, params) {
    var out = views.slice(), entry = { name: name }, at = -1;
    for (var k in params) entry[k] = params[k];
    for (var i = 0; i < out.length; i++) if (out[i].name === name) { at = i; break; }
    if (at < 0) out.push(entry); else out[at] = entry;
    return out;
  }
  // "Update High" — the action that was missing. Editing a saved view meant pressing
  // Save and retyping its name exactly: replace-by-collision, where nothing said it
  // would overwrite, a typo made a duplicate, and the name field was the only way to
  // aim. Here the target is the view you are standing in, so there is nothing to aim.
  function updateSavedView(v) {
    var params = viewParamObject();
    if (!Object.keys(params).length) { toast("✗ Nothing to save — this is the default board", true); return; }
    writeViews(withView(savedViews(), v.name, params), "roadmap: update view “" + v.name + "”",
      function () { state.fromView = v.name; });
  }
  function renameSavedView(v) {
    // Unanchored — a centred surface on desktop, a sheet on a phone. The field is 340px
    // at its widest and the sidebar can be dragged down to 190, so anchoring it to the
    // row would either hang it off the left of the page (mirrored) or bury it behind the
    // sidebar's own overflow (not mirrored). There is no width where both hold, and a
    // one-field rename is the kind of task a centred surface is for anyway.
    inputSurface(null, {
      title: "Rename view",
      value: v.name,
      placeholder: "Name this view",
      hint: "Only the name changes — the view keeps its parameters and its place in the list.",
      action: "Rename",
      onSave: function (name) {
        name = String(name).trim();
        if (!name || name === v.name) return;
        // Renaming onto a name that already exists would leave two rows labelled the
        // same and `withView` unable to say which one a later save means. Drop the
        // other — the rule the save path has always applied to a name clash.
        var views = savedViews().filter(function (x) { return x === v || x.name !== name; });
        var at = views.indexOf(v);
        if (at < 0) return;
        var entry = {};
        for (var k in v) entry[k] = v[k];
        entry.name = name;
        views[at] = entry;
        writeViews(views, "roadmap: rename view “" + v.name + "” → “" + name + "”",
          function () {
            // Provenance follows the entry, not the name. Two ways it moves here:
            if (state.fromView === v.name) state.fromView = name; // you were in the view being renamed
            // …or the new name collided with the view you *were* in, and the filter
            // above dropped it. Leaving the name set pointed it at the renamed entry
            // instead, so a board still showing the deleted view read as "B (edited)"
            // and Update offered to write those parameters over an unrelated view.
            else if (state.fromView === name) state.fromView = null;
          });
      },
    });
  }
  // Branch off a view without losing it — the answer to "I want High, but also scoped
  // to one repo". Named automatically and dropped in beside its original rather than at
  // the end, because a copy belongs next to what it came from; Rename is one row away
  // in the same menu.
  function duplicateSavedView(v) {
    var taken = {};
    savedViews().forEach(function (x) { taken[x.name] = 1; });
    var base = v.name + " copy", name = base, n = 2;
    while (taken[name]) name = base + " " + n++;
    var views = savedViews().slice(), entry = {};
    for (var k in v) entry[k] = v[k];
    entry.name = name;
    views.splice(views.indexOf(v) + 1, 0, entry);
    // Land in the copy — *the whole copy*. Claiming its name while leaving the board
    // where it was made the title read "X copy (edited)" over a filter that had nothing
    // to do with it, and Update then offered to overwrite the copy with that filter.
    // Duplicating a view is a way of going to it, so go: `applySavedView` sets the
    // parameters and the provenance together, which is also what tells the two
    // identical entries apart (see `activeSavedView`).
    writeViews(views, "roadmap: duplicate view “" + v.name + "”",
      function () { applySavedView(entry); });
  }
  function removeSavedView(v) {
    if (!window.confirm("Remove the saved view “" + v.name + "”?")) return;
    writeViews(savedViews().filter(function (x) { return x !== v; }), "roadmap: remove view “" + v.name + "”",
      function () { if (state.fromView === v.name) state.fromView = null; });
  }

  // ── the chip row ────────────────────────────────────────────────────────────
  // Every active predicate, visible and individually removable — the filter's own
  // display, so the Filter button needs no count and "showing more" can never read
  // as "you have narrowed something".
  var chipRow = document.getElementById("chipRow");
  var viewActs = document.getElementById("viewActs");
  // Is this term nothing but "hide these columns", and are those columns in the tray?
  // Only the two shapes the column ⋯ writes, and only in the polarity that hides:
  // `columnTerm` calls that `hideNeg`, and it differs between a real value (the
  // *negation* hides it) and the absence bucket (`has:<field>`, where the positive
  // does). A term in the other polarity is a scope you chose, not a column you hid —
  // `Status: Now, Next, Later` says what you asked for, and the tray listing what fell
  // outside it is a different sentence, not a second copy of this one. It also has to
  // keep its chip so `Clear all` has something to hang on.
  function hiddenByTray(t) {
    if (!trayColumns) return false;
    var g = trayColumns.g;
    if (!termAboutGroup(t, g)) return false;
    // The absence bucket, and only when the term is *nothing but* that constraint. The
    // rule the chip row stands down for is the exact duplicate — a term that says no
    // more than "hide these columns" — and a multi-value `is:` can now say more:
    // `is:stale,member` also filters by staleness, and suppressing its chip left that
    // half invisible on the board and unreachable from the row that exists to remove
    // it, while the tray looked like it accounted for the whole predicate. `has:` is
    // single-valued by construction, so the length test simply always passes there.
    if (t.field === "has" || t.field === "is") {
      return !t.neg && t.values.length === 1 && !!trayColumns.keys[NO_VALUE];
    }
    if (!t.neg) return false;
    return t.values.every(function (v) {
      return Object.keys(trayColumns.keys).some(function (k) { return valueNamesColumn(g, v, k); });
    });
  }
  function chipsData() {
    var out = [];
    // Places are deliberately absent. A repo or a discipline queue is somewhere you
    // *navigated to*, not a predicate you added: the sidebar marks the row you are on
    // and the title says its name, so a third statement of the same fact — worded as
    // `Repo: PIA ×`, in the row that lists what you have narrowed — read as a filter
    // you had accidentally left on. The way out of a place is the way in: the sidebar
    // row, or the title switcher's All pucks. (`Clear all` still releases them, since
    // that one means "put everything back".)
    var terms = parseQuery(state.query);
    terms.forEach(function (t, i) {
      // A place the sidebar already shows is not chipped twice. This used to happen by
      // accident — places lived in their own Sets and simply were not in `state.query`
      // — and is now a stated rule about *presentation*, which is all it ever was. The
      // negation is not a place (there is no row for "not PIA"), so it keeps its chip.
      if (!t.neg && PLACE_FIELDS_ORDER.indexOf(t.field) !== -1) return;
      // Nor a term the tray is already showing, in the words the tray uses. `Not
      // Status: Done ×` in this row and `Done 102 👁` at the end of the board are the
      // same statement and the same single click — except one of them carries the
      // count, which is the thing you actually want to know before deciding to bring
      // the column back. So the tray keeps it and the chip stands down: a column
      // missing from the board is said in one place, and it is the place that is about
      // columns. Only in the board layout — `trayColumns` is null where there is no
      // tray, and then the chip is the only one who can say it.
      if (hiddenByTray(t)) return;
      var f = fieldByKey(t.field);
      var label;
      if (t.field === "text") label = "“" + t.values[0] + "”";
      else if (t.field === "is") label = (t.neg ? "Not " : "") + t.values.join(", ");
      // Read as the column it hides, not as the predicate it is: `has:priority` is
      // how "hide the No priority column" is spelled, so that is what it should say.
      else if (t.field === "has") {
        var hl = (fieldByKey(t.values[0]) || {}).label || t.values[0];
        label = t.neg ? "No " + lower(hl) : "Has " + lower(hl);
      }
      else if (f) label = f.label + ": " + t.values.map(function (v) { return valueLabel(f, v); }).join(", ");
      else if (PLACE_FIELDS[t.field]) {
        var pf = PLACE_FIELDS[t.field];
        label = pf.label + ": " + t.values.map(pf.value).join(", ");
      }
      // The last resort prints the term itself — with its sign stripped, because the
      // "Not " prefix below adds one. Together they read "Not -repo:roadmap": two
      // minus signs for one negation. Any field that lands here from now on is only
      // missing a name, not a second negative.
      else label = serializeTerms([{ field: t.field, op: t.op, values: t.values, neg: false }]);
      out.push({
        label: (t.neg && t.field !== "is" && t.field !== "has" ? "Not " : "") + label,
        remove: function () {
          var rest = parseQuery(state.query).filter(function (_, j) { return j !== i; });
          setQueryTerms(rest);
          refreshNav(); // a removed term can change what the sidebar reads as pressed
        },
      });
    });
    return out;
  }
  // Repo and agent are absent from FILTER_FIELDS on purpose — they are the sidebar's
  // places, not panel dimensions — so `fieldByKey` finds nothing for them and the chip
  // row fell through to printing the raw term. Naming them here rather than adding them
  // to FILTER_FIELDS keeps that decision intact: this is how a term is *written*, not a
  // dimension you can filter by. Reachable in one click ever since a repo column could
  // be hidden; before that it needed a hand-typed query, which is why it sat unseen.
  var PLACE_FIELDS = {
    repo: { label: "Repo", value: function (v) { return repoNameOf(resolveRepo(v) || v) || v; } },
    agent: { label: "Agent", value: function (v) { return agentLabel(v); } },
  };

  function valueLabel(f, v) {
    var all = f.values();
    for (var i = 0; i < all.length; i++) if (all[i].value === v) return all[i].label;
    return v;
  }
  function renderChips() {
    if (!chipRow) return;
    var chips = chipsData();
    chipRow.innerHTML = "";
    chips.forEach(function (c) {
      var chip = el("span", "fchip");
      chip.appendChild(el("span", "fchip-label", c.label));
      var x = el("button", "fchip-x");
      x.appendChild(icon("x", "x-icn"));
      x.type = "button";
      x.setAttribute("aria-label", "Remove filter " + c.label);
      x.addEventListener("click", function () { c.remove(); });
      chip.appendChild(x);
      chipRow.appendChild(chip);
    });
    // The view's actions sit on the Filter/Display row, not here — and that is a move,
    // with the old reasoning worth keeping because it was right about half of it. Saving
    // lived only behind the title, which is the right *home* for it (the saved view appears
    // there), but not where you are standing when you finish building a filter; so the door
    // went where the work is. What changed underneath that: a view can now be nothing but a
    // display, so "the work" is no longer always the chips — and on a board whose only
    // change was a grouping, this row was a 49px band on a 390px phone holding one
    // right-aligned button and nothing else.
    //
    // The clinching argument is written two paragraphs down, in this row's own hiding
    // rule: it could not hide when it had no chips, because it was also carrying Reset and
    // Update for a view whose changes are all display. That was a compromise the row was
    // forced into, and moving the actions out is what releases it — `chipRow.hidden` is now
    // simply "no chips".
    //
    // `Clear all` stays, because it is not a view action: it is the chips' own bulk ✕, and
    // putting a destructive filter command next to Save and Update is a worse neighbourhood
    // than the one it leaves.
    //
    // Which door depends on where the board stands relative to the saved views, and
    // the two producers answer that between them:
    //
    //   in a view, untouched  → nothing. Offering "Save view" here invites you to save
    //                           what is already saved; the sidebar row and the title
    //                           already say where you are, and each chip keeps its ✕.
    //   in a view, changed    → Reset · Update "High". Reset goes back to the view's
    //                           parameters, which is what makes it a different button
    //                           from Clear all — that one empties the board.
    //   no view               → Clear all · Save view, as before.
    if (viewActs) viewActs.innerHTML = "";
    var acts = el("div", "fchip-acts"); // this row's own half: `Clear all`
    var inView = activeSavedView(), edited = editedSavedView();
    function act(cls, label, title, run) {
      var b = el("button", cls, label);
      b.type = "button";
      if (title) b.title = title;
      b.addEventListener("click", run);
      (viewActs || acts).appendChild(b);
      return b;
    }
    if (edited) {
      act("fchip-clear", "Reset", "Back to the saved view’s own filters", function () {
        applySavedView(edited);
      });
      // Same token gate as Save: this writes board.config.json, and an affordance that
      // cannot do its job is worse than an absent one.
      if (ghToken()) act("fchip-save", "Update “" + edited.name + "”",
        "Save these changes into the view", function () { updateSavedView(edited); });
    } else if (!inView) {
      if (chips.length > 1) {
        var clear = el("button", "fchip-clear", "Clear all");
        clear.type = "button";
        clear.addEventListener("click", function () {
          setQueryTerms([]); // one store, so "put everything back" is one line
          refreshNav();
        });
        acts.appendChild(clear);
      }
      // Gated on there being anything worth naming, not on there being chips: a view can
      // be nothing but a grouping (`Testvy` is exactly that), and `saveCurrentView` still
      // refuses with a toast for the cases this never proposes. `worthNaming` is where the
      // difference between an offer and a permission is written down — it keeps the button
      // off the default board, off an untouched built-in view, and off a board whose only
      // difference is the layout.
      if (ghToken() && worthNaming()) {
        var wrap = el("div", "filter-wrap"); // the positioned parent the popover anchors in
        var save = el("button", "fchip-save", "Save view");
        save.type = "button";
        save.title = "Save these filters as a named view";
        save.addEventListener("click", function (e) {
          e.stopPropagation(); // this row is not a surface; the tail would read as an outside click
          // The trigger is the last thing on its row, so the menu hangs from its right
          // edge or it runs off the page.
          saveCurrentView(wrap, "menu-right");
        });
        wrap.appendChild(save);
        (viewActs || acts).appendChild(wrap);
      }
    }
    if (acts.childNodes.length) chipRow.appendChild(acts);
    // Simply "no chips" now. It used to have to stay open without them, because it was
    // also carrying Reset and Update for a view whose every change is a display one — the
    // view whose only other write path is retyping its name exactly, so the last place
    // those may go missing. With the actions on the row above, the row can mean what it is
    // named after again.
    chipRow.hidden = !chips.length;
  }

  if (filterBtn) filterBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleFilterMenu(); });


  // ── boot ──
  // Deploy-your-own config: title/description/source link come from
  // board.config.json (embedded in the payload), so nothing here is hardcoded
  // to one owner. Falls back to the static HTML defaults when absent.
  var CFG = DATA.config || {};
  // Optional ribbon banner (config-driven, e.g. the live-demo strip) — rendered
  // here so the demo's chrome isn't baked into index.html, which lets the mirror
  // ship index.html verbatim and keep the demo's structure in sync with the tool.
  // In demo mode the band is not optional. A visitor who creates a puck and sees it
  // land has to be told, on screen and without hunting, that it went nowhere — a toast
  // that says "✓ Created" is true and still misleading on its own.
  var ribbonText = CFG.ribbon || (DEMO ? "**live demo**" : "");
  if (DEMO) ribbonText += " · editable — changes stay in this browser, nothing is committed";
  if (ribbonText) {
    var ribbon = el(CFG.ribbonHref ? "a" : "div", "demo-ribbon");
    ribbon.innerHTML = renderMd(ribbonText).replace(/^<p>|<\/p>\s*$/g, "");
    if (CFG.ribbonHref) { ribbon.href = CFG.ribbonHref; }
    document.body.insertBefore(ribbon, document.body.firstChild);
  }
  if (CFG.title) {
    document.title = CFG.title;
    var h1 = document.querySelector(".brand h1");
    if (h1) h1.textContent = CFG.title;
  }
  var brandMark = document.getElementById("brandMark");
  if (brandMark) brandMark.appendChild(icon("merge", "brand-glyph"));
  // The three disclosure carets were the typographic ▾ in the markup; they are the
  // set's chevrons now, filled here for the same reason the brand glyph is.
  [].forEach.call(document.querySelectorAll(".ws-caret, .vs-caret"), fillCaret);
  if (CFG.description) {
    var descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute("content", CFG.description);
  }
  var sourceLink = document.getElementById("sourceLink");
  if (sourceLink) {
    if (CFG.repoUrl) sourceLink.href = CFG.repoUrl;
    else sourceLink.style.display = "none"; // no repo configured → hide the dead link
  }

  // Before anything can write: the seam has to be in place ahead of the first render,
  // because the writable-repo probe fires from there.
  if (DEMO) installDemoGitHub();
  buildModal();
  readUrl(); // a shared link decides the view before anything paints it
  buildRepoChips();
  buildAgentChips();
  buildFocusControl();
  buildSavedViews();
  renderBoard();

  // ── mobile drawer: the sidebar slides in over a scrim ──
  var appEl = document.getElementById("app");
  var scrimEl = document.getElementById("scrim");
  var menuBtn = document.getElementById("menuToggle");
  if (menuBtn) menuBtn.appendChild(icon("sidebar"));
  // Inject the Feather glyphs into the chrome buttons (label buttons get the icon
  // first, icon-only buttons just get it). Kept in JS so all icons share ICONS.
  [["sideSearch", "search", true], ["sideNew", "plus", true], ["filterBtn", "filter", true],
   ["displayBtn", "sliders", true],
   ["topSearch", "search", false], ["topNew", "plus", false]].forEach(function (spec) {
    var elm = document.getElementById(spec[0]);
    if (!elm) return;
    var ic = icon(spec[1]);
    if (spec[2]) elm.insertBefore(ic, elm.firstChild); else elm.appendChild(ic);
  });
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
  // TOKEN_KEY itself is declared at the top of the file, not here — see the note there.
  function ghToken() {
    // The demo's sentinel unlocks every write affordance in one line rather than fifty.
    // `ghToken()` is the gate on all of them — the `+` in a column, Save view, the
    // editable rail rows, drag-to-status — so a board that answers it truthfully is a
    // board that demonstrates the read half of a product whose claim is read *and*
    // write. What stops the writes is the `fetch` seam in `installDemoGitHub`, not this.
    if (DEMO) return "demo";
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function setGhToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  // Answers api.github.com from inside the page. Everything else — the gates, the
  // optimistic updates, the rollbacks — is the production path, untouched.
  //
  // A map of path → content, not a fixed placeholder: a field edit reads the file,
  // rewrites one line and commits against that read's sha, so the second edit of a puck
  // has to read back what the first one wrote. Without that, editing twice would build
  // the second change on the original text and the demo would quietly lie about what
  // the product does.
  function installDemoGitHub() {
    var files = {}; // "owner/repo:path" → text
    var sha = 0;
    // Sync's run counter. It starts at 1 so the first read (the one `runSync` takes
    // *before* dispatching) has a run to answer with, and the dispatch bumps it — which
    // is exactly the "a newer id appeared" the poll is waiting for. A fixed id would
    // have let the poll resolve on the previous run and made the demo skip the wait it
    // exists to show.
    var dispatched = 1;
    var real = window.fetch.bind(window);
    var json = function (body, status) {
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: status || 200, headers: { "Content-Type": "application/json" },
      }));
    };
    // The file as it would be on disk, rebuilt from the item the board already holds.
    // Only used on a first read; after that the map has the real thing.
    function seed(repo, path) {
      var it = null;
      for (var i = 0; i < DATA.items.length; i++) {
        if (DATA.items[i].repo === repo && DATA.items[i].sourcePath === path) { it = DATA.items[i]; break; }
      }
      if (!it) return "---\ntitle: Untitled\nstatus: inbox\nupdated: " + today() + "\n---\n\n";
      // Quoted the same way `puckTemplate` quotes it — `formatValue` lives in the CLI,
      // not here, and reaching for it threw the first time this ran.
      var t = /[:#]/.test(it.title) ? JSON.stringify(it.title) : it.title;
      var fm = ["---", "title: " + t, "status: " + it.status];
      if (it.tags && it.tags.length) fm.push("tags: [" + it.tags.join(", ") + "]");
      if (it.priority) fm.push("priority: " + it.priority);
      if (it.agent) fm.push("agent: " + it.agent);
      if (it.owner) fm.push("owner: " + it.owner);
      if (it.target) fm.push("target: " + it.target);
      if (it.parent) fm.push("parent: " + it.parent);
      if (it.depends && it.depends.length) fm.push("depends: [" + it.depends.join(", ") + "]");
      if (it.issue) fm.push("issue: " + it.issue);
      fm.push("updated: " + (it.updated || today()));
      if (it.created) fm.push("created: " + it.created);
      fm.push("---", "");
      return fm.join("\n") + "\n" + (it.body || "");
    }
    window.fetch = function (url, opts) {
      var u = String(url && url.url ? url.url : url);
      if (u.indexOf("https://api.github.com/") !== 0) return real(url, opts);
      var method = (opts && opts.method) || "GET";
      // Who you are. The account menu reads this to draw the identity row.
      if (u.indexOf("https://api.github.com/user") === 0) {
        return json({ login: "demo", avatar_url: "" });
      }
      // Route on the path *after* the repo, one case per endpoint the board calls.
      // The first version of this matched "a repo URL without /contents/" and answered
      // it with the permissions probe — which is every other endpoint there is. The
      // Activity tab reads /commits, Discussion reads /issues/:n and its comments, and
      // Link issue POSTs to /issues; all three got `{permissions:{push:true}}` under a
      // 200, so Activity claimed the puck had no history, Discussion drew
      // "undefined #undefined", and creating an issue resolved to nothing and left the
      // puck silently unlinked.
      //
      // The bug was not the missing cases, it was the *shape* of the fallthrough: a
      // catch-all that answers 200 makes the next endpoint the board learns to call
      // fail the same quiet way. So the default below is a 404 — an endpoint the demo
      // has not thought about fails where you can see it.
      var m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?#]+)([^?#]*)/.exec(u);
      var repo = m && m[1];
      var rest = (m && m[2]) || "";
      if (!repo) return json({ message: "Not Found" }, 404);
      var query = {};
      (u.split("?")[1] || "").split("&").forEach(function (kv) {
        var i = kv.indexOf("=");
        if (i > 0) query[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      });
      var find = function (pred) {
        for (var i = 0; i < DATA.items.length; i++) {
          if (DATA.items[i].repo === repo && pred(DATA.items[i])) return DATA.items[i];
        }
        return null;
      };

      // The permissions probe: every repo is writable here, so no card is marked
      // read-only and the rail stays editable.
      if (rest === "" || rest === "/") return json({ permissions: { push: true } });

      // Sync now: the dispatch, and the run it creates. Answered here for the same
      // reason the writes are — the real path runs, including the two-stage poll that
      // waits for a run id newer than the one it read first.
      var mw = /^\/actions\/workflows\/[^/]+\/(dispatches|runs)$/.exec(rest);
      if (mw && mw[1] === "dispatches" && method === "POST") {
        dispatched++;
        // 204 carries no body, so this cannot go through `json()` — constructing a
        // Response with a body at 204 throws.
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (mw && mw[1] === "runs" && method === "GET") {
        return json({ workflow_runs: [{ id: dispatched, status: "completed", conclusion: "success" }] });
      }

      // Activity: the file's history. Invented from what the puck already carries —
      // its `created` and `updated` dates — the same way `seed()` invents the file
      // itself. Returning [] instead would have been honest and would also have shown
      // a demo where a shipped feature does nothing.
      var mc = /^\/commits$/.exec(rest);
      if (mc && method === "GET") {
        var ci = find(function (x) { return x.sourcePath === query.path; });
        if (!ci) return json([]);
        var who = ci.owner || "demo";
        var at = function (d) { return d + "T09:00:00Z"; };
        var commit = function (msg, date) {
          return {
            sha: "demo" + date.replace(/-/g, ""),
            html_url: ci.sourceUrl || "",
            author: { login: who, avatar_url: "" },
            commit: { message: msg, author: { name: who, date: at(date) } },
          };
        };
        var log = [commit(ci.status + ": " + ci.title, ci.updated || today())];
        if (ci.created && ci.created !== ci.updated) log.push(commit("Add " + ci.sourcePath, ci.created));
        return json(log);
      }

      // Discussion: the linked issue, derived from the puck that links it, and no
      // comments — an issue nobody has replied to yet is a state the real board draws.
      var mi = /^\/issues\/(\d+)$/.exec(rest);
      if (mi && method === "GET") {
        var num = Number(mi[1]);
        var ii = find(function (x) { return Number(x.issue) === num; });
        if (!ii) return json({ message: "Not Found" }, 404);
        return json({
          number: num,
          state: ii.issueState || "open",
          title: ii.title,
          html_url: "https://github.com/" + repo + "/issues/" + num,
          body: ii.body || "",
          user: { login: ii.owner || "demo" },
          created_at: (ii.created || today()) + "T09:00:00Z",
        });
      }
      if (/^\/issues\/\d+\/comments$/.test(rest) && method === "GET") return json([]);

      // Link issue → Create issue. Answering with a number is what lets the write path
      // finish and put `issue:` in the file, which is the half worth demonstrating.
      if (rest === "/issues" && method === "POST") {
        var body = {};
        try { body = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
        var n = 1000 + (++sha);
        return json({
          number: n, state: "open", title: body.title || "",
          html_url: "https://github.com/" + repo + "/issues/" + n,
        }, 201);
      }

      var mp = /^\/contents\/(.+)$/.exec(rest);
      if (!mp) return json({ message: "Not Found" }, 404);
      var path = decodeURIComponent(mp[1]);
      var key = repo + ":" + path;
      if (method === "PUT") {
        var body = {};
        try { body = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
        if (body.content) files[key] = b64decode(body.content);
        return json({ content: { sha: "demo-" + (++sha) } }, 201);
      }
      if (method === "DELETE") { delete files[key]; return json({ commit: { sha: "demo-" + (++sha) } }); }
      if (!(key in files)) files[key] = seed(repo, path);
      return json({ sha: "demo-" + sha, content: b64encode(files[key]), path: path });
    };
  }
  function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64decode(b) { return decodeURIComponent(escape(atob(String(b).replace(/\s/g, "")))); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function branchOf(item) { var m = /\/blob\/([^/]+)\//.exec(item.sourceUrl || ""); return m ? m[1] : "main"; }

  // Which source repos the current token can WRITE to. Editing writes to the
  // *source* repo (e.g. a PIA puck commits to PIA), so a token scoped to only one
  // repo can't edit the others — surfaced as a 403. We check push permission per
  // repo on sign-in and only offer edit controls where it's allowed. null = not
  // yet checked (treat as allowed so controls aren't briefly missing).
  var writableRepos = null;
  // Repos a write actually 403/404'd on this session — the reliable signal, since
  // a fine-grained token's permissions.push can read true while Contents: write is
  // missing. Learned from real failures; cleared on sign-in.
  var readOnlyRepos = new Set();
  // Permission is a property of the *repo*, and some questions are about a repo with
  // no item to ask through — "could a puck be created here" is one.
  function canWriteRepo(repo) {
    // == null also catches `undefined` — card() calls this during the first render,
    // before writableRepos/readOnlyRepos are assigned (they mean "not checked yet").
    return (writableRepos == null || writableRepos.has(repo)) && !(readOnlyRepos && readOnlyRepos.has(repo));
  }
  function canWrite(item) { return canWriteRepo(item.repo); }
  // Writing is not the same question as *creating*. A `checklist`/`prose` source can be
  // perfectly writable and still be the wrong place for a new file: the harvester runs
  // that repo's own adapter, which reads one file and one section and has never heard of
  // `roadmap/<slug>.md`. The puck would commit, sit on the board optimistically, and be
  // gone at the next sync — a write that looks like it worked and vanishes an hour
  // later, which is the same failure the closed-set rule exists to prevent.
  // Existing children from such a repo are still pickable; only *making* one is not.
  function canCreateIn(repo) {
    if (!ghToken() || !canWriteRepo(repo)) return false;
    var src = DATA.sources.filter(function (s) { return s.repo === repo; })[0];
    if (src) return src.adapter === "pucks";
    return DATA.items.some(function (it) { return it.repo === repo && it.native; });
  }
  function noteWriteError(item, err) {
    if (err && (err.status === 403 || err.status === 404)) readOnlyRepos.add(item.repo);
  }
  function loadWritableRepos() {
    var token = ghToken();
    if (!token) { writableRepos = null; return; }
    var repos = DATA.sources.map(function (s) { return s.repo; });
    Promise.all(repos.map(function (repo) {
      return fetch("https://api.github.com/repos/" + repo, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d && d.permissions && d.permissions.push ? repo : null; })
        .catch(function () { return null; });
    })).then(function (rs) {
      writableRepos = new Set(rs.filter(Boolean));
      // Reflect real permissions: cards' draggability + the detail's edit controls.
      renderBoard();
      var open = itemFromHash();
      if (open && document.body.classList.contains("viewing-puck")) openDetail(open);
    });
  }

  // Turn a failed read/write response into a clear, actionable error that also
  // carries the status so callers can mark the repo read-only.
  function assertOk(r, item) {
    if (r.ok) return;
    var e = new Error(r.status === 403 || r.status === 404
      ? "No write access to " + item.repoName + " — your token needs Contents: write on that repo"
      : "write failed (" + r.status + ")");
    e.status = r.status;
    throw e;
  }

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

  // Write several frontmatter fields in ONE commit (a null value removes the key).
  // Dragging a card to another column *and* a position is one move, so it should be
  // one commit — two would make the history read like two decisions.
  function commitFields(item, fields, message) {
    var token = ghToken();
    var apiPath = item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + apiPath;
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
      .then(function (info) {
        var out = b64decode(info.content);
        for (var k in fields) {
          out = fields[k] == null ? removeFrontmatter(out, k) : editFrontmatter(out, k, String(fields[k]));
          if (out == null) throw new Error("no frontmatter");
        }
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: message, content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { assertOk(r, item); });
  }

  // Commit a status change via the GitHub Contents API (read sha → PUT commit).
  function commitStatus(item, status) {
    var token = ghToken();
    var apiPath = item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + apiPath;
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
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
      .then(function (r) { assertOk(r, item); });
  }

  // ── manual rank ─────────────────────────────────────────────────────────────
  // `order` is the puck's place inside its column. Dropping between two cards
  // writes ONE file: the moved puck gets a value between its new neighbours.
  // Sparse steps (10) leave room; when a gap closes, the midpoint goes decimal
  // rather than renumbering the neighbours, because renumbering a column from the
  // browser would mean N commits that can half-fail. `roadmap renumber` tidies a
  // column back to 10, 20, 30 in one local pass when you want round numbers.
  // A column renders as [ranked by `order`][unranked, by `updated`]. One write can
  // therefore only express a position whose *upper* neighbour is ranked (or absent
  // — the very top). Drop below an unranked card and no single `order` puts the
  // card there: any value at all lifts it into the ranked block, above every
  // unranked puck. Rather than land it somewhere the pointer never was, refuse and
  // point at `roadmap renumber`, which ranks the column in one local pass.
  var ORDER_STEP = 10;
  function orderBetween(prev, next) {
    var b = next && next.order != null ? next.order : null;
    if (prev == null) return b == null ? ORDER_STEP : b - ORDER_STEP; // the very top
    if (prev.order == null) return null;                // below an unranked card
    var a = prev.order;
    if (b == null) return a + ORDER_STEP;               // below every ranked card
    var mid = (a + b) / 2;
    return mid === a || mid === b ? null : mid;         // gap exhausted (float limit)
  }
  function changeOrder(item, order, alsoKey, group) {
    if (!ghToken()) return;
    var fields = { order: order };
    var label = "reordered";
    var prevOrder = item.order, prevU = item.updated, prevKey = null, keyField = null;
    if (alsoKey && group && group.field) {
      keyField = group.field;
      prevKey = item[keyField];
      // A group key isn't always the stored value (a month bucket is a date), so
      // the group converts it.
      // NB: not `valueOf` — that name is inherited from Object.prototype, so every
      // group would look like it had a converter.
      var value = group.toValue ? group.toValue(alsoKey) : (alsoKey === NO_VALUE ? null : alsoKey);
      fields[keyField] = value;
      item[keyField] = value;
      label = keyField + " " + (value == null ? "cleared" : value);
    }
    item.order = order; item.updated = today();
    // A drop between status columns is a status change that happens to also carry a
    // rank, so it owes the same derivation the picker's path does — the parent's
    // rollup and the puck's own flags. Routing only `changeStatus` left a dragged
    // parent with a stale `N/M` and a `rollup-*` warning until the next harvest.
    afterOrderEdit(item, keyField);
    toast("Saving…");
    commitFields(item, fields, "roadmap: " + item.slug + " " + label)
      .then(function () { toast("✓ Moved — live in ~1 min"); })
      .catch(function (err) {
        item.order = prevOrder; item.updated = prevU;
        if (keyField) item[keyField] = prevKey;
        noteWriteError(item, err);
        afterOrderEdit(item, keyField);
        toast("✗ " + err.message, true);
      });
  }

  // A dropped card only touches the hierarchy when the field it landed in *is* the
  // status; every other grouping writes its own field and leaves the rollup alone.
  function afterOrderEdit(item, keyField) {
    if (keyField === "status") {
      recountParent(item.parentRef);
      syncRollupSignals(item);
      // Bägge ändarna, som i changeParent: härledningen uppdaterar parentens objekt,
      // men bara den puck vi skickar med målas om — och parenten är precis lika
      // trolig som den öppna sidan när man drar ett av dess barn.
      afterEdit(item, item.parentRef);
      return;
    }
    afterEdit(item);
  }

  // Optimistic: flip in-memory + re-render now, commit in the background, revert on failure.
  // Reopen the detail only if it's currently showing (so a status change from the
  // picker refreshes the open puck, but a drag-drop on the board doesn't pop it).
  // Refresh the open puck after an optimistic write — but never while a surface is
  // up. The detail pane is rebuilt wholesale, which would detach the very control a
  // popover is anchored to, leaving a picker that looks alive and writes nowhere.
  // Deferred writes make this easy to hit: close the label picker by clicking the
  // status chip, and the save lands *after* the status picker has opened.
  // "Still showing" means *this* puck, not any puck: a held-off write belongs to the
  // puck it was made on, and flushing it after the reader moved on would drag that
  // puck back over the one they're reading, hash and all.
  var pendingRefresh = null;
  function isOpenPuck(item) {
    return document.body.classList.contains("viewing-puck") &&
      !!currentDetailItem && currentDetailItem.id === item.id;
  }
  // What every optimistic edit owes the rest of the interface: the board, the
  // navigation (counts move when a puck changes status or parent), and the open puck
  // — whichever end of the edit it happens to be. Written once because each of the
  // three has been forgotten separately.
  function afterEdit(/* …items whose page may be open */) {
    // Navigation first, board second. That order used to matter because
    // `buildAgentChips()` pruned an emptied place out of `state.agents`, which was part
    // of the query the board rendered — render first and you drew an empty board for a
    // scope about to be removed. Nothing prunes anything now, so the order is only
    // habit; it is kept because the counts should not lag the board by a frame either.
    refreshNav();
    renderBoard();
    for (var i = 0; i < arguments.length; i++) {
      var it = arguments[i];
      if (typeof it === "string") it = itemById(it);
      if (it) reopenIfOpen(it);
    }
  }
  function reopenIfOpen(item) {
    if (!isOpenPuck(item)) return;
    if (openSurfaces.length) { pendingRefresh = item; return; }
    pendingRefresh = null;
    openModal(item);
  }
  function flushRefresh() {
    if (!pendingRefresh || openSurfaces.length) return;
    var it = pendingRefresh;
    pendingRefresh = null;
    if (isOpenPuck(it)) openModal(it);
  }
  function changeStatus(item, status) {
    if (status === item.status || !ghToken()) return;
    var prevS = item.status, prevU = item.updated;
    item.status = status; item.updated = today();
    recountParent(item.parentRef); // the parent's rollup follows its pucks
    syncRollupSignals(item);      // …and its own flag follows its status
    // refreshNav too: moving a puck between active and terminal changes what a repo
    // chip, an agent queue and every view row count. Without it the sidebar kept
    // counting a puck that clicking it no longer shows, until unrelated navigation.
    afterEdit(item);
    toast("Saving…");
    commitStatus(item, status)
      .then(function () { toast("✓ Saved — live in ~1 min"); })
      .catch(function (err) {
        item.status = prevS; item.updated = prevU;
        recountParent(item.parentRef);
        syncRollupSignals(item);
        noteWriteError(item, err);
        afterEdit(item);
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
      .then(function (r) { assertOk(r, item); return r.json(); })
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
      .then(function (r) { assertOk(r, item); });
  }

  // Optimistic: flip in-memory + re-render, commit in the background, revert on failure.
  function changePriority(item, priority) {
    if (priority === (item.priority || null) || !ghToken()) return;
    var prevP = item.priority, prevU = item.updated;
    item.priority = priority; item.updated = today();
    renderBoard(); reopenIfOpen(item);
    toast("Saving…");
    commitPriority(item, priority)
      .then(function () { toast("✓ Saved — live in ~1 min"); })
      .catch(function (err) {
        item.priority = prevP; item.updated = prevU;
        noteWriteError(item, err);
        renderBoard(); reopenIfOpen(item);
        toast("✗ " + err.message, true);
      });
  }

  // Route a puck to a discipline agent (PO-layer). Writes `agent:` to git — the
  // runner reads it. A null value clears the field (unassign). Optimistic.
  function commitAgent(item, agent) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
      .then(function (info) {
        var text = b64decode(info.content);
        var out = agent ? editFrontmatter(text, "agent", agent) : removeFrontmatter(text, "agent");
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + " → agent " + (agent || "unassigned"), content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { assertOk(r, item); });
  }
  function changeAgent(item, agent) {
    if (agent === (item.agent || null) || !ghToken()) return;
    var prevA = item.agent, prevU = item.updated;
    item.agent = agent; item.updated = today();
    renderBoard(); buildAgentChips(); reopenIfOpen(item);
    toast("Saving…");
    commitAgent(item, agent)
      .then(function () { toast(agent ? "✓ Routed to " + agent + " — live in ~1 min" : "✓ Unassigned — live in ~1 min"); })
      .catch(function (err) {
        noteWriteError(item, err);
        item.agent = prevA; item.updated = prevU;
        renderBoard(); buildAgentChips(); reopenIfOpen(item);
        toast("✗ " + err.message, true);
      });
  }

  // Link/unlink a GitHub issue by writing the `issue:` frontmatter line (null
  // removes it). issueState is reconciled against the real issue at the next
  // harvest, which also refreshes the Discussion tab and drift flags.
  function commitIssue(item, number) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
      .then(function (info) {
        var text = b64decode(info.content);
        var out = number ? editFrontmatter(text, "issue", String(number)) : removeFrontmatter(text, "issue");
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + (number ? " issue #" + number : " unlink issue"), content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { assertOk(r, item); });
  }
  // Edit the puck's labels by rewriting the `tags:` frontmatter line (empty removes it).
  function commitTags(item, tags) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
      .then(function (info) {
        var text = b64decode(info.content);
        var out = tags.length ? editFrontmatter(text, "tags", "[" + tags.join(", ") + "]") : removeFrontmatter(text, "tags");
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + " labels", content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { assertOk(r, item); });
  }
  function changeTags(item, tags) {
    if (!ghToken() || tags.join(",") === (item.tags || []).join(",")) return;
    var prev = item.tags, prevU = item.updated;
    item.tags = tags; item.updated = today();
    renderBoard(); reopenIfOpen(item);
    toast("Saving…");
    commitTags(item, tags)
      .then(function () { toast("✓ Labels saved — live in ~1 min"); })
      .catch(function (err) {
        item.tags = prev; item.updated = prevU;
        noteWriteError(item, err);
        renderBoard(); reopenIfOpen(item);
        toast("✗ " + err.message, true);
      });
  }
  // Write the horizon by rewriting the `target:` frontmatter line (null removes it).
  function commitTarget(item, date) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
      .then(function (info) {
        var text = b64decode(info.content);
        var out = date ? editFrontmatter(text, "target", date) : removeFrontmatter(text, "target");
        if (out == null) throw new Error("no frontmatter");
        out = editFrontmatter(out, "updated", today());
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: " + item.slug + (date ? " target " + date : " clear target"), content: b64encode(out), sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { assertOk(r, item); });
  }
  function changeTarget(item, date) {
    date = date || null;
    if (date === (item.target || null) || !ghToken()) return;
    var prevT = item.target, prevU = item.updated;
    item.target = date; item.updated = today();
    renderBoard(); reopenIfOpen(item);
    toast("Saving…");
    commitTarget(item, date)
      .then(function () { toast(date ? "✓ Target " + date + " — live in ~1 min" : "✓ Target cleared — live in ~1 min"); })
      .catch(function (err) {
        item.target = prevT; item.updated = prevU;
        noteWriteError(item, err);
        renderBoard(); reopenIfOpen(item);
        toast("✗ " + err.message, true);
      });
  }
  // Ask for a horizon in the same shape the CLI takes: a date, or a month meaning
  // "by the end of it". Blank clears it.
  // The Target cell in the rail: the horizon, shown exact here (the detail view is
  // where precision belongs) with an edit affordance when writable.
  function targetValue(item, editable) {
    // One control, not a value plus a link to change it: the date *is* the button.
    // Read-only keeps the plain value, and an empty read-only row says "—".
    var wrap = el("span", "issue-cell"); // same inline row shape as the Issue cell
    if (editable) {
      wrap.appendChild(datePicker(item, item.target ? targetEl(item.target, "prop-date") : null));
    } else if (item.target) {
      // Read-only: no picker to open, so the exact date has nowhere else to live —
      // the board shows the horizon coarsely, and this is the one page that says
      // precisely what the puck declares.
      wrap.appendChild(targetEl(item.target, "prop-date"));
      wrap.appendChild(el("span", "prop-muted", item.target));
    } else {
      wrap.appendChild(el("span", "prop-muted", "\u2014"));
    }
    return wrap;
  }

  // ── date picker ─────────────────────────────────────────────────────────────
  // A field *and* a grid, bound to each other: type the date if you know it, browse
  // if you don't. Deliberately smaller than the pickers it was modelled on \u2014 no
  // end date (a range becomes sprint dates), no time, no reminders (that needs a
  // backend). Clear is here because "no horizon" is a real answer.
  //
  // "This month" writes the month's last day, which is what `roadmap target <slug>
  // 2026-11` already means: `target` is stored exact so it sorts and compares, but a
  // horizon is not a promise about a Tuesday.
  var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function ymd(d) { return d.toISOString().slice(0, 10); }
  //   content: the node to show inside the trigger (the current target), or null
  //   for the empty state, which labels itself.
  function datePicker(item, content) {
    var wrap = el("div", "prop-pick");
    var btn = el("button", "linklike prop-trigger" + (content ? " has-value" : ""));
    btn.type = "button";
    if (content) btn.appendChild(content);
    else btn.appendChild(document.createTextNode("Set target"));
    wrap.appendChild(btn);
    var open = null;

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (open) { open.close(); return; }
      open = openSurface({
        title: "Target",
        anchorWrap: wrap,
        cls: "datepop",
        help: "https://github.com/tor2dbear/roadmap/blob/main/CONVENTION.md#the-horizon-target",
        onClose: function () { open = null; },
        build: function (host, api) {
          var value = item.target || null;
          var view = new Date((value || today()) + "T00:00:00Z"); // the month on screen

          var input = el("input", "fp-search date-input");
          input.type = "text";
          input.placeholder = "YYYY-MM-DD";
          input.value = value || "";
          input.autocomplete = "off"; input.spellcheck = false;
          host.appendChild(input);

          var cal = el("div", "cal");
          host.appendChild(cal);

          var foot = el("div", "date-foot");
          // Named for what it does: the month you are looking at, not today's. It
          // writes that month's last day — the horizon `roadmap target <slug>
          // 2026-11` already means.
          var month = el("button", "date-act", "End of month");
          month.type = "button";
          month.addEventListener("click", function () {
            commit(endOfMonth(ymd(view).slice(0, 7)));
          });
          var clear = el("button", "date-act date-clear", "Clear");
          clear.type = "button";
          clear.addEventListener("click", function () { commit(null); });
          foot.appendChild(month);
          foot.appendChild(clear);
          host.appendChild(foot);

          function commit(date) {
            api.close();
            changeTarget(item, date);
          }
          function drawCal() {
            cal.innerHTML = "";
            var head = el("div", "cal-head");
            var prev = el("button", "cal-nav", "\u2039"); prev.type = "button";
            var next = el("button", "cal-nav", "\u203a"); next.type = "button";
            prev.setAttribute("aria-label", "Previous month");
            next.setAttribute("aria-label", "Next month");
            // Step by month from day 1: setUTCMonth keeps the day, so August 31st
            // "next month" lands on October 1st and the button appears to skip one.
            function step(by) {
              view = new Date(Date.UTC(view.getUTCFullYear(), view.getUTCMonth() + by, 1));
              drawCal();
            }
            prev.addEventListener("click", function () { step(-1); });
            next.addEventListener("click", function () { step(1); });
            head.appendChild(el("span", "cal-month", monthLabel(ymd(view).slice(0, 7))));
            head.appendChild(prev);
            head.appendChild(next);
            cal.appendChild(head);

            var grid = el("div", "cal-grid");
            WEEKDAYS.forEach(function (w) { grid.appendChild(el("span", "cal-wd", w.slice(0, 2))); });
            // Monday-first, like the rest of the ISO-shaped data.
            var first = new Date(Date.UTC(view.getUTCFullYear(), view.getUTCMonth(), 1));
            var lead = (first.getUTCDay() + 6) % 7;
            var start = new Date(first);
            start.setUTCDate(1 - lead);
            var now = today();
            for (var i = 0; i < 42; i++) {
              var d = new Date(start);
              d.setUTCDate(start.getUTCDate() + i);
              var iso = ymd(d);
              var out = d.getUTCMonth() !== view.getUTCMonth();
              var cell = el("button", "cal-day" + (out ? " out" : "") +
                (iso === value ? " on" : "") + (iso === now ? " today" : ""), String(d.getUTCDate()));
              cell.type = "button";
              cell.setAttribute("aria-label", iso);
              (function (pick) { cell.addEventListener("click", function () { commit(pick); }); })(iso);
              grid.appendChild(cell);
            }
            cal.appendChild(grid);
          }
          // Typing steers the grid: a full date selects it, a bare month browses to it.
          input.addEventListener("input", function () {
            var v = input.value.trim();
            var m = /^(\d{4})-(\d{2})$/.exec(v);
            if (realDate(v)) { value = v; view = new Date(v + "T00:00:00Z"); drawCal(); }
            else if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) { view = new Date(v + "-01T00:00:00Z"); drawCal(); }
          });
          input.addEventListener("keydown", function (e) {
            if (e.key !== "Enter") return;
            var v = input.value.trim();
            if (v === "") { commit(null); return; }
            var m = /^(\d{4})-(\d{2})$/.exec(v);
            if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) { commit(endOfMonth(v)); return; }
            if (realDate(v)) { commit(v); return; }
            toast("\u2717 Use a real date: YYYY-MM-DD or YYYY-MM", true);
          });
          drawCal();
          if (!isPhone()) input.focus(); // on a phone, don't summon the keyboard over the grid
        },
      });
    });
    return wrap;
  }

  // ── parent (`parent`) ────────────────────────────────────────────────────────
  // The level above a puck is one frontmatter line pointing *up*; `children` and
  // `progress` are derived at harvest. So the write is a single field on a single
  // file — no epic record to keep in sync, and dragging a card between parent
  // columns is the same one-file commit a status flip is.

  // Would this link close a loop? Walk up from the proposed parent; meeting the
  // puck itself means the parent would contain its own ancestor. The harvester cuts
  // such a link anyway — refusing here keeps a nonsense line out of git.
  function wouldLoop(item, parentId) {
    var seen = {}, cur = parentId;
    while (cur) {
      if (cur === item.id || seen[cur]) return true;
      seen[cur] = 1;
      var p = itemById(cur);
      cur = p && p.parentRef;
    }
    return false;
  }
  // Recount one parent from its children's current statuses. The board mutates
  // status optimistically, so the rollup has to follow locally or a parent would
  // read stale until the next harvest.
  // The board's optimistic mirror of `resolveHierarchy`'s count, and it has to mirror
  // it exactly: two derivations of one number is the arrangement that fails quietly.
  // Direct children, one node — a grandchild's status changes its own parent's count
  // and nothing above, because what the grandparent counts is *its* child's status, and
  // that did not move.
  function recountParent(id) {
    var p = id && itemById(id);
    if (!p) return;
    var kids = childItems(p);
    p.progress = kids.length
      ? { done: kids.filter(function (k) { return !!TERMINAL[k.status]; }).length, total: kids.length }
      : null;
    syncRollupSignals(p);
  }
  // The rollup pair is a pure function of a puck's own status and its progress, and
  // the board already maintains both optimistically — so it can be recomputed here
  // instead of waiting for the next harvest, an hour away. Without it, following a
  // `rollup-done` warning and marking the parent done left the warning standing and
  // the parent sitting in Needs attention until the harvest caught up.
  //
  // The rule is stated twice (here and in harvest.mjs), which is the same trade
  // `relink`/`recountParent` already make for `children`/`progress`: an optimistic
  // edit has to derive what the harvester derives, or the board contradicts itself
  // between an edit and the next sync.
  function syncRollupSignals(item) {
    if (!item) return;
    var out = (item.signals || []).filter(function (s) { return s.type.indexOf("rollup-") !== 0; });
    if (item.progress && item.progress.total) {
      var closed = item.progress.done === item.progress.total;
      if (TERMINAL[item.status] && !closed) out.push({ type: "rollup-open" });
      if (!TERMINAL[item.status] && closed) out.push({ type: "rollup-done" });
    }
    item.signals = out;
  }
  // Move a puck between parents locally (the same derivation the harvester does).
  function relink(item, parentId, raw) {
    var old = item.parentRef;
    if (old) {
      var op = itemById(old);
      if (op) op.children = (op.children || []).filter(function (id) { return id !== item.id; });
    }
    item.parentRef = parentId;
    item.parent = raw;
    if (parentId) {
      var np = itemById(parentId);
      if (np && (np.children || []).indexOf(item.id) === -1) np.children = (np.children || []).concat([item.id]);
    }
    recountParent(old);
    recountParent(parentId);
    // `parent-missing` says the parent named in the file does not exist. Once the link
    // resolves it plainly does, so the flag goes — creating the parent a puck already
    // named is the repair the flag asks for, and the note would otherwise keep naming
    // a puck that is now on the board.
    //
    // Only cleared, never raised. An unresolved `parent:` has two possible flags and
    // two different fixes — a typo (`parent-missing`) or a loop (`parent-cycle`) — and
    // choosing between them is the harvester's job, not a guess made here.
    if (parentId) {
      item.signals = (item.signals || []).filter(function (g) { return g.type !== "parent-missing"; });
    }
  }

  // ── dependencies (`depends`) ────────────────────────────────────────────────
  // Only `depends:` is authored, on the blocked puck. `blockedBy` (what still
  // holds me up) and `blocks` (what I hold up) are both derived — here as well as
  // at harvest, so an optimistic edit can't leave the two directions disagreeing.
  function recomputeDeps() {
    DATA.items.forEach(function (it) { it.blocks = []; it.missingDepends = []; it.blockedBy = []; });
    DATA.items.forEach(function (it) {
      var unresolved = [];
      var live = [];
      (it.depends || []).forEach(function (ref) {
        var d = resolveRef(it, ref);
        if (!d) { it.missingDepends.push(ref); unresolved.push(ref); return; }
        if (!TERMINAL[d.status]) live.push(d);
      });
      if (TERMINAL[it.status]) return; // landed: waits for nothing, holds up nothing
      // An unknown blocker is not a settled one — it stays in `blockedBy` as
      // written, so the puck doesn't read as ready while its author thinks it is
      // blocked. `blocks` is the exact mirror of the resolved half.
      it.blockedBy = live.map(function (d) { return d.id; }).concat(unresolved);
      live.forEach(function (d) { d.blocks.push(it.id); });
    });
    DATA.items.forEach(function (it) { it.blocks.sort(); });
    // `depends-missing` is derived from `missingDepends`, so it has to move with it.
    // The note is built by joining that list — leave the two out of step and the puck
    // says "Depends on , which doesn't exist", with the name it is complaining about
    // missing from the complaint. Reachable two ways: remove a broken reference (which
    // predates this work), or create the puck the reference was naming.
    //
    // Only this one type is touched. The harvester stays the authority on every signal
    // — this is the same promise `blockedBy` already makes, that an optimistic edit
    // must not leave the derived state disagreeing with itself between renders.
    DATA.items.forEach(function (it) {
      var had = (it.signals || []).some(function (g) { return g.type === "depends-missing"; });
      var needs = it.missingDepends.length > 0;
      if (had === needs) return;
      var rest = (it.signals || []).filter(function (g) { return g.type !== "depends-missing"; });
      it.signals = needs ? rest.concat([{ type: "depends-missing" }]) : rest;
    });
  }
  // Would depending on `target` close a loop? Walk the *authored* graph, since a
  // landed blocker still counts as an edge.
  function wouldDependLoop(item, target) {
    var seen = {}, stack = [target];
    while (stack.length) {
      var cur = stack.pop();
      if (cur === item) return true;
      if (seen[cur.id]) continue;
      seen[cur.id] = 1;
      dependsItems(cur).forEach(function (d) { stack.push(d); });
    }
    return false;
  }
  function commitDepends(item, refs, message) {
    return commitFields(item, { depends: refs.length ? "[" + refs.join(", ") + "]" : null }, message);
  }
  // `refs` is the whole new list — one field, one commit, like every other write.
  function changeDepends(item, refs, message) {
    if (!ghToken()) return;
    var prev = item.depends, prevU = item.updated;
    item.depends = refs;
    item.updated = today();
    recomputeDeps();
    renderBoard(); reopenIfOpen(item);
    toast("Saving…");
    commitDepends(item, refs, message)
      .then(function () { toast("✓ Saved — live in ~1 min"); })
      .catch(function (err) {
        item.depends = prev; item.updated = prevU;
        recomputeDeps();
        noteWriteError(item, err);
        renderBoard(); reopenIfOpen(item);
        toast("✗ " + err.message, true);
      });
  }
  function removeDepend(item, ref) {
    changeDepends(item, (item.depends || []).filter(function (r) { return r !== ref; }),
      "roadmap: " + item.slug + " no longer blocked by " + ref);
  }
  // Which pucks could block this one: anything but itself, what it already lists,
  // and anything that already waits on it (a loop).
  function blockerCandidates(item) {
    var listed = {};
    dependsItems(item).forEach(function (d) { listed[d.id] = 1; });
    return function (other) {
      return other === item || listed[other.id] || wouldDependLoop(item, other);
    };
  }

  // The Blocked by cell: every *declared* blocker (landed ones struck through, so
  // they can still be removed), each with a ✕ when writable, plus "Add".
  function dependsValue(item, editable) {
    var wrap = el("div", "prop-blockers");
    (item.depends || []).forEach(function (ref) {
      var d = resolveRef(item, ref);
      var chip = el("span", "dep-chip");
      if (d) {
        var a = el("a", "blocker-link" + (TERMINAL[d.status] ? " done" : ""), d.title);
        a.href = "#" + d.id;
        a.addEventListener("click", function (e) { e.preventDefault(); openModal(d); });
        chip.appendChild(a);
      } else {
        chip.appendChild(el("span", "prop-muted", ref)); // unresolved — the ⚠ says why
      }
      if (editable) {
        var x = el("button", "dep-x");
        x.appendChild(icon("x", "x-icn"));
        x.type = "button";
        x.setAttribute("aria-label", "Remove blocker " + (d ? d.title : ref));
        x.addEventListener("click", function () { removeDepend(item, ref); });
        chip.appendChild(x);
      }
      wrap.appendChild(chip);
    });
    // "Nothing" next to "Add" is the same empty-value-plus-link pair the Target and
    // Parent rows had: the button already says what the row is for.
    if (!(item.depends || []).length && !editable) wrap.appendChild(el("span", "prop-muted", "—"));
    if (editable) {
      wrap.appendChild(puckPicker("Add", {
        repo: item.repo,
        title: "Blocked by",
        help: "https://github.com/tor2dbear/roadmap/blob/main/CONVENTION.md#dependencies-depends",
        // Several tokens: everything this puck declared. Removing one from here is
        // the same write as the ✕ on the row behind.
        tokens: function () {
          return (item.depends || []).map(function (ref) {
            var d = resolveRef(item, ref);
            return {
              label: d ? d.title : ref,
              color: d ? d.repoColor : null,
              onRemove: function () { removeDepend(item, ref); },
            };
          });
        },
        current: null,
        exclude: blockerCandidates(item),
        placeholder: "Find a blocker…",
        onPick: function (target) {
          var ref = refFor(item, target);
          changeDepends(item, (item.depends || []).concat([ref]),
            "roadmap: " + item.slug + " blocked by " + ref);
        },
        // Same two-write shape as the parent, and the puck argued for having it: the
        // blocker you cannot find is more often work nobody has written down yet
        // than a parent is.
        create: {
          noun: "blocker",
          run: function (title) {
            var made = createPuck(item.repo, title, "later", [], null, "", { open: false });
            if (made) made.then(function (p) {
              if (!p) return;
              // The puck may be exactly what an existing `depends:` was already naming.
              // Creating the thing you declared yourself blocked by is the repair
              // `depends-missing` asks for — the reference was right, the file was
              // missing — so appending it again would commit `depends: [foo, foo]` and
              // draw the same relationship twice. `createPuck` has already recomputed
              // the edges, so the dangling reference resolves on its own.
              var already = (item.depends || []).some(function (r) { return resolveRef(item, r) === p; });
              if (already) { afterEdit(item); return; }
              var ref = refFor(item, p);
              changeDepends(item, (item.depends || []).concat([ref]),
                "roadmap: " + item.slug + " blocked by " + ref);
            });
          },
        },
      }));
    }
    return wrap;
  }

  function commitParent(item, raw) {
    return commitFields(item, { parent: raw },
      "roadmap: " + item.slug + (raw ? " → parent " + raw : " out of its parent"));
  }
  // `parentId` is a board id ("repo/slug") or null to take the puck out.
  function changeParent(item, parentId) {
    parentId = parentId || null;
    if (!ghToken()) return;
    // Clearing looks at the *raw* field, not the resolved one: a broken link
    // (parent-missing / parent-cycle) has a `parent:` line but no `parentRef`, and
    // removing it is precisely what the flag asks for.
    if (parentId ? parentId === item.parentRef : !item.parentRef && !item.parent) return;
    var target = parentId ? itemById(parentId) : null;
    if (parentId && !target) return;
    if (parentId === item.id) { toast("✗ A puck can’t be its own parent", true); return; }
    if (wouldLoop(item, parentId)) { toast("✗ That would make a parent loop", true); return; }
    var raw = target ? refFor(item, target) : null;
    var prevRef = item.parentRef, prevRaw = item.parent, prevU = item.updated;
    // Saved, not recomputed. `relink` clears `parent-missing` when the link resolves and
    // deliberately never raises it — an unresolved `parent:` is either a typo or a loop,
    // and choosing between those is the harvester's job. A rollback has no such problem:
    // it knows exactly which flag stood there, so it puts that one back. (`filter` builds
    // a new array, so holding the old reference is holding the old value.)
    var prevSignals = item.signals;
    relink(item, parentId, raw);
    item.updated = today();
    // Both ends changed, and the parent is as likely to be the page you're on: adding
    // from `＋ Add puck` writes the *child*, so refreshing only that left the
    // Contains list and its rollup stale on the parent you were looking at.
    afterEdit(item, prevRef, parentId);
    toast("Saving…");
    commitParent(item, raw)
      .then(function () { toast(raw ? "✓ Part of " + target.title + " — live in ~1 min" : "✓ Out of its parent — live in ~1 min"); })
      .catch(function (err) {
        relink(item, prevRef, prevRaw);
        item.signals = prevSignals;
        item.updated = prevU;
        noteWriteError(item, err);
        afterEdit(item, prevRef, parentId);
        toast("✗ " + err.message, true);
      });
  }
  // Which pucks could be this one's parent: anything but itself and its own
  // descendants (that would close a loop). Excluded up front, so the loop refusal
  // in changeParent() is a backstop rather than something you meet by clicking.
  // A member of a parent, as a row: the status it is in, its title, and its own
  // rollup when it is a parent too.
  function memberRow(k) {
    var r = el("button", "row member" + (TERMINAL[k.status] ? " done" : ""));
    r.type = "button";
    var t = el("span", "member-title", k.title);
    r.appendChild(t);
    if (k.progress) r.appendChild(progressBadge(k));
    if (k.target) r.appendChild(targetEl(k.target, "member-date"));
    // The status pill, not a coloured dot: Now, Next and Later differed by hue
    // alone, and the row's `title` is a hover tooltip — nothing a colour-blind
    // reader on a touch screen can reach.
    //
    // Last in the row, at natural width. Leading it took a fixed width to keep the
    // titles in a column, and a fixed width is wrong for a word: the labels run
    // from 49px (Now) to 87px (Cancelled), and 62px clipped Inbox. Trailing, the
    // titles align on the left edge — better than any prefix column managed — and
    // the pill sits where the eye already goes for state.
    r.appendChild(statusPill(k.status));
    r.title = STATUS_LABEL[k.status] || k.status;
    r.addEventListener("click", function () { openModal(k); });
    return r;
  }

  // The relation is authored on the *child* (`parent:`), so adding from here is
  // the same single-field write with the arguments swapped — no second direction
  // in the data, just one in the interface.
  // Who could join this parent: a native puck that isn't already in it, isn't itself,
  // and wouldn't close a loop — and whose *own* file we can write, because that is
  // the file this writes. One predicate, asked twice: once to decide whether to
  // offer the control at all, once to fill it.
  function memberCandidate(item, other) {
    return other !== item && other.parentRef !== item.id && other.native &&
      canWrite(other) && !wouldLoop(other, item.id);
  }
  function canAddMember(item) {
    if (!ghToken()) return false;
    // Creating the first member is precisely what an empty parent needs, and the old
    // condition made that unreachable: no existing candidate, no picker, no way to
    // make one. The picker is worth drawing whenever *either* end is possible — but
    // "can create here" is `canCreateIn`, not merely "can write here".
    if (canCreateIn(item.repo)) return true;
    for (var i = 0; i < DATA.items.length; i++) {
      if (memberCandidate(item, DATA.items[i])) return true;
    }
    return false;
  }
  function addPuckPicker(item) {
    return puckPicker("\uff0b  Add puck", {
      title: "Add a puck to " + item.title,
      current: null,
      repo: item.repo,
      exclude: function (other) { return !memberCandidate(item, other); },
      onPick: function (chosen) { if (chosen) changeParent(chosen, item.id); },
      // The one place where creating is a single commit: membership is authored on
      // the child, and here the child is the thing being made. `later` rather than
      // `inbox` because putting a puck in a parent *is* filing it — an inbox stub
      // would be filed and then hidden by the board it was filed on.
      create: {
        noun: "puck",
        run: function (title) { createPuck(item.repo, title, "later", [], null, "", { parent: item.id, open: false }); },
      },
    });
  }

  function parentCandidates(item) {
    return function (other) { return other === item || wouldLoop(item, other.id); };
  }

  // The Parent cell in the rail: a link to the parent when set, plus an edit
  // affordance. Same inline shape as Issue and Target.
  function parentValue(item, editable) {
    var wrap = el("span", "issue-cell");
    var p = parentItem(item);
    if (p) {
      var a = el("a", "blocker-link", p.title);
      a.href = "#" + p.id;
      a.addEventListener("click", function (e) { e.preventDefault(); openModal(p); });
      wrap.appendChild(a);
    } else if (item.parent) {
      wrap.appendChild(el("span", "prop-muted", item.parent)); // named but unresolved — the flag says why
    } else if (!editable) {
      wrap.appendChild(el("span", "prop-muted", "\u2014"));
    }
    if (editable) {
      // Set: the name navigates (a relation is a place you go), and the edit sits
      // behind a quiet secondary control. Empty: one chip that says what it does.
      // What is gone is the pair — a value that only restated "nothing" next to a
      // link that did the work.
      wrap.appendChild(puckPicker(item.parent ? "\u22ef" : "Set parent", {
        repo: item.repo,
        title: "Parent",
        help: "https://github.com/tor2dbear/roadmap/blob/main/CONVENTION.md#the-level-above-parent",
        current: item.parentRef,
        exclude: parentCandidates(item),
        placeholder: "Find a parent…",
        // One token: the parent this puck sits in. Its ✕ takes it out, which is why
        // the list needs no separate "No parent" row any more.
        tokens: function () {
          if (!item.parent) return [];
          var cur = parentItem(item);
          return [{
            label: cur ? cur.title : item.parent,
            color: cur ? cur.repoColor : null,
            onRemove: function () { changeParent(item, null); },
          }];
        },
        onPick: function (target) { changeParent(item, target && target.id); },
        // Two writes, and they cannot be one: the parent is the *parent*, so the
        // relation is authored on the puck we are standing in, not on the file being
        // created. The second only runs if the first committed — otherwise a puck
        // would point at a parent that had just been rolled back. If the link fails
        // the parent still exists and is on the board, which is recoverable in one
        // click, and `changeParent` says so itself.
        create: {
          noun: "parent",
          run: function (title) {
            var made = createPuck(item.repo, title, "later", [], null, "", { open: false });
            if (made) made.then(function (p) { if (p) changeParent(item, p.id); });
          },
        },
      }));
    }
    return wrap;
  }

  function changeIssue(item, number) {
    number = number || null;
    if (number === (item.issue || null) || !ghToken()) return;
    var prevI = item.issue, prevState = item.issueState, prevU = item.updated;
    item.issue = number;
    if (number == null) item.issueState = null; // unknown until reharvest
    item.updated = today();
    renderBoard(); reopenIfOpen(item);
    toast("Saving…");
    commitIssue(item, number)
      .then(function () { toast(number ? "✓ Linked issue #" + number + " — live in ~1 min" : "✓ Unlinked — live in ~1 min"); })
      .catch(function (err) {
        item.issue = prevI; item.issueState = prevState; item.updated = prevU;
        noteWriteError(item, err);
        renderBoard(); reopenIfOpen(item);
        toast("✗ " + err.message, true);
      });
  }

  // Create a GitHub issue for this puck and auto-link it. Thin-via-GitHub: the
  // issue is the discussion; we just open one and point `issue:` at it. Needs
  // Issues: write on the token — without it we fall back to GitHub's prefilled
  // new-issue composer (the "just give me a link" path), then you Link issue.
  function openGithubNewIssue(item) {
    var url = "https://github.com/" + item.repo + "/issues/new?title=" +
      encodeURIComponent(item.title) + "&body=" + encodeURIComponent("From the roadmap board: " + item.sourceUrl);
    window.open(url, "_blank", "noopener");
  }
  function newIssue(item) {
    if (!canWrite(item)) return;
    if (!window.confirm("Create a GitHub issue “" + item.title + "” in " + item.repoName + " and link it to this puck?")) return;
    var token = ghToken();
    toast("Creating issue…");
    fetch("https://api.github.com/repos/" + item.repo + "/issues", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: item.title, body: "From the roadmap board: " + item.sourceUrl }),
    }).then(function (r) {
      if (r.status === 403 || r.status === 404) {
        toast("Token can’t create issues here — opening GitHub. Paste the number via Link issue.", true);
        openGithubNewIssue(item);
        return null;
      }
      if (!r.ok) throw new Error("couldn’t create the issue (" + r.status + ")");
      return r.json();
    }).then(function (data) {
      if (data && data.number) { item.issueState = data.state || "open"; changeIssue(item, data.number); }
    }).catch(function (err) { toast("✗ " + (err && err.message || "issue failed"), true); });
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

  // Delete a puck: remove its markdown file from the source repo (read sha →
  // DELETE). Git-native — the file is gone from the board, git history keeps it.
  // For genuine junk; "won't do but keep the record" is `status: cancelled`.
  function commitDelete(item) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
      .then(function (info) {
        return fetch(api, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: delete " + item.slug, sha: info.sha, branch: branch }),
        });
      })
      .then(function (r) { assertOk(r, item); });
  }
  function confirmDeletePuck(item) {
    if (!canWrite(item)) return;
    if (!window.confirm("Delete “" + item.title + "”?\n\nThis removes " + item.sourcePath + " from " + item.repoName +
      ". Git history keeps it, but it leaves the board. For “won’t do, keep the record”, set status to Cancelled instead.")) return;
    toast("Deleting…");
    commitDelete(item)
      .then(function () {
        // Ur parenten först, sen ur listan: annars stod föräldern kvar med ett barn
        // som inte finns, fel `progress` och en `rollup-open`-varning om delar som
        // inte längre är öppna — ända till nästa skörd.
        var parent = item.parentRef;
        relink(item, null, null);
        var i = DATA.items.indexOf(item);
        if (i >= 0) DATA.items.splice(i, 1);
        if (parent) { recountParent(parent); syncRollupSignals(itemById(parent)); }
        closeModal();
        afterEdit(parent);
        toast("✓ Deleted — live after next sync");
      })
      .catch(function (err) { noteWriteError(item, err); toast("✗ " + (err && err.message || "delete failed"), true); });
  }

  // Commit an edited body via the Contents API (read sha → PUT), bumping updated.
  function commitBody(item, newBody) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + item.repo + "/contents/" + item.sourcePath.split("/").map(encodeURIComponent).join("/");
    var branch = branchOf(item);
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    return fetch(api + "?ref=" + encodeURIComponent(branch), { headers: headers })
      .then(function (r) { assertOk(r, item); return r.json(); })
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
      .then(function (r) { assertOk(r, item); });
  }

  // Swap the rendered body for a textarea; Save commits, Cancel restores.
  //
  // A `contenteditable="plaintext-only"` stood here for one commit, on the theory that
  // iOS Safari's 16px floor is about *form controls* — which is what the floor's own
  // comment in styles.css implies when it says the answer is to not have a native
  // field. Measured on the device, that theory is wrong. Focusing a 14px editable div
  // zoomed the page by 1.147; 16/14 is 1.143. The floor is about the focused *editable
  // element*, not about which tag it is, so a contenteditable buys exactly nothing
  // here — while costing a feature probe, an `innerText` round trip, and a
  // `white-space` dependency that Chromium hid and Safari did not (the body opened as
  // one run-together blob there, and Save would have committed it that way).
  //
  // The <select>s that did escape the floor escaped it by having no editable text at
  // all, not by not being form controls. That is the part of the rule that generalised
  // and the part that did not.
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
    // Auto-grow so the whole body is visible without an inner scrollbar (nicer on mobile).
    function autoGrow() { ta.style.height = "auto"; ta.style.height = Math.max(200, ta.scrollHeight + 2) + "px"; }
    ta.addEventListener("input", autoGrow);

    // Where the editor lands is not the browser's call on a phone. Focusing a field
    // scrolls it into view against the *layout* viewport, which does not know a
    // keyboard is about to cover the lower half — and `autoGrow` then makes the box
    // thousands of pixels tall *after* that scroll, so the browser's idea of "in view"
    // was measured on a box that no longer exists. Measured at 390×844 on a long puck:
    // the editor's top landed 498px down, with the keyboard leaving about 410.
    //
    // Pin its top under the topbar instead, which is the rule the sheet already
    // follows: the field at the top, the first lines in the band above the keyboard.
    function reveal() {
      if (!ta.isConnected) return;
      // Scrolls the port, and measures against the port's own top rather than the
      // viewport's: the chrome above it (topbar, view header, chip row) is outside the
      // scrollport now, so subtracting the topbar's height would aim 52px too high.
      paneRefs();
      if (!workEl) return;
      var box = workEl.getBoundingClientRect();
      workEl.scrollTop = Math.max(0, workEl.scrollTop + ta.getBoundingClientRect().top - box.top - 8);
    }
    // iOS can scroll again *after* focus, once the keyboard is up, which would undo the
    // line above. A shrinking visual viewport is the only event that says the keyboard
    // arrived — a growing one is it leaving, and re-aiming then would yank the page out
    // from under a reader who dismissed it on purpose.
    var vv = window.visualViewport;
    var vvHeight = vv ? vv.height : 0;
    function onKeyboard() {
      // Leaving the puck by the breadcrumb, Back or the sidebar never runs `restore()`,
      // so this can still be registered against an editor that is no longer in the
      // document. `reveal()` already refuses to act on one; this is what stops the
      // listener itself from outliving every abandoned edit.
      if (!ta.isConnected) { vv.removeEventListener("resize", onKeyboard); return; }
      if (vv.height >= vvHeight) { vvHeight = vv.height; return; }
      vv.removeEventListener("resize", onKeyboard);
      reveal();
    }
    if (vv) vv.addEventListener("resize", onKeyboard);

    ta.focus();
    setTimeout(function () { autoGrow(); reveal(); }, 0);
    function restore(md) {
      if (vv) vv.removeEventListener("resize", onKeyboard);
      bodyEl.innerHTML = renderMd(md || "(no details)");
      editBtn.style.display = "";
    }
    cancel.addEventListener("click", function () { restore(item.body); });
    save.addEventListener("click", function () {
      var newBody = ta.value, prev = item.body;
      item.body = newBody; item.updated = today();
      restore(newBody);
      toast("Saving…");
      commitBody(item, newBody)
        .then(function () { toast("✓ Saved — live in ~1 min"); })
        .catch(function (err) { item.body = prev; noteWriteError(item, err); openModal(item); toast("✗ " + err.message, true); });
    });
  }


  // Toast
  var toastEl, toastTimer;
  // Every clause that promises the commit will become live somewhere. `live in ~1 min` is
  // the hourly harvest; `live after next sync` is the same promise worded for a delete
  // and for the workspace settings. The demo makes no commit, so both are untrue there —
  // rewritten in one place rather than at the seventeen call sites, for the same reason
  // the network is intercepted in one place.
  //
  // Covering only the first variant is how the fix looked finished and left two receipts
  // still saying the change would go live: deleting a puck and saving Settings, which are
  // exactly the two writes a visitor is most likely to hesitate over.
  var DEMO_PROMISE = / — live (?:in ~1 min|after next sync)/g;
  function toast(msg, isErr) {
    if (DEMO) msg = String(msg).replace(DEMO_PROMISE, " — in this browser only");
    if (!toastEl) { toastEl = el("div", "toast"); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = "toast"; }, isErr ? 6000 : 2600);
  }

  // slugify — a byte-for-byte copy of scripts/lib/adapters.mjs so a GUI-created
  // puck lands at the same path the harvester derives from the title.
  // The slug transform, and the filename guarantee, as two things.
  //
  // `slugify` ends in `|| "item"` so a puck titled "???" still gets a filename —
  // right for a filename, wrong for a query, where empty has to stay empty. The
  // labels box normalised its search text with slugify() and so searched for "item"
  // the moment the field was empty: `Create #item` was offered before a key was
  // pressed, all 81 real labels were filtered away (none contains "item"), and
  // Enter on an empty field would have added the label `#item`.
  //
  // Callers that need a filename take `slugify`; callers that need "what was typed,
  // normalised" take `slugChars` and decide for themselves what empty means.
  function slugChars(s) {
    return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }
  function slugify(s) { return slugChars(s) || "item"; }

  // The new-puck file body — mirrors `roadmap new` in scripts/roadmap.mjs.
  // New-puck body skeleton: a spiked-but-driftable structure. Config-driven via
  // board.config.json `sections` (array or comma string); default English trio.
  // Set it to [] for an empty body (let the AI fill it in the refine step).
  function templateSections() {
    var s = CFG.sections;
    if (Array.isArray(s)) return s.filter(Boolean);
    if (typeof s === "string") return s.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    return ["Goal", "Research", "Open questions"];
  }
  function puckBody(context) {
    var secs = templateSections();
    var body = secs.length ? secs.map(function (name) { return "## " + name + "\n\n"; }).join("\n") : "";
    if (context) body = context + "\n\n" + body; // a lead paragraph above the skeleton
    return body;
  }
  function puckTemplate(title, status, tags, agent, context, parentRef) {
    var t = /[:#]/.test(title) ? JSON.stringify(title) : title;
    var lines = ["---", "title: " + t, "status: " + status];
    if (tags.length) lines.push("tags: [" + tags.join(", ") + "]");
    if (agent) lines.push("agent: " + agent);
    // Membership is authored on the child, so a puck created *from* its parent can
    // carry the relation in the file it is born with — one write instead of two,
    // and no window where the puck exists outside the parent it was made for.
    if (parentRef) lines.push("parent: " + parentRef);
    lines.push("updated: " + today(), "created: " + today(), "---", "");
    var body = puckBody(context);
    return lines.join("\n") + (body ? "\n" + body : "");
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
    }).then(function (r) {
      if (r.ok) return;
      if (r.status === 422) throw new Error("already exists");
      var e = new Error(r.status === 403 || r.status === 404
        ? "No write access to that repo — your token needs Contents: write"
        : "create failed (" + r.status + ")");
      e.status = r.status;
      throw e;
    });
  }

  // Optimistic create: add to the board now, commit in the background, revert on failure.
  // `opts.parent` writes the relation into the template (one commit, see above).
  // `opts.open` false keeps you where you are — creating a puck from a picker is
  // something you did *while* in the middle of something else, and yanking the page
  // to the new file is the interruption the picker existed to avoid.
  //
  // Returns a promise that resolves with the item, or with `null` if the write failed —
  // and `null` synchronously if the slug is already taken. It never rejects, so a caller
  // that fires and forgets cannot leak an unhandled rejection, and one that needs a
  // second write only has to ask whether the first happened.
  function createPuck(repo, title, status, tags, agent, context, opts) {
    opts = opts || {};
    var slug = slugify(title);
    var short = repo.split("/").pop();
    var id = short + "/" + slug;
    if (DATA.items.some(function (x) { return x.id === id; })) { toast('✗ A puck "' + slug + '" already exists here', true); return null; }
    var src = DATA.sources.filter(function (s) { return s.repo === repo; })[0] || {};
    var meta = sourceMeta(repo);
    var path = meta.dir + "/" + slug + ".md";
    var body = puckBody(context);
    var item = {
      id: id, repo: repo, repoName: src.name || short, repoColor: src.color || "#888888",
      issueState: null, slug: slug, title: title, status: status, tags: tags, updated: today(),
      created: today(), issue: null, order: 0, depends: [], owner: null, agent: agent || null, body: body,
      parent: null, parentRef: null, children: [], progress: null, blocks: [], missingDepends: [],
      sourcePath: path, sourceUrl: "https://github.com/" + repo + "/blob/" + meta.branch + "/" + path,
      adapter: "pucks", native: true, blockedBy: [], signals: [],
    };
    var parentItm = opts.parent ? itemById(opts.parent) : null;
    var parentRef = parentItm ? refFor(item, parentItm) : null;
    // Pushed before linked: `relink` recounts the parent's rollup through `itemById`,
    // so a child that is not in the list yet would be left out of the number that is
    // supposed to have just grown.
    DATA.items.push(item); DATA.total += 1;
    if (parentItm) relink(item, parentItm.id, parentRef);
    // A new puck can satisfy a `depends:` that named something not on the board yet —
    // anywhere, not only on the puck we came from. The derived edges are recomputed
    // from the authored refs, so adding an item is enough to change them, and nothing
    // else was going to notice until the next harvest.
    recomputeDeps();
    buildAgentChips();
    var opened = opts.open !== false;
    // Both ends changed, and with `open: false` the parent is the page still on screen —
    // the same lesson `changeParent` learned: redrawing only the board left its Contains
    // list and its rollup describing the state from before the click, on the one page
    // the caller asked to stay on. `afterEdit` is the path that refreshes an open puck,
    // so the new child goes through it rather than around it.
    afterEdit(parentItm || item);
    if (opened) openModal(item);
    toast("Creating…");
    return commitCreate(repo, path, meta.branch,
      puckTemplate(title, status, tags, agent, context, parentRef), "roadmap: add " + slug)
      .then(function () { toast("✓ Created — live in ~1 min"); return item; })
      .catch(function (err) {
        noteWriteError({ repo: repo }, err);
        if (parentItm) relink(item, null, null); // take the optimistic edge back out
        var i = DATA.items.indexOf(item); if (i >= 0) DATA.items.splice(i, 1);
        DATA.total -= 1; recomputeDeps(); buildAgentChips();
        // The rollback is as visible as the addition was — and `currentDetailItem` is
        // the point, not just `parentItm`. Creating from the Parent or Blocked by picker
        // has no parent to refresh, so this passed `null` and left the puck you are
        // standing in untouched. `noteWriteError` has *just* learned the repo is
        // read-only, and the rail was still offering the controls that had proved it.
        afterEdit(parentItm || null, currentDetailItem || null);
        // Only the modal we opened. Closing unconditionally would have shut the puck
        // the picker was called from — the one page the caller asked to stay on.
        if (opened) closeModal();
        toast("✗ " + err.message, true);
        // Resolves with `null` rather than rejecting. A caller that needs the second
        // write asks "did it happen"; nobody needs the error object, because the toast
        // and the rollback already dealt with it. Rethrowing made the two callers that
        // deliberately ignore the promise — the sidebar's New puck and `＋ Add puck` —
        // leak an unhandled rejection into the console on every failed write. `null` is
        // already this function's word for "did not happen": it is what the duplicate
        // guard returns, synchronously, above.
        return null;
      });
  }

  // ＋ new-puck control (sidebar foot).
  var newBtns = [], userEl;
  function refreshEditControls() {
    newBtns.forEach(function (b) { b.hidden = !ghToken(); });
    // Sync dispatches a workflow run, so it is a write like the others and gated the
    // same way — one place decides what a token renders, or signing out leaves a
    // control behind that only fails when pressed.
    refreshSyncButton();
  }
  function afterAuth() {
    writableRepos = null; readOnlyRepos = new Set();
    refreshEditControls(); refreshUser(); loadWritableRepos();
    // Chrome that a token *renders* rather than merely checks. Every write path
    // re-asks `ghToken()` and returns, so nothing corrupt happens — but a control
    // that only fails when you press it is not gated, it is decorated. These two
    // are built once rather than on each open, so signing out has to take them
    // away: the saved views' ✕ (`buildSavedViews`) and the chip row's Save.
    refreshNav(); renderChips();
  }
  function buildEditControls() {
    // New: primary create action in the sidebar (desktop) + the mobile topbar
    // (next to search, so it's reachable without opening the menu). Token-gated.
    newBtns = ["sideNew", "topNew"].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    newBtns.forEach(function (b) {
      b.hidden = !ghToken();
      b.addEventListener("click", openNewPuckPanel);
    });
    syncWrap = document.getElementById("syncWrap");
    syncBtn = document.getElementById("syncNow");
    syncBar = document.getElementById("syncBar");
    if (syncBtn) syncBtn.addEventListener("click", runSync);
    refreshSyncButton();
    reportSyncOnBoot();
  }

  // Desktop-only resizable sidebar: a drag handle on the sidebar/main seam sets
  // --sidebar-w (the grid's first column), persisted to localStorage. clientX is the
  // sidebar's width because the sidebar starts at viewport-left. Pointer capture keeps
  // the drag alive when the cursor leaves the 6px handle. Mobile (drawer) is untouched.
  function initSidebarResize() {
    var KEY = "roadmap-sidebar-w", MIN = 190, MAX = 460;
    try { var saved = localStorage.getItem(KEY); if (saved) document.documentElement.style.setProperty("--sidebar-w", parseInt(saved, 10) + "px"); } catch (e) {}
    var r = document.getElementById("colResizer");
    if (!r) return;
    var dragging = false;
    r.addEventListener("pointerdown", function (e) {
      if (window.matchMedia("(max-width: 899px)").matches) return;
      dragging = true; r.classList.add("dragging"); document.body.classList.add("col-resizing");
      try { r.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    r.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var w = Math.max(MIN, Math.min(MAX, Math.round(e.clientX)));
      document.documentElement.style.setProperty("--sidebar-w", w + "px");
    });
    function end() {
      if (!dragging) return;
      dragging = false; r.classList.remove("dragging"); document.body.classList.remove("col-resizing");
      var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10);
      if (cur) { try { localStorage.setItem(KEY, String(cur)); } catch (e) {} }
    }
    r.addEventListener("pointerup", end);
    r.addEventListener("pointercancel", end);
    r.addEventListener("dblclick", function () { document.documentElement.style.removeProperty("--sidebar-w"); try { localStorage.removeItem(KEY); } catch (e) {} });
  }

  // Linear-style workspace header: the top of the sidebar leads with the workspace
  // (the git-merge glyph + the board title), and the *account* — your GitHub identity
  // (derived from the token via api.github.com) and Sign out — lives inside its menu.
  // Workspace = what board this is (config-driven title); identity = whose token it is
  // (whose commits your edits become). Two different things, two slots — the person is
  // never the headline, the workspace is.
  function buildUserControl() {
    userEl = document.querySelector(".side-brand");
    var btn = document.getElementById("wsBtn");
    if (!btn || !userEl) return;
    btn.addEventListener("click", function (e) { e.stopPropagation(); toggleUserMenu(); });
    refreshUser();
  }
  function refreshUser() {
    // Auth state changed → drop any open menu so it rebuilds fresh next open.
    if (!userEl) return;
    var open = userEl.querySelector(".ws-menu");
    if (open) open.remove();
    var btn = document.getElementById("wsBtn");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function toggleUserMenu() {
    var btn = document.getElementById("wsBtn");
    var open = userEl.querySelector(".ws-menu");
    if (open) { open.remove(); if (btn) btn.setAttribute("aria-expanded", "false"); return; }
    var menu = el("div", "ws-menu user-menu");
    menu.setAttribute("role", "menu");
    function settingsItem() {
      var s = el("button", "row user-mi", "Settings");
      s.type = "button";
      s.addEventListener("click", function () { menu.remove(); openSettingsPanel(); });
      return s;
    }
    if (ghToken()) {
      // identity header — the account, shown inside the workspace menu (Linear puts
      // the person here, not at the top). Fetched live from the token.
      var head = el("div", "ws-menu-head");
      var av = el("span", "user-av");
      var name = el("span", "ws-menu-who", "…");
      head.appendChild(av);
      head.appendChild(name);
      menu.appendChild(head);
      menu.appendChild(settingsItem());
      fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + ghToken(), Accept: "application/vnd.github+json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (u) {
          if (DEMO) { name.textContent = "Demo — not signed in"; head.classList.add("demo-who"); return; }
          if (u && u.login) {
            name.textContent = "@" + u.login;
            var img = document.createElement("img");
            img.className = "user-av-img"; img.alt = ""; img.src = u.avatar_url;
            av.appendChild(img);
          } else { name.textContent = "token invalid"; head.classList.add("bad"); }
        })
        .catch(function () { name.textContent = "signed in"; });
      // There is no token to change or sign out of in the demo, and offering either
      // would be a control that cannot do what it says. The note takes their place.
      if (DEMO) {
        menu.appendChild(el("div", "fp-empty", "Everything here is editable and nothing is committed — changes live in this browser tab until you reload."));
      } else {
        var change = el("button", "row user-mi", "Change token");
        change.type = "button";
        change.addEventListener("click", function () { menu.remove(); openTokenPanel(afterAuth); });
        var out = el("button", "row user-mi danger", "Sign out");
        out.type = "button";
        out.addEventListener("click", function () { menu.remove(); setGhToken(""); afterAuth(); });
        menu.appendChild(change);
        menu.appendChild(out);
      }
    } else {
      menu.appendChild(settingsItem());
      var signin = el("button", "row user-mi", "Sign in to edit");
      signin.type = "button";
      signin.addEventListener("click", function () { menu.remove(); openTokenPanel(afterAuth); });
      menu.appendChild(signin);
    }
    userEl.appendChild(menu);
    if (btn) btn.setAttribute("aria-expanded", "true");
    setTimeout(function () {
      document.addEventListener("click", function closer(e) {
        if (!userEl.contains(e.target)) { menu.remove(); if (btn) btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", closer); }
      });
    }, 0);
  }

  function field(labelText, control) {
    var d = el("div", "np-field");
    var l = el("label", null, labelText); d.appendChild(l); d.appendChild(control);
    return d;
  }
  // One capture flow for New *and* ⌘K: Title + Repo (+ optional context). Repo is
  // permanent (the file lives there, can't move later), so it's always shown —
  // defaulting to the current scope / this board's repo. Everything else (status,
  // A panel (New puck / Edit access / Settings) is a modal: it owns Escape while it
  // is up. Without this the press fell past it to the puck's own backdrop listener
  // and closed the *puck* behind the panel — the same "a layer nobody aimed at
  // handles the key" bug as a surface eating Escape under a panel. Help and the
  // palette still outrank it; the unwind order is help → palette → panel → surface
  // → puck.
  // There is exactly one panel at a time. `modal-open` is a single boolean and
  // Escape wants a single owner, so a second panel would leave both wrong: closing
  // one by its button clears the class while the other is still on screen, and one
  // Escape would take them all (stopPropagation doesn't stop a sibling listener on
  // the same node). Cheaper to make stacking impossible than to make it correct —
  // and there is no reading of the product where two panels at once is the answer.
  var openPanel = null;
  function panelCloser(back) {
    if (openPanel) openPanel();
    var done = false;
    var popPanelLayer = pushLayer([back]);
    function close() {
      // Idempotent, and it only gives up the shared state while it still owns it.
      // A panel's async paths hold this closure: Settings can finish its save long
      // after the user closed it and opened something else, and a second close then
      // cleared `modal-open` out from under the panel that had taken over.
      if (done) return;
      done = true;
      popPanelLayer();
      document.removeEventListener("keydown", onEsc, true);
      if (back.parentNode) document.body.removeChild(back);
      if (openPanel !== close) return;
      openPanel = null;
      document.body.classList.remove("modal-open");
    }
    function onEsc(e) {
      if (e.key !== "Escape" || cmdkVisible() || helpOpen()) return;
      // A surface opened *from inside* the panel — the Repo picker in New puck — is a
      // layer above it and owns the press. Without this the panel's capture listener
      // ran first and the surface never saw the key: one press closed the whole form
      // and left the picker orphaned over a panel that no longer existed.
      if (openSurfaces.length) return;
      // Immediate: this layer owns the press outright. Plain stopPropagation leaves
      // any other listener on document — a surface's, the puck's — free to act on
      // the same key.
      e.stopImmediatePropagation();
      close();
    }
    document.addEventListener("keydown", onEsc, true);
    openPanel = close;
    return close;
  }
  // priority, agent, labels) is set on the puck page after creation.
  function openNewPuckPanel(preset) {
    if (!ghToken()) return;
    preset = preset || {};
    closeSurfaces(); // a panel owns the screen: no picker left alive underneath it
    var back = el("div", "token-backdrop");
    var close = panelCloser(back);
    var p = el("div", "token-panel");
    p.appendChild(el("h3", "token-title", "New puck"));
    var defRepo = preset.repo || defaultCaptureRepo() || (DATA.sources[0] && DATA.sources[0].repo);
    // The last native <select> in the app. Same reason as the Display menu's two: on
    // iOS it draws the system wheel, and a focused native field drags the 16px zoom
    // floor along with it. The value lives in a variable now instead of in the DOM.
    var repo = defRepo;
    var projHost = el("div", "prop-pick-host");
    function paintProj() {
      projHost.innerHTML = "";
      projHost.appendChild(propPicker({
        title: "Repo", editable: true, boxed: true, current: repo,
        options: DATA.sources.map(function (s) { return { value: s.repo, label: s.name }; }),
        valueNode: function (o) { return el("span", null, o.label); },
        onPick: function (v) { repo = v; paintProj(); updatePreview(); },
      }));
    }
    var title = el("input", "token-input"); title.type = "text"; title.placeholder = "Title"; title.autocomplete = "off";
    if (preset.title) title.value = preset.title;
    var ctx = el("textarea", "token-input np-context"); ctx.placeholder = "Context (optional) — a line more than the title"; ctx.rows = 2;
    var preview = el("div", "np-preview", "");
    function updatePreview() {
      var m = sourceMeta(repo);
      preview.textContent = title.value.trim() ? "→ " + m.dir + "/" + slugify(title.value) + ".md" : "";
    }
    title.addEventListener("input", updatePreview);
    paintProj();
    p.appendChild(field("Repo", projHost));
    p.appendChild(field("Title", title));
    p.appendChild(preview);
    p.appendChild(field("Context", ctx));
    p.appendChild(el("p", "set-note", "Status, priority, agent and labels are set on the puck after you create it."));
    var actions = el("div", "token-actions");
    var create = el("button", "tbtn primary", "Create");
    var cancel = el("button", "tbtn", "Cancel");
    create.addEventListener("click", function () {
      var t = title.value.trim();
      if (!t) { title.focus(); return; }
      close();
      createPuck(repo, t, preset.status || "inbox", [], null, ctx.value.trim());
    });
    cancel.addEventListener("click", close);
    actions.appendChild(create); actions.appendChild(cancel);
    p.appendChild(actions);
    back.appendChild(p);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    document.body.classList.add("modal-open");
    updatePreview();
    title.focus();
  }

  function openTokenPanel(after) {
    closeSurfaces(); // a panel owns the screen: no picker left alive underneath it
    var back = el("div", "token-backdrop");
    var close = panelCloser(back);
    var p = el("div", "token-panel");
    p.appendChild(el("h3", "token-title", "Edit access"));
    p.appendChild(el("p", "token-note",
      "Paste a GitHub fine-grained token with Contents: write on your roadmap repo(s). It’s stored only in this browser and used to commit edits straight to GitHub. Add Issues: write too for one-click “New issue” (optional — without it, that falls back to opening GitHub), and Actions: write on the board’s own repo for “sync now” (without it the button is there but the sync is refused)."));
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

  // Derive the aggregator repo (where board.config.json lives) from the source URL.
  function aggregatorRepo() {
    var m = /github\.com\/([^\/]+)\/([^\/#?]+)/.exec(CFG.repoUrl || "");
    return m ? m[1] + "/" + m[2].replace(/\.git$/, "") : null;
  }
  function settingsField(parent, label, value) {
    var f = el("div", "np-field");
    f.appendChild(el("label", null, label));
    var i = el("input", "token-input"); i.type = "text"; i.value = value; i.autocomplete = "off"; i.spellcheck = false;
    f.appendChild(i); parent.appendChild(f);
    return i;
  }
  function themeControl() {
    var wrap = el("div", "np-field");
    wrap.appendChild(el("label", null, "Theme"));
    var cur = root.getAttribute("data-theme") || "auto";
    var seg = segmented(
      [["light", "Light"], ["dark", "Dark"], ["auto", "Auto"]],
      cur,
      function (v) { setTheme(v); });
    seg.classList.add("set-seg");
    wrap.appendChild(seg);
    return wrap;
  }
  // Commit board.config.json (read sha → merge → PUT) to the aggregator repo.
  function commitConfig(repo, next) {
    var token = ghToken();
    var api = "https://api.github.com/repos/" + repo + "/contents/board.config.json";
    var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
    var errItem = { repo: repo, repoName: repo };
    return fetch(api, { headers: headers })
      .then(function (r) { assertOk(r, errItem); return r.json(); })
      .then(function (info) {
        var cfg = {};
        try { cfg = JSON.parse(b64decode(info.content)); } catch (e) {}
        cfg.title = next.title; cfg.description = next.description; cfg.repoUrl = next.repoUrl;
        if (next.sections) cfg.sections = next.sections;
        var out = JSON.stringify(cfg, null, 2) + "\n";
        return fetch(api, {
          method: "PUT",
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "roadmap: update board config", content: b64encode(out), sha: info.sha }),
        });
      })
      .then(function (r) { assertOk(r, errItem); });
  }
  // Settings: workspace identity writes through to board.config.json (git-native,
  // the same pen as puck edits); preferences are per-browser.
  function openSettingsPanel() {
    closeSurfaces(); // a panel owns the screen: no picker left alive underneath it
    var back = el("div", "token-backdrop");
    var close = panelCloser(back);
    var p = el("div", "token-panel set-panel");
    p.appendChild(el("h3", "token-title", "Settings"));
    var repo = aggregatorRepo();
    var canGit = !!ghToken() && !!repo && !readOnlyRepos.has(repo);

    p.appendChild(el("div", "set-eyebrow", "Workspace"));
    p.appendChild(el("p", "set-note", repo
      ? (DEMO
        ? "Editable here, but nothing is written — changes live in this browser tab until you reload."
        : "Writes board.config.json in " + repo + " — live after the next sync.")
      : "No source repo configured, so board.config.json can’t be located."));
    var title = settingsField(p, "Name (organisation / workspace)", CFG.title || "");
    var desc = settingsField(p, "Description", CFG.description || "");
    var url = settingsField(p, "Source URL", CFG.repoUrl || "");
    var sections = settingsField(p, "New-puck sections", templateSections().join(", "));
    p.appendChild(el("p", "set-note", "Headings a fresh puck starts with (comma-separated). Leave empty for a blank body the AI fills in."));
    if (!ghToken()) {
      [title, desc, url, sections].forEach(function (i) { i.disabled = true; });
      p.appendChild(el("p", "set-note warn", "Sign in to edit these."));
    } else if (repo && readOnlyRepos.has(repo)) {
      [title, desc, url, sections].forEach(function (i) { i.disabled = true; });
      p.appendChild(el("p", "set-note warn", "Read-only — your token has no write access to " + repo + "."));
    }

    p.appendChild(el("div", "set-eyebrow", "Preferences"));
    p.appendChild(themeControl());
    var resetW = el("button", "resetbtn set-linkbtn");
    resetW.type = "button";
    resetW.appendChild(icon("reset"));
    resetW.appendChild(el("span", null, "Reset sidebar width"));
    resetW.addEventListener("click", function () {
      document.documentElement.style.removeProperty("--sidebar-w");
      try { localStorage.removeItem("roadmap-sidebar-w"); } catch (e) {}
      toast("Sidebar width reset");
    });
    p.appendChild(resetW);

    var actions = el("div", "token-actions");
    var save = el("button", "tbtn primary", "Save");
    var cancel = el("button", "tbtn", "Close");
    save.disabled = !canGit;
    save.addEventListener("click", function () {
      if (!canGit) { close(); return; }
      var next = { title: title.value.trim(), description: desc.value.trim(), repoUrl: url.value.trim(),
        sections: sections.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) };
      save.disabled = true; toast("Saving…");
      commitConfig(repo, next)
        .then(function () {
          CFG.title = next.title; CFG.description = next.description; CFG.repoUrl = next.repoUrl; CFG.sections = next.sections;
          if (next.title) { document.title = next.title; var h1 = document.querySelector(".brand h1"); if (h1) h1.textContent = next.title; }
          var sl = document.getElementById("sourceLink"); if (sl && next.repoUrl) sl.href = next.repoUrl;
          toast("✓ Saved — live after next sync"); close();
        })
        .catch(function (err) {
          if (err && (err.status === 403 || err.status === 404) && repo) readOnlyRepos.add(repo);
          save.disabled = false; toast("✗ " + (err && err.message || "save failed"), true);
        });
    });
    actions.appendChild(save); actions.appendChild(cancel);
    cancel.addEventListener("click", close);
    p.appendChild(actions);
    back.appendChild(p);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    document.body.classList.add("modal-open");
  }

  buildEditControls();
  buildUserControl();
  initSidebarResize();
  loadWritableRepos(); // check write permissions for the signed-in token, if any

  // Deep link: open the puck named in the URL hash on load, and react to the
  // hash changing (pasted link in the same tab, or Back after opening a modal).
  var detailCloseBtn = document.getElementById("detailClose");
  if (detailCloseBtn) {
    detailCloseBtn.appendChild(icon("x", "x-icn"));
    detailCloseBtn.addEventListener("click", closeModal);
  }
  var topShareBtn = document.getElementById("topShare");
  if (topShareBtn) topShareBtn.appendChild(icon("share"));
  if (topShareBtn) topShareBtn.addEventListener("click", function () {
    if (!currentDetailItem) return;
    // Carry the board you're standing on into the link: `?q=`/`?view=`/display
    // params + `#puck` compose (see AGENTS.md), so the recipient lands on the same
    // puck *and* backs out to the same board instead of a default one.
    var url = location.origin + location.pathname + viewParams() + "#" + currentDetailItem.id;
    if (navigator.share) { navigator.share({ title: currentDetailItem.title, url: url }).catch(function () {}); }
    else { copyText(url, function () { toast("✓ Link copied"); }); }
  });

  // Reflect the URL into the view without touching history (used by Back/Forward
  // and manual hash edits). Idempotent so popstate + hashchange firing together
  // for one navigation doesn't double-render.
  function syncHash() {
    // Back/Forward can swap the puck underneath an open sheet — it lives on <body>,
    // not inside the detail pane — and a picker left standing would write to the
    // puck you just navigated away from.
    closeSurfaces();
    var it = itemFromHash();
    if (it) {
      if (!(currentDetailItem && currentDetailItem.id === it.id && document.body.classList.contains("viewing-puck"))) openDetail(it);
    } else if (document.body.classList.contains("viewing-puck")) {
      closeDetail();
    }
  }
  var deepItem = itemFromHash();
  if (deepItem) {
    if (history.state && history.state.puck === deepItem.id) {
      // Reload of a puck we opened earlier — the board entry is already behind it,
      // so just re-show it. (Synthesizing again would stack board → board → #puck
      // and make the first Back appear to do nothing.)
      openDetail(deepItem);
    } else {
      // Genuine direct deep link: put a board entry behind, then a marked puck entry,
      // so Back returns to the board and a later reload takes the branch above.
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
      openModal(deepItem);
    }
  } else if (location.hash) {
    // A hash pointing at a deleted/unknown puck: normalize to the board URL now, so
    // opening a puck later doesn't pushState over a stale hash that Back would restore.
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
  window.addEventListener("popstate", syncHash);
  window.addEventListener("hashchange", syncHash);
  // Resolves the scrollport and, with it, arms the axis lock — which otherwise would not
  // exist until something else happened to want the port.
  paneRefs();
})();
