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
      b.appendChild(document.createTextNode("!"));
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
  function agentBadge(name) {
    var b = el("span", "agent-badge");
    b.title = "Routed to " + name;
    b.appendChild(el("span", "agent-arrow", "→"));
    b.appendChild(document.createTextNode(name));
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
    showDone: false,
    focus: "all", // "all" | "ready" (unblocked now/next) | "inbox" (triage) | "attention" (flagged)
    view: "board", // "board" (kanban columns) | "list" (one column, grouped)
    sort: "default", // see SORTS below
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
  };
  var SORTS = ["default", "updated-desc", "priority", "target", "updated-asc", "created-desc", "created-asc", "title"];
  var PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
  // Display preferences persist (they're settings, not a transient filter); a URL
  // that names them wins over these on load — see readUrl().
  try {
    var savedView = localStorage.getItem("roadmap-view");
    if (savedView === "list" || savedView === "board") state.view = savedView;
    var savedSort = localStorage.getItem("roadmap-sort");
    if (SORTS.indexOf(savedSort) !== -1) state.sort = savedSort;
    var savedGroup = localStorage.getItem("roadmap-group");
    if (savedGroup) state.group = savedGroup; // validated after GROUPS is defined
    state.showDone = localStorage.getItem("roadmap-done") === "1";
    if (localStorage.getItem("roadmap-empty") === "0") state.showEmpty = false;
  } catch (e) {}
  function saveDisplay(key, value) { try { localStorage.setItem("roadmap-" + key, value); } catch (e) {} }

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
  // Without it an etapp you're running listed its parts alphabetically by slug,
  // with the one `next` puck sitting in the middle of the `now` ones.
  function childItems(item) {
    return (item.children || []).map(itemById).filter(Boolean).sort(function (a, b) {
      var sa = DATA.statuses.indexOf(a.status), sb = DATA.statuses.indexOf(b.status);
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
      if (s.type === "parent-missing") return 'Etapp "' + item.parent + '" doesn’t exist — typo, or the puck was renamed?';
      if (s.type === "parent-cycle") return 'Etapp "' + item.parent + '" closes a loop — the link is ignored.';
      if (s.type === "rollup-open") {
        var open = item.progress.total - item.progress.done;
        return "Marked " + (STATUS_LABEL[item.status] || item.status).toLowerCase() + " but " + open +
          " of " + item.progress.total + " parts " + (open === 1 ? "is" : "are") + " still open.";
      }
      if (s.type === "rollup-done") return "Every part is done — mark the etapp done?";
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
    var listType = null; // "ul" (bullets) | "ol" (numbered)
    var para = []; // buffer of wrapped lines that form one paragraph
    var liBuf = null; // buffer of wrapped lines that form one list item
    var inCode = false;
    var code = []; // buffer of lines inside a ``` fence
    function flushPara() {
      if (para.length) { out.push("<p>" + mdInline(para.join(" ")) + "</p>"); para = []; }
    }
    function flushLi() {
      if (liBuf) { out.push("<li>" + mdInline(liBuf.join(" ")) + "</li>"); liBuf = null; }
    }
    function closeList() {
      if (inList) { flushLi(); out.push("</" + listType + ">"); inList = false; listType = null; }
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
      var ul = /^\s*[-*]\s+(.*)$/.exec(line);
      var ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      var li = ul || ol;
      var wantType = ul ? "ul" : (ol ? "ol" : null);
      var liContent = ul ? ul[1] : (ol ? ol[2] : null);
      if (h) {
        flushPara();
        closeList();
        var lvl = Math.min(h[1].length, 4);
        out.push("<h" + lvl + ">" + mdInline(h[2]) + "</h" + lvl + ">");
      } else if (li) {
        flushPara();
        if (inList && listType !== wantType) closeList(); // switching bullets ↔ numbered
        flushLi(); // close the previous item before starting this one
        if (!inList) {
          // Preserve an author's starting number (a section that resumes at "3.").
          var openTag = "<" + wantType + ">";
          if (wantType === "ol" && parseInt(ol[1], 10) !== 1) openTag = '<ol start="' + parseInt(ol[1], 10) + '">';
          out.push(openTag); inList = true; listType = wantType;
        }
        liBuf = [liContent]; // buffer so soft-wrapped lines fold into this item
      } else if (line.trim() === "") {
        flushPara();
        closeList();
      } else if (inList) {
        liBuf.push(line.trim()); // lazy continuation of the current list item
      } else {
        para.push(line.trim()); // fold wrapped lines into the current paragraph
      }
    }
    flushPara();
    closeList();
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
    // The etapp a puck sits in. Matches whatever names it: the raw `parent:` value
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
    // Ready is "pick one up, or hand it to an agent" — and an etapp is neither. It
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
    // etapp, and one with neither parent nor children stands outside every etapp.
    blocking: function (i) { return !!(i.blocks || []).length; },
    etapp: function (i) { return !!(i.children || []).length; },
    member: function (i) { return !!i.parentRef; },
    // `standalone` is what the sidebar row is called, `orphan` is what it was called
    // first; same predicate, so the query language says what the button says.
    orphan: isStandalone,
    standalone: isStandalone,
  };
  // The three states cover every puck between them, and the only ones counted twice
  // are the sub-etapps — which genuinely are both. That's the check that the split
  // is the right one: `is:etapp` + `is:member` + `is:standalone` leaves nothing out.
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
        if (name === "is" && IS_STATES[lower(rest)]) {
          terms.push({ field: "is", op: "is", values: [lower(rest)], neg: neg });
          return;
        }
        // `has:<field>` — does the puck carry this field at all. The one question the
        // grammar could not ask, and the only way to say "hide the column of pucks
        // that have no priority": that column's key is the absence of a value, so
        // there is no `-priority:x` that names it. Listing every real value instead
        // (`priority:urgent,high,medium,low`) works only for a closed set and goes
        // quietly wrong for agents and etapps, where a new value would arrive already
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
      if (t.field === "is") return p + "is:" + t.values[0];
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
      hit = !!IS_STATES[t.values[0]](item);
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
  // `is:etapp` is derived (a puck with children *is* the etapp), so the view is a
  // query and not a new record type — the same trick every other view uses.
  // Etapps carries no `-status:inbox`: an etapp can sit anywhere, inbox included,
  // and hiding it there would make the sidebar's count disagree with the board.
  // Standalone does carry it — an inbox puck is standalone by definition, and
  // without the exclusion the row would just re-count the inbox.
  var VIEWS = {
    all: "-status:inbox", ready: "is:ready", inbox: "status:inbox",
    etapps: "is:etapp", standalone: "-status:inbox is:standalone", attention: "is:flagged",
  };
  // Which views can reach the archive at all, and therefore have to obey the toggle.
  // `ready` and `inbox` can't (their statuses are never terminal), and `attention`
  // *wants* to — a flagged done puck is exactly what that view is for. The rest are
  // the ones that would otherwise show landed work unasked.
  var ARCHIVABLE = { all: 1, etapps: 1, standalone: 1 };
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
  function viewParamObject() {
    var o = {};
    if (state.focus !== "all") o.view = state.focus;
    var q = serializeTerms(filterTerms());
    if (q) o.q = q;
    if (state.group !== DISPLAY_DEFAULTS.group) o.group = state.group;
    if (state.view !== DISPLAY_DEFAULTS.view) o.layout = state.view;
    if (state.sort !== DISPLAY_DEFAULTS.sort) o.sort = state.sort;
    if (state.showDone) o.done = "1";
    if (!state.showEmpty) o.empty = "0";
    // Sorted, not in click order: the same set of folded groups has to serialize to
    // the same string every time, or the URL churns and two identical views compare
    // unequal.
    if (state.view === "list" && state.collapsed.size) {
      var folded = [];
      state.collapsed.forEach(function (k) { folded.push(k); });
      o.collapsed = folded.sort().join(",");
    }
    return o;
  }
  // The view's keys, in one place. Three readers used to keep their own copy of this
  // list — the URL writer, and the saved-view reader and comparer — so adding
  // `collapsed` to the writer alone meant a saved view committed the fold and then
  // stripped it on the way back in. A list that has to be right in three files is a
  // list that will be wrong in one.
  var VIEW_KEYS = ["view", "q", "group", "layout", "sort", "done", "empty", "collapsed"];
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
    var s = location.search.replace(/^\?/, "");
    if (!s) return;
    var got = {};
    s.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      got[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " "));
    });
    applyParams(got);
  }
  // Apply a view's params to the board. `reset` makes them authoritative (a saved
  // view is a complete description); the boot path leaves untouched keys alone
  // because there is nothing to reset yet.
  function applyParams(got, reset) {
    if (reset) {
      state.query = "";
      state.focus = "all";
      state.showDone = DISPLAY_DEFAULTS.showDone;
      state.showEmpty = DISPLAY_DEFAULTS.showEmpty;
      state.group = DISPLAY_DEFAULTS.group;
      state.view = DISPLAY_DEFAULTS.view;
      state.sort = DISPLAY_DEFAULTS.sort;
      state.collapsed.clear();
    }
    // A link's display choices win over the saved preferences, but aren't saved
    // themselves — someone else's view shouldn't quietly become yours.
    if (got.done === "1") state.showDone = true;
    if (got.empty === "0") state.showEmpty = false;
    if (got.collapsed != null) {
      state.collapsed.clear();
      got.collapsed.split(",").forEach(function (k) { if (k) state.collapsed.add(k); });
    }
    if (GROUPS[got.group]) state.group = got.group;
    if (got.layout === "list" || got.layout === "board") state.view = got.layout;
    if (SORTS.indexOf(got.sort) !== -1) state.sort = got.sort;
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
  function dateEl(date, cls) {
    var d = el("span", cls || "card-date", date);
    d.title = "Last updated";
    d.setAttribute("aria-label", "Last updated " + date);
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
    filter: ["M13.75 1.875 1.25 1.875l5 5.9125000000000005L6.25 11.875l2.5 1.25 0 -5.3374999999999995L13.75 1.875z"],
    edit: ["M6.875 2.5H2.5a1.25 1.25 0 0 0 -1.25 1.25v8.75a1.25 1.25 0 0 0 1.25 1.25h8.75a1.25 1.25 0 0 0 1.25 -1.25v-4.375", "M11.5625 1.5625a1.325625 1.325625 0 0 1 1.875 1.875L7.5 9.375l-2.5 0.625 0.625 -2.5 5.9375 -5.9375z"],
    // git-commit — a puck is a commit-like unit in git (our "project" glyph)
    commit: ["M5 7.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0 -5 0", "M0.65625 7.5 4.375 7.5", "m10.631250000000001 7.5 3.71875 0"],
    // An etapp is several pucks on one track — the commit mark, twice. It has to
    // differ from `commit` at 12px, which is why it is two dots and not a container
    // outline: at that size an outline is a smudge and a count of dots still reads.
    etapp: ["M3.125 7.5a1.5625 1.5625 0 1 0 3.125 0 1.5625 1.5625 0 1 0 -3.125 0",
            "M8.75 7.5a1.5625 1.5625 0 1 0 3.125 0 1.5625 1.5625 0 1 0 -3.125 0",
            "M0.9375 7.5 3.125 7.5", "M6.25 7.5 8.75 7.5", "M11.875 7.5 14.0625 7.5"],
    // git-merge — the Etapp brand mark: two stages meeting on one line
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

  // Rollup badge for a puck that *is* an etapp: how many of its children have
  // landed. Derived at harvest from the children's own statuses, so an etapp can't
  // claim progress its pucks don't have.
  function progressBadge(item) {
    var p = item.progress;
    var b = el("span", "rollup" + (p.done === p.total ? " full" : ""));
    // The proportion, as a fill behind the count — not instead of it.
    //
    // The finding this closes said the rollup was "a number where a shape would do",
    // and the puck deliberately waited for real etapps before choosing the shape. The
    // real ones have 1, 2, 3 and 5 parts, and at those sizes a ring is the *worse*
    // instrument: 0/1, 1/2 and 2/3 draw 0%, 50% and 67% while the reader's actual
    // question — how many are left — is "one" for all three. A ring earns its place
    // where the count stops meaning anything (37/120 → "about a third"), and nothing
    // on this board is close. So the count stays exact and the fill is what the
    // glance gets; it also degrades to any N, which a row of dots would not.
    b.style.setProperty("--frac", (p.total ? Math.round((p.done / p.total) * 100) : 0) + "%");
    // The puck mark, not the etapp mark: this badge counts *pucks*, and the etapp
    // it belongs to already wears its own mark beside the title. Carrying `etapp`
    // here put the same glyph on one card twice and had the count of two dots
    // standing in front of the number 5.
    b.appendChild(icon("commit"));
    b.appendChild(el("span", "rollup-n", p.done + "/" + p.total));
    b.title = "Etapp: " + p.done + " of " + p.total + " pucks done";
    b.setAttribute("aria-label", b.title);
    return b;
  }
  // Membership chip on a child card: which etapp this puck belongs to.
  // Membership, on a card. Clickable when the etapp is on the board: the crumb
  // already goes up and the members list goes down, but this — the one place the
  // relation is stated on the board itself — did nothing but repeat a name. On a
  // flat board a card and its etapp can be columns apart, so the tie has to be a
  // link or it is only a label.
  function etappChip(item) {
    var p = parentItem(item);
    var name = p ? p.title : item.parentRef;
    var c = el(p ? "button" : "span", "etapp-chip" + (p ? " etapp-link" : ""));
    if (p) c.type = "button";
    c.appendChild(icon("merge"));
    c.appendChild(el("span", "etapp-name", name));
    c.title = "Etapp: " + name;
    c.setAttribute("aria-label", c.title);
    if (p) {
      c.addEventListener("click", function (e) {
        e.stopPropagation(); // the card underneath opens *this* puck; the chip opens its etapp
        openModal(p);
      });
    }
    return c;
  }

  // The puck's identity mark: a git-commit glyph tinted with the repo colour —
  // like Linear's project icon, which is coloured by the project's identity (not
  // status). It's the single colour marker, so the meta shows just the repo name.
  // The identity mark, tinted with the repo. A puck that holds other pucks gets a
  // different one: an etapp was indistinguishable from a member on the board, and
  // "which of these is an etapp?" is the first question the board should answer
  // without being read.
  function puckGlyph(item) {
    var etapp = (item.children || []).length > 0;
    var g = el("span", "puck-glyph" + (etapp ? " is-etapp" : ""));
    g.style.color = item.repoColor;
    g.title = etapp ? "Etapp \u00b7 " + item.repoName : item.repoName;
    g.appendChild(icon(etapp ? "etapp" : "commit"));
    return g;
  }

  // A card is a compact summary; tapping it opens the full detail in a modal
  // (fullscreen on mobile) so long bodies don't blow up the column height.
  // Which date a card shows: the one the ordering is actually about. Sorting by
  // "Newest created" and then showing `updated` made the column look shuffled.
  function cardDateField() {
    if (state.sort === "target" || state.group === "target") return "target";
    return (state.sort === "created-desc" || state.sort === "created-asc") ? "created" : "updated";
  }
  // The date cell for a card/row: the field the view is about, rendered in that
  // field's own language. A puck with no target falls back to `updated` rather than
  // leaving a hole where the others have a date.
  function dateCell(item, cls) {
    var f = cardDateField();
    if (f === "target") return item.target ? targetEl(item.target, cls) : (item.updated ? dateEl(item.updated, cls) : null);
    return item[f] ? dateEl(item[f], cls) : null;
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
    var meta = el("div", "card-meta");
    var repo = el("span", "card-repo");
    repo.appendChild(document.createTextNode(item.repoName));
    meta.appendChild(repo);
    if (sig.length) meta.appendChild(warnBadge(sig));
    if (item.priority) meta.appendChild(priorityBadge(item.priority));
    if (item.agent) meta.appendChild(agentBadge(item.agent));
    if (item.progress) meta.appendChild(progressBadge(item));
    // Membership is worth showing everywhere except in the etapp columns, where the
    // column header already says it.
    if (item.parentRef && state.group !== "parent") meta.appendChild(etappChip(item));
    if ((item.blockedBy || []).length) meta.appendChild(blockBadge(item));
    if (item.owner) meta.appendChild(ownerEl(item.owner));
    var dc = dateCell(item);
    if (dc) meta.appendChild(dc);
    c.appendChild(meta);

    // Row 3: tags (static badges).
    if (item.tags.length || !item.native) {
      var tags = el("div", "card-tags");
      item.tags.forEach(function (t) { tags.appendChild(el("span", "tagpill", "#" + t)); });
      if (!item.native) tags.appendChild(el("span", "adapted-badge", "adapted"));
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
  function showDropLine(container, before) {
    var line = container.querySelector(".drop-line") || el("div", "drop-line");
    if (before) container.insertBefore(line, before);
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
      // Defer to the palette/help layers — their own Escape unwinds them first.
      if (e.key === "Escape" && !cmdkVisible() && !helpOpen()) closeModal();
    });
  }

  // ── detail: a side pane on desktop, a modal overlay on mobile ──
  var detailPane, detailContent, workEl, selectedId = null, currentDetailItem = null;
  function isWide() { return window.matchMedia("(min-width: 900px)").matches; }
  function paneRefs() {
    if (!detailPane) {
      detailPane = document.getElementById("detailPane");
      detailContent = document.getElementById("detailContent");
      workEl = document.getElementById("work");
    }
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
  var scrollLocks = 0, lockedY = 0;
  function lockScroll() {
    if (scrollLocks++) return;
    lockedY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.top = -lockedY + "px";
    document.body.classList.add("scroll-locked");
  }
  function unlockScroll() {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks) return;
    document.body.classList.remove("scroll-locked");
    document.body.style.top = "";
    void document.body.offsetHeight; // settle the layout before restoring, or the
    window.scrollTo(0, lockedY);     // scroll lands on a body that is still fixed
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
      if (!fromBody) { try { root.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ } }
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

  //   opts: { title, anchorWrap, cls, help, onClose, build(body, api) }
  //   → { close }
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
      if (opts.title) root.setAttribute("aria-label", opts.title);
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
      head.appendChild(el("h3", "sheet-title", opts.title || ""));
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
  // *another puck* (etapp, blockers). Those can't be typed from memory the way a
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
          // (etapp) carry one token, multi-value ones (blockers) carry several.
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
              var x = el("button", "token-x", "\u2715");
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
            if (!hits.length) list.appendChild(el("div", "fp-empty", q ? "No puck matches" : "Nothing to pick"));
            else if (hits.length > CAP) list.appendChild(el("div", "fp-empty", "\u2026and " + (hits.length - CAP) + " more \u2014 keep typing"));
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
      cls: "inputpop",
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

  // Pull a trailing issue number out of "42", "#42", or a full issue URL.
  function parseIssue(s) {
    var m = String(s).trim().match(/(\d+)\s*$/);
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
              var x = el("button", "token-x", "\u2715");
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
    // The etapp sits in the path, not only in a field far down the rail: a
    // breadcrumb is where a reader learns the shape of things, and it puts the
    // level above one tap away instead of a scroll.
    var up = parentItem(item);
    if (up) {
      crumb.appendChild(sep());
      var upLink = el("button", "crumb-back", up.title);
      upLink.type = "button";
      upLink.title = "Etapp: " + up.title;
      upLink.addEventListener("click", function () { openModal(up); });
      crumb.appendChild(upLink);
    }
    crumb.appendChild(sep());
    crumb.appendChild(el("span", "crumb-cur", item.repoName + " · " + item.slug));
    container.appendChild(crumb);

    // Puck glyph — Etapp's answer to Linear's project icon, tinted with the repo
    // (project) colour. The single colour marker on the page, and it makes the same
    // etapp/member distinction the cards do.
    var pic = el("div", "detail-icon");
    pic.style.color = item.repoColor;
    pic.appendChild(icon((item.children || []).length ? "etapp" : "commit"));
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

    // Etapp: the level above. One pointer up, so the row is a link + an edit —
    // there is no epic record to open, just another puck.
    if (editable || item.parentRef || item.parent) {
      // "Etapp" up and "Pucks" down were two unrelated nouns for the two ends of one
      // edge — a type name and a generic plural — so the row read as its own field
      // rather than as the other half of the pair below. One verb, two directions,
      // the way Blocked by / Blocks already reads. The word "etapp" stays where it
      // belongs: on the *value*, and in the board's Etapp grouping.
      gRel.rows.push(propRow("Part of", parentValue(item, editable), null, "etapp"));
    }

    // …and the level below. With members it becomes a section of its own further
    // down (a comma-separated line works for two pucks and collapses at eight);
    // without them the rail keeps one quiet control, so an etapp can be *started*
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

    // ── Contains: the etapp's members, as rows ──
    // The page where you *run* an etapp, not just read that it has one. Direct
    // members only — a sub-etapp shows its own count and answers for its subtree,
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
      // source repo can add from it to an etapp it could never edit itself.
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
    if ((m = rest.match(/(?:^|\s)(?:→|->)\s*(now|next|later|inbox|done)\s*$/i))) {
      var st = m[1].toLowerCase();
      var badge = el("span", "status-pill status-" + st, STATUS_LABEL[st] || st);
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
    detailPane.hidden = false;
    document.body.classList.add("viewing-puck");
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
    window.scrollTo(0, 0);
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
    closeDetail();
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
    if (detailPane) detailPane.hidden = true;
    highlightSelected();
  }

  // A table row — full-width, aligned columns (Name · Priority · Agent · Repo ·
  // Updated), Linear-style. Grid tracks are shared across rows so the columns
  // line up; on mobile the extra columns fold away (see styles.css). Tap → modal.
  function listRow(item) {
    var sig = signalMessages(item);
    var r = el("div", "list-row" + (sig.length ? " flagged" : "") + (item.id === selectedId ? " sel" : ""));
    r.setAttribute("data-id", item.id);
    r.style.setProperty("--repo", item.repoColor);
    r.title = item.repoName;
    r.appendChild(puckGlyph(item));

    // Name: title (truncates) + inline drift/blocked badges.
    var name = el("div", "list-name");
    name.appendChild(el("span", "list-title", item.title));
    if (sig.length) name.appendChild(warnBadge(sig));
    if (item.progress) name.appendChild(progressBadge(item));
    if (item.parentRef && state.group !== "parent") name.appendChild(etappChip(item));
    if ((item.blockedBy || []).length) name.appendChild(blockBadge(item));
    r.appendChild(name);

    // Priority · Agent · Repo · Updated — each its own aligned cell (empty cells
    // still hold their track so rows stay in register).
    var pri = el("div", "list-cell list-pri");
    if (item.priority) pri.appendChild(priorityBadge(item.priority));
    r.appendChild(pri);

    var ag = el("div", "list-cell list-agent");
    if (item.agent) ag.appendChild(agentBadge(item.agent));
    r.appendChild(ag);

    var rp = el("div", "list-cell list-repo");
    var dot = el("span", "repo-dot");
    dot.style.background = item.repoColor;
    rp.appendChild(dot);
    rp.appendChild(el("span", "repo-name", item.repoName));
    r.appendChild(rp);

    var dt = el("div", "list-cell list-dt");
    var ldc = dateCell(item, "list-date");
    if (ldc) dt.appendChild(ldc);
    r.appendChild(dt);

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
    // The etapp board: one column per etapp, plus the pucks that stand outside
    // every etapp. Same renderer again — the level above a puck is a grouping, not
    // a second card type, which is exactly why it costs one registry entry.
    parent: {
      label: "Etapp",
      field: "parent",
      keyOf: function (i) { return i.parentRef || NO_VALUE; },
      keys: function (items) {
        var order = {};
        DATA.items.forEach(function (it, i) { order[it.id] = i; }); // etapps in board order
        return presentKeys(items, this.keyOf, function (k) { return order[k] == null ? 1e9 : order[k]; });
      },
      labelOf: function (k) {
        if (k === NO_VALUE) return "No etapp";
        var p = itemById(k);
        return p ? p.title : k;
      },
      tint: function (k) {
        var p = k === NO_VALUE ? null : itemById(k);
        return p && p.repoColor;
      },
      write: function (item, k) { changeParent(item, k === NO_VALUE ? null : k); },
      // The etapp's own rollup in the column header — counted over all its pucks,
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
  // Grouping by a field the view has already fixed makes one group named after the
  // view — "INBOX 11" under a header that says "Inbox 11". Derived from the columns
  // the view can show rather than from the view's name, so a future single-status
  // view gets the same treatment without being listed anywhere.
  //
  // The *effective* group falls back; `state.group` keeps what you chose. Visiting
  // the inbox therefore doesn't overwrite the grouping you set elsewhere, and the
  // URL still carries the choice you made.
  function groupUsable(k) { return k !== "status" || columnsForFocus().length > 1; }
  function effectiveGroup() { return groupUsable(state.group) ? state.group : "repo"; }
  function activeGroup() { return GROUPS[effectiveGroup()] || GROUPS.status; }
  // "Manual" is the only ordering where a hand-placed position means anything —
  // every other mode derives it from a field (see sortComparator).
  function manualRank() { return state.sort === "default"; }

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
    var constrained = groupConstrained(g);
    return keys.filter(function (k) { return !constrained || byKey[k].length; })
      .map(function (k) { return { key: k, label: g.labelOf(k), items: byKey[k] }; });
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
      // The etapp grouping buckets on `parentRef` — the *resolved* link — while
      // `has:parent` asks whether the file says anything, and answers yes for a
      // `parent:` that resolves to nothing. Such a puck sits in "No etapp" and would
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
  // about in: its own field, the `has:` pair for its absence bucket, and (for etapps)
  // `is:member`, which is that bucket said in the grammar the column actually uses.
  function termAboutGroup(t, g) {
    if (!g.field) return false;
    if (t.field === "has") return t.values[0] === g.field;
    if (t.field === "is") return g.field === "parent" && t.values[0] === "member";
    return t.field === g.field && t.field !== "text";
  }
  function groupConstrained(g) {
    if (!g.field) return false;
    return parseQuery(state.query).some(function (t) { return termAboutGroup(t, g); });
  }

  // The tray, at the end of the board where the columns it holds would have been.
  // Board only: it is a *place* on the board ("these would be over here"), and a flat
  // list has no columns for it to be at the end of — there the chip row still says
  // what is filtered out.
  function renderHiddenTray(g, groups) {
    var hidden = hiddenColumns(g, groups);
    if (!hidden.length) return;
    var tray = el("div", "column hidden-cols");
    var head = el("div", "col-head");
    head.appendChild(el("h2", null, "Hidden"));
    head.appendChild(el("span", "count", String(hidden.length)));
    tray.appendChild(head);
    var list = el("div", "cards");
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
      b.addEventListener("click", function () { unhideColumn(g, h.key); });
      list.appendChild(b);
    });
    tray.appendChild(list);
    board.appendChild(tray);
  }

  // Which columns the *filter* took away, and how much is behind each. A hidden column
  // is otherwise invisible in the one place it matters — the board — and `Not Status:
  // Later ×` in the chip row says what is gone but never how much, which is the whole
  // question you ask before deciding to bring it back.
  //
  // Terms are stripped from `state.query` only, never from the view's own or a place's.
  // `-status:inbox` is what "All pucks" *means*, not something you hid; a repo place is
  // where you navigated. Dropping those too would list Inbox as hidden on every board.
  function hiddenColumns(g, shown) {
    if (!g.field || !groupConstrained(g)) return [];
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
    var here = {};
    shown.forEach(function (grp) { here[grp.key] = 1; });
    var count = {};
    would.forEach(function (it) { var k = g.keyOf(it); count[k] = (count[k] || 0) + 1; });
    return g.keys(would).filter(function (k) { return !here[k] && columnTerm(g, k); })
      .map(function (k) { return { key: k, label: g.labelOf(k), n: count[k] || 0 }; });
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
  function unhideColumn(g, key) {
    var t = columnTerm(g, key);
    if (!t) return;
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
      var vals = term.values.slice();
      var at = vals.map(lower).indexOf(lower(t.value));
      if (term.neg) { if (at >= 0) vals.splice(at, 1); }
      else if (at < 0) vals.push(t.value);
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
      goToPlace(g.field, key);
      return;
    }
    var rest = parseQuery(state.query).filter(function (term) { return !termAboutGroup(term, g); });
    rest.push({ field: t.field, op: t.field === "has" || t.field === "is" ? "is" : "in",
                values: [t.value], neg: !t.hideNeg });
    setQueryTerms(rest);
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
        cls: "pick-menu menu-right",
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
          row("eye-off", "Hide column", function () { toggleFilterValue(t.field, t.value, t.hideNeg); });
        },
      });
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function renderColumns(groups) {
    var g = activeGroup();
    groups.forEach(function (grp) {
      if (!grp.items.length && !state.showEmpty) return;
      var col = el("div", "column" + (g.cls ? " " + g.cls(grp.key) : " col-plain"));
      if (g.tint && g.tint(grp.key)) col.style.setProperty("--tint", g.tint(grp.key));
      var head = el("div", "col-head");
      head.appendChild(el("span", "swatch"));
      head.appendChild(el("h2", null, grp.label));
      head.appendChild(el("span", "count", String(grp.items.length)));
      if (g.headExtra) { var hx = g.headExtra(grp.key); if (hx) head.appendChild(hx); }
      // Only where the column can actually be named by a term — a target month
      // cannot, and offering a dead menu item is worse than offering none.
      if (columnTerm(g, grp.key)) head.appendChild(colMenu(g, grp.key, grp.label));
      col.appendChild(head);
      var cards = el("div", "cards");
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
        col.appendChild(add);
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
  }

  // Fold a group shut or open it. Display state, so it travels the same road as the
  // rest: into `state`, out through the URL, onto the board.
  function toggleGroup(key) {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    refreshDisplayDot();
    renderBoard();
  }
  function renderList(groups) {
    var g = activeGroup();
    groups.forEach(function (grp) {
      if (!grp.items.length) return; // a flat list has no drop targets, so no empty headers
      var section = el("section", "list-group" + (g.cls ? " " + g.cls(grp.key) : " col-plain"));
      if (g.tint && g.tint(grp.key)) section.style.setProperty("--tint", g.tint(grp.key));
      var shut = state.collapsed.has(grp.key);
      if (shut) section.classList.add("shut");
      var head = el("div", "list-head");
      // The heading stays a heading and the *button* goes inside it: `role="button"`
      // on the row would have made its contents presentational, and the list's group
      // headings would have dropped out of the heading map. The rollup badge stays
      // outside the button — it is the etapp's number, not part of the control.
      var h = el("h2");
      var toggle = el("button", "lh-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", shut ? "false" : "true");
      toggle.title = (shut ? "Expand " : "Collapse ") + grp.label;
      toggle.appendChild(icon(shut ? "chev-right" : "chev-down", "lh-caret"));
      toggle.appendChild(el("span", "swatch"));
      toggle.appendChild(el("span", "lh-label", grp.label));
      toggle.appendChild(el("span", "count", String(grp.items.length)));
      toggle.addEventListener("click", function () { toggleGroup(grp.key); });
      h.appendChild(toggle);
      head.appendChild(h);
      if (g.headExtra) { var hx = g.headExtra(grp.key); if (hx) head.appendChild(hx); }
      section.appendChild(head);
      if (!shut) grp.items.forEach(function (it) { section.appendChild(listRow(it)); });
      board.appendChild(section);
    });
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
    if (state.sort === "target") return byDate("target", 1); // nearest horizon first, undated last
    if (state.sort === "updated-desc") return byDate("updated", -1);
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
    board.classList.toggle("as-list", layout === "list");
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
    document.getElementById("footmeta").textContent =
      DATA.total + " pucks · generated " + DATA.generatedAt.slice(0, 16).replace("T", " ") + " UTC · ";
  }

  // Which status groups the current view shows. Inbox is its own space, so it's
  // absent from every board view except the Inbox view itself.
  function columnsForFocus() {
    if (state.focus === "inbox") return ["inbox"];
    if (state.focus === "ready") return ["now", "next"];
    if (state.focus === "attention") return DATA.statuses; // flagged can be any status
    // An etapp is any puck that holds others, so it can sit anywhere — including
    // inbox, which the committed board hides. Without this the sidebar counted one
    // and the board showed none, which is exactly the drift viewCounts exists to
    // prevent. Done still follows the toggle.
    if (state.focus === "etapps") {
      return DATA.statuses.filter(function (s) { return !TERMINAL[s] || state.showDone; });
    }
    // "all" = the committed board: now/next/later (+done/cancelled when shown), never inbox.
    return DATA.statuses.filter(function (s) {
      return s !== "inbox" && (!TERMINAL[s] || state.showDone);
    });
  }

  // The consistent view-header reflects the current focus + how many are shown.
  var VIEW_TITLES = {
    all: "All pucks", ready: "Ready to take", inbox: "Inbox",
    etapps: "Etapps", standalone: "Standalone", attention: "Needs attention",
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
  // The full view title, place scope included ("Inbox · Etapp") — the single
  // source for both the view header and the detail breadcrumb's back label, so a
  // place-scoped view reads the same whether or not a puck is open.
  function currentViewTitle() {
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
  // Archive-aware for the same reason the view counts are: `goToPlace()` keeps
  // `state.showDone`, so with the toggle on a repo click shows its landed cards
  // while the chip's number excluded them. A place counts what its click shows.
  // Siffran är vad klicket visar — och ett klick på ett repo behåller en aktiv
  // disciplinkö (goToPlace byter bara den dimension man klickade i). Så varje
  // dimension räknas *inuti* den andra: annars kunde ett repo säga 20 och landa på
  // de 3 som är routade till den valda disciplinen.
  function placeCounts() {
    var base = parseQuery(VIEWS.all).concat(state.showDone ? [] : [NOT_DONE]);
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
      chip.appendChild(el("span", "agent-arrow", "→"));
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
  // orthogonal, so "Backend, within Etapp" still composes — they are two fields, and
  // the query ANDs them for free. The same three behaviours the Set version had, said
  // as a term operation: the radio, the toggle-off, and the replace.
  function pickScope(field, key) {
    var vals = placeValues(field);
    var wasSole = vals.length === 1 && vals[0] === lower(key);
    var rest = parseQuery(state.query).filter(function (t) { return !sameField(t, field, false); });
    if (!wasSole) rest.push({ field: field, op: "in", values: [key], neg: false });
    setQueryTerms(rest);
  }
  // A place is active → the sidebar is "in" that place, not in a view.
  function placeActive() {
    return PLACE_FIELDS_ORDER.some(function (f) { return placeValues(f).length > 0; });
  }
  // Everything the query says about the places, dropped — what "go to a view" means.
  function clearPlaces() {
    return parseQuery(state.query).filter(function (t) {
      return t.neg || PLACE_FIELDS_ORDER.indexOf(t.field) === -1;
    });
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
    setQueryTerms(clearPlaces()); // the view is global, not still scoped to where you were
    refreshNav();
    renderBoard();
    maybeCloseMenu();
  }
  // Go to a place: single-select it and reset to its whole board (focus "all"), so a
  // place always shows the same thing regardless of the view you came from.
  function goToPlace(field, key) {
    closeSurfaces(); // same as goToView — the board changes under whatever is open
    exitPuckView();
    pickScope(field, key);
    state.focus = "all";
    refreshNav();
    renderBoard();
    maybeCloseMenu();
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
    // etapps were done. A number that jumps is explained by the switch you just
    // flipped; two different numbers for one view are never explained.
    Object.keys(VIEWS).forEach(function (k) {
      c[k] = 0;
      qs[k] = parseQuery(VIEWS[k]).concat(ARCHIVABLE[k] && !state.showDone ? [NOT_DONE] : []);
    });
    DATA.items.forEach(function (it) {
      Object.keys(qs).forEach(function (k) { if (runQuery(it, qs[k])) c[k]++; });
    });
    return c;
  }
  // The views, named once and read by both the sidebar and the ⌘K palette — a new
  // view can't now appear in one and be missing from the other, which is exactly
  // what happened to Etapps (a sidebar row with no command).
  var VIEW_DEFS = {
    // Only Inbox carries a glyph, and that is the point rather than an oversight:
    // it is the one row that is a *room* and not a slice of the board (see
    // VIEW_GROUPS), so it stands in its own section and wears the mark of one.
    // Giving all six an icon would say the opposite — that they are six of a kind.
    inbox: { label: "Inbox", icon: "inbox", title: "Raw ideas to triage — nothing here is a promise yet" },
    all: { label: "All pucks", title: "The committed board — now/next/later" },
    etapps: { label: "Etapps", title: "The pucks that hold other pucks — each with its rollup" },
    standalone: { label: "Standalone", title: "Pucks in no etapp — the loose ones" },
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
    { label: "Views", keys: ["all", "etapps", "standalone"] },
    { label: "Signals", keys: ["ready", "attention"] },
  ];
  // Which rows this board has earned — the sidebar is navigation, not a feature
  // list. Each row is gated on the thing it actually adds, not on hierarchy in
  // general: Etapps earns its place as soon as one exists (it may sit in the inbox,
  // which the committed board hides — the Etapps view is then the only way to see
  // it), while Standalone earns its place only when it *differs* from All pucks,
  // i.e. when at least one member is on the committed board. Gating both on
  // `counts.etapps` looked right and rendered "All pucks 31 / Standalone 31" — one
  // list under two names — because the only etapp we had was an inbox one.
  function viewsShown(counts) {
    return VIEW_GROUPS.map(function (g) {
      return {
        label: g.label,
        keys: g.keys.filter(function (k) {
          if (k === "etapps") return !!counts.etapps;
          if (k === "standalone") return counts.standalone !== counts.all;
          if (k === "attention") return !!counts.attention;
          return true;
        }),
      };
    }).filter(function (g) { return g.keys.length; });
  }
  function buildFocusControl() {
    var counts = viewCounts();
    // A view reads as active only when we're not inside a place — otherwise the
    // sidebar would highlight both "All pucks" and the repo you navigated into.
    var inPlace = placeActive();
    var host = document.getElementById("sideViews") || document.getElementById("filters");
    viewsShown(counts).forEach(function (g) {
      if (g.label) host.appendChild(el("div", "side-eyebrow", g.label));
      var seg = el("div", "focusseg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", g.label || "Inbox");
      g.keys.forEach(function (key) {
        var d = VIEW_DEFS[key];
        var on = state.focus === key && !inPlace;
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
  // palette without Etapps, and "All pucks 31 / Standalone 31".
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
            var counts = viewCounts(), inPlace = placeActive();
            viewsShown(counts).forEach(function (g, gi) {
              if (gi) host.appendChild(el("div", "menu-rule"));
              g.keys.forEach(function (key) {
                var on = state.focus === key && !inPlace;
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
              var now = viewParamObject();
              saved.forEach(function (v) {
                var on = sameParams(paramsOf(v), now);
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
  function toggleTheme() {
    var next = effectiveIsDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("roadmap-theme", next); } catch (e) {}
    applyThemeColor();
    updateThemeButton();
  }
  themeBtn.addEventListener("click", function () { toggleTheme(); themeBtn.blur(); });
  // Follow the system scheme while on "auto" (no explicit toggle yet).
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      applyThemeColor();
      updateThemeButton();
    });
  }
  applyThemeColor();
  updateThemeButton();

  // ── Display: layout · grouping · ordering · what's included wholesale ────────
  // One menu for *how* the chosen pucks are presented, so a new display option is
  // a row here instead of another button in the header. Filter stays next door and
  // answers *which* pucks — the two never overlap. Filter shows what it's doing
  // with chips/a count; Display shows a dot when anything differs from default,
  // because "showing more" must never read as "you have narrowed something".
  var SORT_LABEL = {
    default: "Manual", "updated-desc": "Recently updated", priority: "Priority (high→low)",
    target: "Target (soonest)",
    "updated-asc": "Oldest updated", "created-desc": "Newest created",
    "created-asc": "Oldest created", title: "Title A–Z",
  };
  var DISPLAY_DEFAULTS = { view: "board", sort: "default", group: "status", showDone: false, showEmpty: true };
  if (!GROUPS[state.group]) state.group = DISPLAY_DEFAULTS.group; // a stale saved value
  var displayBtn = document.getElementById("displayBtn");
  var displayDot = document.getElementById("displayDot");
  function displayDirty() {
    for (var k in DISPLAY_DEFAULTS) if (state[k] !== DISPLAY_DEFAULTS[k]) return true;
    // A folded group is a display change like any other, so the dot has to see it —
    // otherwise "Reset to default" would change something the dot said was default.
    return state.view === "list" && state.collapsed.size > 0;
  }
  function refreshDisplayDot() { if (displayDot) displayDot.hidden = !displayDirty(); }
  function setDisplay(key, value, storeAs) {
    // A fold belongs to the columns it was folded in. Changing the grouping replaces
    // every column, so carrying the keys over means folding a group nobody touched —
    // and the "none" bucket is keyed the same (NO_VALUE) under Agent, Target, Etapp
    // and Priority, so collapsing "Unrouted" would silently collapse "No priority".
    if (key === "group" && value !== state.group) state.collapsed.clear();
    state[key] = value;
    saveDisplay(storeAs || key, typeof value === "boolean" ? (value ? "1" : "0") : value);
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
        return Object.keys(GROUPS).filter(groupUsable).map(function (k) {
          return { value: k, label: GROUPS[k].label };
        });
      } },
    { key: "sort", label: "Ordering",
      current: function () { return state.sort; },
      options: function () {
        return SORTS.map(function (s) { return { value: s, label: SORT_LABEL[s] || s }; });
      } },
  ];
  function displayLabel(f) {
    var cur = f.current(), hit = null;
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
    var seg = segmented(
      [["list", "List", "list"], ["board", "Board", "grid"]],
      state.view,
      function (v) {
        setDisplay("view", v);
        paintWholesale(); // the empty-columns row is board-only
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
      if (ARCHIVABLE[state.focus]) rows.push(["showDone", "done", "Show done & cancelled", null]);
      if (state.view === "board") {
        rows.push(["showEmpty", "empty", "Show empty columns", "An empty column is still a drop target."]);
      }
      if (!rows.length) return;
      wholeHost.appendChild(el("div", "dp-rule"));
      rows.forEach(function (w) {
        var row = el("label", "fp-toggle");
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = state[w[0]];
        cb.addEventListener("change", function () { setDisplay(w[0], cb.checked, w[1]); });
        row.appendChild(cb); row.appendChild(el("span", null, w[2]));
        if (w[3]) row.title = w[3];
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
      for (var k in DISPLAY_DEFAULTS) state[k] = DISPLAY_DEFAULTS[k];
      state.collapsed.clear();
      saveDisplay("view", state.view); saveDisplay("sort", state.sort); saveDisplay("group", state.group);
      saveDisplay("done", "0"); saveDisplay("empty", "1");
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
    pop.innerHTML = "";
    var back = el("button", "fp-back");
    back.type = "button";
    back.appendChild(icon("chev-left", "fp-chev"));
    back.appendChild(el("span", null, f.label));
    back.addEventListener("click", function () { renderDisplayRoot(pop); });
    pop.appendChild(back);

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
    // Display options belong in the palette too — the palette is the extensibility
    // surface, so a new display choice never has to become another button.
    Object.keys(GROUPS).filter(groupUsable).forEach(function (k) {
      if (k === effectiveGroup()) return;
      cmds.push({ __cmd: true, label: "Group by " + GROUPS[k].label.toLowerCase(), hint: "Display", icon: "sliders", run: function () { setDisplay("group", k); } });
    });
    cmds.push({ __cmd: true, label: state.view === "list" ? "Layout: board" : "Layout: list", hint: "Display", icon: state.view === "list" ? "grid" : "list", run: function () { setDisplay("view", state.view === "list" ? "board" : "list"); } });
    cmds.push({ __cmd: true, label: "Settings", hint: "Workspace", icon: "sliders", run: function () { openSettingsPanel(); } });
    cmds.push({ __cmd: true, label: "Keyboard shortcuts", hint: "Help", icon: "list", run: function () { toggleShortcutHelp(); } });
    cmds.push({ __cmd: true, label: effectiveIsDark() ? "Switch to light" : "Switch to dark", hint: "Theme", icon: effectiveIsDark() ? "sun" : "moon", run: function () { toggleTheme(); } });
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
        li.appendChild(el("span", "status-pill status-" + it.status, STATUS_LABEL[it.status] || it.status));
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
      var want = { a: "all", r: "ready", i: "inbox", e: "etapps", s: "standalone", t: "attention" }[k];
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
    { keys: ["G", "then", "E"], desc: "Go to Etapps" },
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
    var x = el("button", "sc-close", "✕"); x.type = "button";
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
      // Etapp: a real field (unlike repo/agent, which are places), so it filters
      // here. Only pucks that actually *are* etapps are offered — a value that
      // matches nothing would be a trap.
      key: "parent", label: "Etapp", search: "Filter etapps…",
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
    {
      // Derived states — not fields, so they share the `is:` namespace.
      key: "is", label: "State",
      values: function () {
        return [
          { value: "ready", label: "Ready" },
          { value: "blocked", label: "Blocked" },
          { value: "blocking", label: "Blocking others" },
          { value: "flagged", label: "Needs attention" },
          { value: "stale", label: "Stale" },
          { value: "adapted", label: "Adapted source" },
          { value: "etapp", label: "Is an etapp" },
          { value: "member", label: "In an etapp" },
          { value: "standalone", label: "In no etapp" },
        ];
      },
    },
  ];
  // Can this value match anything at all in this view? One that can't is a trap: it
  // commits, the board empties, and nothing says why. In Inbox that was every status
  // but `inbox`, plus `is:ready` and `is:done`. The Etapp field already followed this
  // rule inside its own `values()` — this makes it the panel's rule instead of one
  // field's.
  //
  // Judged against the *view*, never against the filters already set, so ticking one
  // box never makes other values vanish from under your hand. (`countFor` answers a
  // different question — how many pucks the click would leave — and models the
  // toggle, so it stays non-zero for a value that matches nothing.) An active value
  // always survives, or there would be no way to un-tick it.
  function valueReachable(field, value) {
    var probe = viewTerms();
    probe.push(field === "is"
      ? { field: "is", op: "is", values: [value], neg: false }
      : { field: field, op: "in", values: [value], neg: false });
    for (var i = 0; i < DATA.items.length; i++) if (runQuery(DATA.items[i], probe)) return true;
    return false;
  }
  function reachableValues(f) {
    var active = filterValues(f.key, false).concat(filterValues(f.key, true));
    return f.values().filter(function (v) {
      return active.indexOf(v.value) !== -1 || valueReachable(f.key, v.value);
    });
  }
  function fieldByKey(k) {
    for (var i = 0; i < FILTER_FIELDS.length; i++) if (FILTER_FIELDS[i].key === k) return FILTER_FIELDS[i];
    return null;
  }
  // How many pucks each candidate value would leave — counted against the *other*
  // active terms, so the numbers describe the click you're about to make.
  function countFor(field, value) {
    var base = activeTerms().filter(function (t) { return !sameField(t, field, false); });
    // Model the toggle, not the value: with `status:now` on, clicking Next gives
    // `status:now,next` (an OR — a *bigger* set), and clicking Now removes the
    // filter entirely. Counting the candidate alone would predict neither.
    var current = filterValues(field, false);
    var next = current.indexOf(value) === -1
      ? current.concat([value])
      : current.filter(function (v) { return v !== value; });
    var probe = base.slice();
    if (next.length) {
      if (field === "is") {
        next.forEach(function (v) { probe.push({ field: "is", op: "is", values: [v], neg: false }); });
      } else {
        probe.push({ field: field, op: "in", values: next, neg: false });
      }
    }
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
    pop.appendChild(el("div", "fp-label", "Add filter"));
    FILTER_FIELDS.forEach(function (f) {
      if (!reachableValues(f).length) return; // nothing here could change this view
      var row = el("button", "fp-row");
      row.type = "button";
      row.appendChild(el("span", null, f.label));
      var on = filterValues(f.key, false).length;
      if (on) row.appendChild(el("span", "fp-n", String(on)));
      row.appendChild(icon("chev-right", "fp-chev"));
      row.addEventListener("click", function () { renderValueList(pop, f); });
      pop.appendChild(row);
    });
  }
  function renderValueList(pop, f) {
    pop.innerHTML = "";
    var back = el("button", "fp-back");
    back.type = "button";
    back.appendChild(icon("chev-left", "fp-chev"));
    back.appendChild(el("span", null, f.label));
    back.addEventListener("click", function () { renderFieldList(pop); });
    pop.appendChild(back);

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
      var active = filterValues(f.key, false);
      var q = searchBox ? searchBox.value.trim().toLowerCase() : "";
      var matches = all.filter(function (v) { return !q || v.value.indexOf(q) !== -1; });
      var collapsed = !q && !expanded && matches.length > CAP;
      (collapsed ? matches.slice(0, CAP) : matches).forEach(function (v) {
        var isOn = active.indexOf(v.value) !== -1;
        var row = el("label", "fp-val" + (isOn ? " on" : ""));
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = isOn;
        cb.addEventListener("change", function () { toggleFilterValue(f.key, v.value, false); paint(); });
        row.appendChild(cb);
        row.appendChild(el("span", "fp-vlabel", v.label));
        row.appendChild(el("span", "fp-n", String(countFor(f.key, v.value))));
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
    return o;
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
    refreshNav();
    renderBoard();
    maybeCloseMenu();
  }
  function buildSavedViews() {
    var host = document.getElementById("savedViews");
    var section = document.getElementById("savedSection");
    if (!host || !section) return;
    var views = savedViews();
    section.hidden = !views.length;
    host.innerHTML = "";
    if (!views.length) return;
    var now = viewParamObject();
    var seg = el("div", "focusseg");
    views.forEach(function (v) {
      var on = sameParams(paramsOf(v), now);
      var b = el("button", "focusbtn" + (on ? " on" : ""));
      b.type = "button";
      b.title = v.q || "Saved view";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.appendChild(el("span", "focus-label", v.name));
      b.addEventListener("click", function () { applySavedView(v); });
      if (ghToken()) {
        var del = el("button", "saved-del", "✕");
        del.type = "button";
        del.title = "Remove this saved view";
        del.setAttribute("aria-label", "Remove saved view " + v.name);
        del.addEventListener("click", function (e) { e.stopPropagation(); removeSavedView(v); });
        b.appendChild(del);
      }
      seg.appendChild(b);
    });
    host.appendChild(seg);
  }
  // Both writes go through the same helper: read the config, change `views`, commit.
  function writeViews(views, message, done) {
    var repo = aggregatorRepo();
    if (!repo) { toast("✗ No aggregator repo configured", true); return; }
    toast("Saving…");
    commitViews(repo, views, message)
      .then(function () {
        DATA.config = DATA.config || {};
        DATA.config.views = views; // optimistic: the harvest will confirm it
        buildSavedViews();
        if (done) done();
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
  function saveCurrentView(wrap) {
    var params = viewParamObject();
    if (!Object.keys(params).length) { toast("✗ Nothing to save — this is the default board", true); return; }
    inputSurface(wrap || null, {
      title: "Save view",
      placeholder: "Name this view",
      hint: "Saved to board.config.json as a commit — it joins the list behind the title.",
      action: "Save",
      onSave: function (name) {
        name = String(name).trim();
        if (!name) return;
        var views = savedViews().filter(function (v) { return v.name !== name; }); // same name = replace
        var entry = { name: name };
        for (var k in params) entry[k] = params[k];
        views.push(entry);
        writeViews(views, "roadmap: save view “" + name + "”");
      },
    });
  }
  function removeSavedView(v) {
    if (!window.confirm("Remove the saved view “" + v.name + "”?")) return;
    writeViews(savedViews().filter(function (x) { return x !== v; }), "roadmap: remove view “" + v.name + "”");
  }

  // ── the chip row ────────────────────────────────────────────────────────────
  // Every active predicate, visible and individually removable — the filter's own
  // display, so the Filter button needs no count and "showing more" can never read
  // as "you have narrowed something".
  var chipRow = document.getElementById("chipRow");
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
      var f = fieldByKey(t.field);
      var label;
      if (t.field === "text") label = "“" + t.values[0] + "”";
      else if (t.field === "is") label = (t.neg ? "Not " : "") + t.values[0];
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
    chipRow.hidden = !chips.length;
    if (!chips.length) return;
    chips.forEach(function (c) {
      var chip = el("span", "fchip");
      chip.appendChild(el("span", "fchip-label", c.label));
      var x = el("button", "fchip-x", "✕");
      x.type = "button";
      x.setAttribute("aria-label", "Remove filter " + c.label);
      x.addEventListener("click", function () { c.remove(); });
      chip.appendChild(x);
      chipRow.appendChild(chip);
    });
    if (chips.length > 1) {
      var clear = el("button", "fchip-clear", "Clear all");
      clear.type = "button";
      clear.addEventListener("click", function () {
        setQueryTerms([]); // one store, so "put everything back" is one line
        refreshNav();
      });
      chipRow.appendChild(clear);
    }
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
  if (CFG.ribbon) {
    var ribbon = el(CFG.ribbonHref ? "a" : "div", "demo-ribbon");
    ribbon.innerHTML = renderMd(CFG.ribbon).replace(/^<p>|<\/p>\s*$/g, "");
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
  var TOKEN_KEY = "roadmap-gh-token";
  function ghToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setGhToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
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
  function canWrite(item) {
    // == null also catches `undefined` — card() calls this during the first render,
    // before writableRepos/readOnlyRepos are assigned (they mean "not checked yet").
    return (writableRepos == null || writableRepos.has(item.repo)) && !(readOnlyRepos && readOnlyRepos.has(item.repo));
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
    // rank, so it owes the same derivation the picker's path does — the etapp's
    // rollup and the puck's own flags. Routing only `changeStatus` left a dragged
    // etapp with a stale `N/M` and a `rollup-*` warning until the next harvest.
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
      recountEtapp(item.parentRef);
      syncRollupSignals(item);
      // Bägge ändarna, som i changeParent: härledningen uppdaterar etappens objekt,
      // men bara den puck vi skickar med målas om — och etappen är precis lika
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
  // navigation (counts move when a puck changes status or etapp), and the open puck
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
    recountEtapp(item.parentRef); // the etapp's rollup follows its pucks
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
        recountEtapp(item.parentRef);
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

  // ── etapp (`parent`) ────────────────────────────────────────────────────────
  // The level above a puck is one frontmatter line pointing *up*; `children` and
  // `progress` are derived at harvest. So the write is a single field on a single
  // file — no epic record to keep in sync, and dragging a card between etapp
  // columns is the same one-file commit a status flip is.

  // Would this link close a loop? Walk up from the proposed parent; meeting the
  // puck itself means the etapp would contain its own ancestor. The harvester cuts
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
  // Recount one etapp from its children's current statuses. The board mutates
  // status optimistically, so the rollup has to follow locally or an etapp would
  // read stale until the next harvest.
  function recountEtapp(id) {
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
  // `rollup-done` warning and marking the etapp done left the warning standing and
  // the etapp sitting in Needs attention until the harvest caught up.
  //
  // The rule is stated twice (here and in harvest.mjs), which is the same trade
  // `relink`/`recountEtapp` already make for `children`/`progress`: an optimistic
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
  // Move a puck between etapps locally (the same derivation the harvester does).
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
    recountEtapp(old);
    recountEtapp(parentId);
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
        var x = el("button", "dep-x", "✕");
        x.type = "button";
        x.setAttribute("aria-label", "Remove blocker " + (d ? d.title : ref));
        x.addEventListener("click", function () { removeDepend(item, ref); });
        chip.appendChild(x);
      }
      wrap.appendChild(chip);
    });
    // "Nothing" next to "Add" is the same empty-value-plus-link pair the Target and
    // Etapp rows had: the button already says what the row is for.
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
      }));
    }
    return wrap;
  }

  function commitParent(item, raw) {
    return commitFields(item, { parent: raw },
      "roadmap: " + item.slug + (raw ? " → etapp " + raw : " out of its etapp"));
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
    if (parentId === item.id) { toast("✗ A puck can’t be its own etapp", true); return; }
    if (wouldLoop(item, parentId)) { toast("✗ That would make an etapp loop", true); return; }
    var raw = target ? refFor(item, target) : null;
    var prevRef = item.parentRef, prevRaw = item.parent, prevU = item.updated;
    relink(item, parentId, raw);
    item.updated = today();
    // Both ends changed, and the etapp is as likely to be the page you're on: adding
    // from `＋ Add puck` writes the *child*, so refreshing only that left the
    // Contains list and its rollup stale on the etapp you were looking at.
    afterEdit(item, prevRef, parentId);
    toast("Saving…");
    commitParent(item, raw)
      .then(function () { toast(raw ? "✓ In etapp " + target.title + " — live in ~1 min" : "✓ Out of its etapp — live in ~1 min"); })
      .catch(function (err) {
        relink(item, prevRef, prevRaw);
        item.updated = prevU;
        noteWriteError(item, err);
        afterEdit(item, prevRef, parentId);
        toast("✗ " + err.message, true);
      });
  }
  // Which pucks could be this one's etapp: anything but itself and its own
  // descendants (that would close a loop). Excluded up front, so the loop refusal
  // in changeParent() is a backstop rather than something you meet by clicking.
  // A member of an etapp, as a row: the status it is in, its title, and its own
  // rollup when it is an etapp too.
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
    r.appendChild(el("span", "status-pill status-" + k.status, STATUS_LABEL[k.status] || k.status));
    r.title = STATUS_LABEL[k.status] || k.status;
    r.addEventListener("click", function () { openModal(k); });
    return r;
  }

  // The relation is authored on the *child* (`parent:`), so adding from here is
  // the same single-field write with the arguments swapped — no second direction
  // in the data, just one in the interface.
  // Who could join this etapp: a native puck that isn't already in it, isn't itself,
  // and wouldn't close a loop — and whose *own* file we can write, because that is
  // the file this writes. One predicate, asked twice: once to decide whether to
  // offer the control at all, once to fill it.
  function memberCandidate(item, other) {
    return other !== item && other.parentRef !== item.id && other.native &&
      canWrite(other) && !wouldLoop(other, item.id);
  }
  function canAddMember(item) {
    if (!ghToken()) return false;
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
    });
  }

  function etappCandidates(item) {
    return function (other) { return other === item || wouldLoop(item, other.id); };
  }

  // The Etapp cell in the rail: a link to the etapp when set, plus an edit
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
      wrap.appendChild(puckPicker(item.parent ? "\u22ef" : "Set etapp", {
        repo: item.repo,
        title: "Etapp",
        help: "https://github.com/tor2dbear/roadmap/blob/main/CONVENTION.md#the-level-above-parent",
        current: item.parentRef,
        exclude: etappCandidates(item),
        placeholder: "Find an etapp…",
        // One token: the etapp this puck sits in. Its ✕ takes it out, which is why
        // the list needs no separate "No etapp" row any more.
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
        // Ur etappen först, sen ur listan: annars stod föräldern kvar med ett barn
        // som inte finns, fel `progress` och en `rollup-open`-varning om delar som
        // inte längre är öppna — ända till nästa skörd.
        var parent = item.parentRef;
        relink(item, null, null);
        var i = DATA.items.indexOf(item);
        if (i >= 0) DATA.items.splice(i, 1);
        if (parent) { recountEtapp(parent); syncRollupSignals(itemById(parent)); }
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
    ta.focus();
    setTimeout(autoGrow, 0);
    function restore(md) { bodyEl.innerHTML = renderMd(md || "(no details)"); editBtn.style.display = ""; }
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
  function toast(msg, isErr) {
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
  function puckTemplate(title, status, tags, agent, context) {
    var t = /[:#]/.test(title) ? JSON.stringify(title) : title;
    var lines = ["---", "title: " + t, "status: " + status];
    if (tags.length) lines.push("tags: [" + tags.join(", ") + "]");
    if (agent) lines.push("agent: " + agent);
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
  function createPuck(repo, title, status, tags, agent, context) {
    var slug = slugify(title);
    var short = repo.split("/").pop();
    var id = short + "/" + slug;
    if (DATA.items.some(function (x) { return x.id === id; })) { toast('✗ A puck "' + slug + '" already exists here', true); return; }
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
    DATA.items.push(item); DATA.total += 1;
    renderBoard(); buildAgentChips(); openModal(item);
    toast("Creating…");
    commitCreate(repo, path, meta.branch, puckTemplate(title, status, tags, agent, context), "roadmap: add " + slug)
      .then(function () { toast("✓ Created — live in ~1 min"); })
      .catch(function (err) {
        noteWriteError({ repo: repo }, err);
        var i = DATA.items.indexOf(item); if (i >= 0) DATA.items.splice(i, 1);
        DATA.total -= 1; renderBoard(); buildAgentChips(); closeModal();
        toast("✗ " + err.message, true);
      });
  }

  // ＋ new-puck control (sidebar foot).
  var newBtns = [], userEl;
  function refreshEditControls() {
    newBtns.forEach(function (b) { b.hidden = !ghToken(); });
  }
  function afterAuth() { writableRepos = null; readOnlyRepos = new Set(); refreshEditControls(); refreshUser(); loadWritableRepos(); }
  function buildEditControls() {
    // New: primary create action in the sidebar (desktop) + the mobile topbar
    // (next to search, so it's reachable without opening the menu). Token-gated.
    newBtns = ["sideNew", "topNew"].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    newBtns.forEach(function (b) {
      b.hidden = !ghToken();
      b.addEventListener("click", openNewPuckPanel);
    });
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
          if (u && u.login) {
            name.textContent = "@" + u.login;
            var img = document.createElement("img");
            img.className = "user-av-img"; img.alt = ""; img.src = u.avatar_url;
            av.appendChild(img);
          } else { name.textContent = "token invalid"; head.classList.add("bad"); }
        })
        .catch(function () { name.textContent = "signed in"; });
      var change = el("button", "row user-mi", "Change token");
      change.type = "button";
      change.addEventListener("click", function () { menu.remove(); openTokenPanel(afterAuth); });
      var out = el("button", "row user-mi danger", "Sign out");
      out.type = "button";
      out.addEventListener("click", function () { menu.remove(); setGhToken(""); afterAuth(); });
      menu.appendChild(change);
      menu.appendChild(out);
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
      "Paste a GitHub fine-grained token with Contents: write on your roadmap repo(s). It’s stored only in this browser and used to commit edits straight to GitHub. Add Issues: write too for one-click “New issue” (optional — without it, that falls back to opening GitHub)."));
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
      function (v) {
        if (v === "auto") { root.removeAttribute("data-theme"); try { localStorage.removeItem("roadmap-theme"); } catch (e) {} }
        else { root.setAttribute("data-theme", v); try { localStorage.setItem("roadmap-theme", v); } catch (e) {} }
        applyThemeColor(); updateThemeButton();
      });
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
      ? "Writes board.config.json in " + repo + " — live after the next sync."
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
  if (detailCloseBtn) detailCloseBtn.addEventListener("click", closeModal);
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
})();
