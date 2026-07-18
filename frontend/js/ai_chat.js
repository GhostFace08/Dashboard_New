/**
 * ai_chat.js — AI Chat page logic
 *
 * Change 5: initHeader() is now a no-op when this page runs inside the SPA
 *   shell iframe (window !== top).  The call is kept so the page still works
 *   when opened directly in development (standalone mode).
 *
 * Change 6: Session persistence within a browser session.
 *   Problem:  Before the SPA shell, navigating away from AI Chat and back
 *   caused a full page reload, wiping the in-memory sessions array and
 *   activeId.  With the shell the iframe is never destroyed, so sessions
 *   already survive tab switches at the JS-variable level.
 *   Addition:  lastMessagedSessionId tracks the session the user most
 *   recently *sent a message in*.  onTabActivated() — called by the shell
 *   each time this tab becomes visible — restores activeId to that session
 *   (if it still exists), ensuring the user lands back in the right chat
 *   even if some other code path (e.g. createNewSession called from outside)
 *   changed activeId while the tab was hidden.
 *
 * Change 7: Table + chart rendering.
 *   RAG responses may contain standard markdown pipe tables and/or a
 *   ```viz fenced JSON block (charts/scorecards). Both are left as raw
 *   text during streaming (same as any other markdown) and are only
 *   converted to real <table> elements / mounted Chart.js canvases in a
 *   single final pass once the message is fully received
 *   (msg.streamComplete === true). This avoids ever parsing partial JSON
 *   or a half-closed table mid-stream.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 *   Chart.js   → window.Chart (vendored, loaded in ai_chat.html — see Phase 13)
 */

(function (global) {
  "use strict";

  /* ─── Guard ─────────────────────────────────────────────────────────────── */
  if (!global.CFG) { console.error("[ai_chat] CFG missing — load config.js first"); return; }
  if (!global.API) { console.error("[ai_chat] API missing — load api.js first");    return; }

  /* ─── Constants ──────────────────────────────────────────────────────────── */
  const FALLBACK_REPLY = CFG.CHAT_FALLBACK_REPLY || "Backend unavailable.";

  /* ─── State ──────────────────────────────────────────────────────────────── */
  let sessions  = (CFG.SEED_CHAT_SESSIONS || []).map(s => ({
    ...s,
    messages: s.messages.map(m => ({ ...m })),
  }));
  let activeId       = null;
  let pendingFiles   = [];
  let isSending      = false;
  let openMenuId     = null;
  let editingId      = null;  // id of the user message currently being edited (Phase 7)

  /*
   * Change 8 (Phase 6) — in-flight stream tracking for the Stop button.
   * currentAbortHandle: the { abort() } handle returned by API.postChat(),
   *   used to actually cancel the fetch/SSE connection.
   * currentStreamResolve: the resolve() function of the Promise sendMessage()
   *   is awaiting — calling it directly lets stopStreaming() unblock
   *   sendMessage() immediately, since an aborted fetch never fires
   *   postChat's onDone/onError callbacks.
   * currentStreamMsg: the assistant message object currently being streamed
   *   into, so stopStreaming() can mark it terminated in place.
   */
  let currentAbortHandle   = null;
  let currentStreamResolve = null;
  let currentStreamMsg     = null;

  /*
   * Change 6 — lastMessagedSessionId
   *
   * Set to the session id each time sendMessage() successfully appends the
   * user's message to a session (before the API call completes).  This means
   * it always reflects where the user was actively chatting.
   *
   * onTabActivated() (below) uses it to restore activeId when the shell
   * brings this tab back into view.
   */
  let lastMessagedSessionId = null;

  /* ─── Tiny helpers ───────────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  function nowTs() {
    return new Date().toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }

  function uid() { return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

  function getSession(id) { return sessions.find(s => s.id === id) || null; }

  function sortedSessions() {
    return [...sessions].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        return (b.pinnedAt || b.createdAt) - (a.pinnedAt || a.createdAt);
      }
      return b.createdAt - a.createdAt;
    });
  }

  /* ─── Markdown-lite renderer (safe to call on partial/streaming text) ───── */
  function inlineMarkdown(line) {
    return line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderMarkdown(text) {
    const lines = text.split("\n");
    let html = "";
    let inList = false;

    const closeList = () => {
      if (inList) { html += "</ul>"; inList = false; }
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");

      if (!line.trim()) {
        closeList();
        html += `<div style="height:8px"></div>`;
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        closeList();
        const level = headingMatch[1].length;
        html += `<h${level} class="aic-md-heading">${inlineMarkdown(headingMatch[2])}</h${level}>`;
        continue;
      }

      const listMatch = line.match(/^[-*]\s+(.*)$/);
      if (listMatch) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${inlineMarkdown(listMatch[1])}</li>`;
        continue;
      }

      closeList();
      html += `<p>${inlineMarkdown(line)}</p>`;
    }

    closeList();
    return html;
  }

  /* ─── Table + Chart rendering (FINAL PASS ONLY — never mid-stream) ───────
   * These are only ever invoked once a message's streamComplete flag is
   * true. Partial/incomplete ```viz JSON or half-open markdown tables are
   * never parsed — during streaming the raw text just renders as plain
   * markdown via renderMarkdown() above, same as any other in-progress text.
   * ────────────────────────────────────────────────────────────────────── */

  function markdownTableToHTML(block) {
    const lines = block.trim().split("\n");
    const header = lines[0].split("|").slice(1, -1).map(s => s.trim());
    const rows = lines.slice(2)
      .filter(l => l.trim())
      .map(line => line.split("|").slice(1, -1).map(s => s.trim()));

    let html = '<table class="aic-table"><thead><tr>';
    html += header.map(h => `<th>${escHtml(h)}</th>`).join("");
    html += "</tr></thead><tbody>";
    rows.forEach(r => {
      html += "<tr>" + r.map(c => `<td>${escHtml(c)}</td>`).join("") + "</tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  const TABLE_RE = /(^\|.+\|\s*\n\|[\s:\-|]+\|\s*\n(?:\|.*\|\s*\n?)*)/gm;
  const VIZ_RE   = /```viz\s*([\s\S]*?)```/g;

  /**
   * Full markdown render for a COMPLETE message: headings/lists/bold (via
   * the existing renderMarkdown) plus real <table> elements and
   * chart/scorecard placeholder divs. Never called on partial/streaming
   * text — only once streamComplete is true.
   *
   * Returns { html, vizSpecs } — vizSpecs must be mounted separately with
   * mountVizCharts() AFTER the returned html has actually been inserted
   * into the DOM (the placeholder divs must exist before Chart.js can
   * attach canvases to them).
   */
  function renderMarkdownFinal(rawText, msgId) {
    let text = rawText;
    const tokens = [];
    const vizSpecs = [];

    // Pull out ```viz blocks first and replace with placeholder tokens.
    text = text.replace(VIZ_RE, (match, jsonStr) => {
      try {
        const spec = JSON.parse(jsonStr.trim());
        const id = `aic-viz-${msgId}-${vizSpecs.length}`;
        vizSpecs.push({ id, spec });
        const token = `%%AICTOKEN${tokens.length}%%`;
        tokens.push(`<div class="aic-viz-block" id="${id}"></div>`);
        return `\n${token}\n`;
      } catch (e) {
        console.warn("[ai_chat] Invalid viz JSON, leaving as code block:", e);
        return match;
      }
    });

    // Pull out markdown pipe tables and replace with placeholder tokens.
    text = text.replace(TABLE_RE, (tableBlock) => {
      const token = `%%AICTOKEN${tokens.length}%%`;
      tokens.push(markdownTableToHTML(tableBlock));
      return `\n${token}\n`;
    });

    // Render the remaining text (headings/lists/bold/paragraphs) as usual.
    let html = renderMarkdown(text);

    // Swap each token's wrapping <p> for the real table/viz HTML.
    tokens.forEach((tokenHtml, i) => {
      const re = new RegExp(`<p>\\s*%%AICTOKEN${i}%%\\s*</p>`, "g");
      html = html.replace(re, tokenHtml);
    });

    return { html, vizSpecs };
  }

  /** Reads a CSS custom property from :root for theme-consistent chart colors. */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /**
   * Instantiates Chart.js charts / scorecards into their placeholder divs.
   * Safe to call multiple times — skips containers already mounted
   * (guarded via a data-mounted flag), so re-renders don't duplicate charts.
   */
  function mountVizCharts(vizSpecs) {
    if (!vizSpecs || !vizSpecs.length) return;
    if (typeof Chart === "undefined") {
      console.warn("[ai_chat] Chart.js not loaded — skipping chart mount");
      return;
    }

    const fg    = cssVar("--foreground", "#e5e7eb");
    const muted = cssVar("--muted-foreground", "#9ca3af");
    const grid  = "rgba(255,255,255,0.06)";

    vizSpecs.forEach(({ id, spec }) => {
      const container = document.getElementById(id);
      if (!container || container.dataset.mounted) return;
      container.dataset.mounted = "true";

      const scorecards = Array.isArray(spec.scorecards) ? spec.scorecards : [];
      const charts     = Array.isArray(spec.charts) ? spec.charts.slice(0, 3) : [];

      if (scorecards.length) {
        const row = document.createElement("div");
        row.className = "aic-scorecard-row";
        scorecards.forEach(sc => {
          const card = document.createElement("div");
          card.className = `aic-scorecard aic-sc-${sc.color || "blue"}`;
          card.innerHTML =
            `<div class="aic-sc-value">${escHtml(String(sc.value))}</div>` +
            `<div class="aic-sc-label">${escHtml(sc.label || "")}</div>`;
          row.appendChild(card);
        });
        container.appendChild(row);
      }

      charts.forEach(chartSpec => {
        const wrap = document.createElement("div");
        wrap.className = "aic-chart-wrap";
        const canvas = document.createElement("canvas");
        wrap.appendChild(canvas);
        container.appendChild(wrap);

        const type = chartSpec.type === "donut" ? "doughnut" : (chartSpec.type || "bar");
        const isCircular = type === "pie" || type === "doughnut";

        new Chart(canvas.getContext("2d"), {
          type,
          data: {
            labels: chartSpec.labels || [],
            datasets: (chartSpec.datasets || []).map(ds => ({
              label: ds.label,
              data: ds.data,
              backgroundColor: ds.color || "#2d7ef5",
              borderColor: ds.color || "#2d7ef5",
              borderWidth: type === "line" ? 2 : 1,
              fill: type === "line" ? false : true,
              tension: type === "line" ? 0.3 : undefined,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title:  { display: !!chartSpec.title, text: chartSpec.title || "", color: fg },
              legend: { labels: { color: muted } },
            },
            scales: isCircular ? {} : {
              x: { ticks: { color: muted }, grid: { color: grid } },
              y: { ticks: { color: muted }, grid: { color: grid } },
            },
          },
        });
      });
    });
  }

  /* ─── Thinking-block parser ───────────────────────────────────────────────
   * Splits raw assistant text into { reasoning, answer, done, present }.
   * Re-run on the full accumulated buffer on every chunk (cheap for chat-
   * length text) rather than tracked statefully token-by-token — simpler
   * and correct even if <think>/</think> straddle chunk boundaries.
   * ────────────────────────────────────────────────────────────────────── */
  const THINK_OPEN  = "<think>";
  const THINK_CLOSE = "</think>";

  function parseThinking(raw) {
    const openIdx = raw.indexOf(THINK_OPEN);
    if (openIdx === -1) {
      return { reasoning: "", answer: raw, done: true, present: false };
    }
    const closeIdx = raw.indexOf(THINK_CLOSE, openIdx);
    if (closeIdx === -1) {
      const before    = raw.slice(0, openIdx);
      const reasoning = raw.slice(openIdx + THINK_OPEN.length);
      return { reasoning, answer: before, done: false, present: true };
    }
    const before    = raw.slice(0, openIdx);
    const reasoning = raw.slice(openIdx + THINK_OPEN.length, closeIdx);
    const after     = raw.slice(closeIdx + THINK_CLOSE.length);
    return { reasoning, answer: before + after, done: true, present: true };
  }

  function formatDuration(ms) {
    if (!ms || ms < 1000) return "less than a second";
    const secs = Math.round(ms / 1000);
    return `${secs}s`;
  }

  /**
   * Applies a freshly parsed chunk of raw text to a message object,
   * updating its displayable content + reasoning state in place.
   * Called on every streamed chunk AND once for a full non-streaming reply.
   */
  function applyRawContent(msg, raw) {
    const parsed = parseThinking(raw);
    msg.content = parsed.answer.trim();

    if (parsed.present) {
      msg.reasoning = parsed.reasoning.trim();
      if (!msg.reasoningStartTs) msg.reasoningStartTs = msg.createdTs || Date.now();
      if (parsed.done && !msg.reasoningDone) {
        msg.reasoningDone = true;
        msg.reasoningElapsedMs = Date.now() - msg.reasoningStartTs;
      } else if (!parsed.done) {
        msg.reasoningDone = false;
      }
    }
  }

  /* ─── Task-progress log panel (Phase 5) ───────────────────────────────────
   * Renders the "[TASK] <label>" events streamed by ChatMiddleware before the
   * actual answer (e.g. "Querying connected MCP servers", "Sending retrieval
   * request to RAG"). Stays open (auto-expanded) while the message is still
   * streaming so progress is visible live; collapses to a one-line summary
   * once the message completes, same interaction pattern as the reasoning
   * panel below.
   * ────────────────────────────────────────────────────────────────────── */
  function buildTaskLogHTML(msg) {
    if (!msg.tasks || !msg.tasks.length) return "";

    const isActive = !msg.streamComplete;
    const open     = isActive || !!msg.tasksOpen;
    const count    = msg.tasks.length;
    const label    = isActive
      ? `Working… (step ${count} of ${msg.tasksTotal || count})`
      : `Completed ${count} step${count === 1 ? "" : "s"}`;
    const icon     = isActive ? "loader-circle" : "check-check";

    const items = msg.tasks.map((t, i) => {
      const isCurrent = isActive && i === count - 1;
      const itemIcon  = isCurrent ? "loader-circle" : "check";
      return `
        <div class="aic-task-item${isCurrent ? " current" : " done"}">
          <i data-lucide="${itemIcon}" class="aic-task-icon${isCurrent ? " aic-spin" : ""}"></i>
          <span>${escHtml(t.text)}</span>
        </div>`;
    }).join("");

    return `
      <div class="aic-tasklog${open ? " open" : ""}" data-tasklog-id="${msg.id}">
        <button class="aic-tasklog-toggle" data-tasklog-toggle="${msg.id}" aria-expanded="${open}">
          <i data-lucide="${icon}" class="aic-tasklog-icon${isActive ? " aic-spin" : ""}"></i>
          <span class="aic-tasklog-label">${escHtml(label)}</span>
          <i data-lucide="chevron-down" class="aic-tasklog-chevron"></i>
        </button>
        <div class="aic-tasklog-body">${items}</div>
      </div>`;
  }

  /* ─── Collapsible reasoning panel + answer builder ───────────────────────── */
  function buildAssistantContentHTML(msg) {
    let html = "";

    html += buildTaskLogHTML(msg);

    if (msg.reasoning) {
      const open  = !!msg.reasoningOpen;
      const label = msg.reasoningDone
        ? `Thought for ${formatDuration(msg.reasoningElapsedMs)}`
        : "Thinking…";
      const icon  = msg.reasoningDone ? "brain" : "loader-circle";

      html += `
        <div class="aic-think${open ? " open" : ""}" data-think-id="${msg.id}">
          <button class="aic-think-toggle" data-think-toggle="${msg.id}" aria-expanded="${open}">
            <i data-lucide="${icon}" class="aic-think-icon${msg.reasoningDone ? "" : " aic-spin"}"></i>
            <span class="aic-think-label">${escHtml(label)}</span>
            <i data-lucide="chevron-down" class="aic-think-chevron"></i>
          </button>
          <div class="aic-think-body">${renderMarkdown(msg.reasoning)}</div>
        </div>`;
    }

    /*
     * Change 7 — only run the table/chart-aware final renderer once the
     * message has finished streaming. While streaming is in progress
     * (msg.streamComplete falsy), keep using the cheap incremental
     * renderMarkdown() so partial ```viz JSON or half-open tables are
     * never parsed.
     */
    if (msg.streamComplete) {
      const { html: contentHtml, vizSpecs } = renderMarkdownFinal(msg.content || "", msg.id);
      msg._vizSpecs = vizSpecs;
      html += contentHtml;
    } else {
      html += renderMarkdown(msg.content || "");
    }

    return html;
  }

  /* ─── File chip builder ──────────────────────────────────────────────────── */
  function buildFileChipHTML(file, showRemove, idx) {
    const icon = file.type === "image" ? "image" : "file-text";
    const removeBtn = showRemove
      ? `<button class="chip-remove" data-idx="${idx}" aria-label="Remove ${file.name}">
           <i data-lucide="x"></i>
         </button>`
      : "";
    return `
      <div class="aic-file-chip">
        <i data-lucide="${icon}"></i>
        <span class="chip-name">${escHtml(file.name)}</span>
        <span class="chip-size">${escHtml(file.size)}</span>
        ${removeBtn}
      </div>`;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ─── Message action toolbar (copy / edit / retry) — Phase 7 ─────────────── */
  function buildMessageActionsHTML(msg, isUser) {
    const copyBtn = `
      <button class="aic-msg-action" data-action="copy" data-msg-id="${msg.id}" title="Copy" aria-label="Copy message">
        <i data-lucide="copy"></i>
      </button>`;

    if (isUser) {
      const editBtn = `
        <button class="aic-msg-action" data-action="edit" data-msg-id="${msg.id}" title="Edit" aria-label="Edit message">
          <i data-lucide="pencil"></i>
        </button>`;
      return `<div class="aic-msg-actions">${editBtn}${copyBtn}</div>`;
    }

    const retryBtn = `
      <button class="aic-msg-action" data-action="retry" data-msg-id="${msg.id}" title="Retry" aria-label="Retry response">
        <i data-lucide="refresh-cw"></i>
      </button>`;
    return `<div class="aic-msg-actions">${copyBtn}${retryBtn}</div>`;
  }

  /* ─── Message HTML builder ───────────────────────────────────────────────── */
  function buildMessageHTML(msg) {
    const isUser = msg.role === "user";
    const isAI   = msg.role === "assistant";
    const rowCls = isUser ? "aic-msg-row user" : "aic-msg-row assistant";

    if (msg.thinking) {
      return `
        <div class="${rowCls}" data-msg-id="${msg.id}">
          <div class="aic-avatar ai"><i data-lucide="sparkles"></i></div>
          <div class="aic-bubble-col">
            <div class="aic-thinking">
              <div class="dot"></div>
              <div class="dot"></div>
              <div class="dot"></div>
              <span class="thinking-lbl">Analysing…</span>
            </div>
          </div>
        </div>`;
    }

    let fileChipsHTML = "";
    if (msg.files && msg.files.length) {
      const chipsInner = msg.files.map(f => buildFileChipHTML(f, false, 0)).join("");
      fileChipsHTML = `<div class="aic-file-chips">${chipsInner}</div>`;
    }

    const isEditing = isUser && msg.id === editingId;

    const bubbleContent = isEditing
      ? `
        <textarea class="aic-edit-textarea" data-edit-textarea="${msg.id}">${escHtml(msg.content)}</textarea>
        <div class="aic-edit-actions">
          <button class="aic-edit-btn cancel" data-action="cancel-edit" data-msg-id="${msg.id}">Cancel</button>
          <button class="aic-edit-btn save" data-action="save-edit" data-msg-id="${msg.id}">Save &amp; Submit</button>
        </div>`
      : isAI
        ? buildAssistantContentHTML(msg)
        : `<p>${escHtml(msg.content)}</p>`;

    const avatarInner = isAI
      ? `<i data-lucide="sparkles"></i>`
      : `<span class="aic-user-icon">U</span>`;
    const avatarCls = isAI ? "ai" : "user";
    const bubbleCls = isAI ? "ai" : "user";

    const ts = msg.timestamp
      ? `<span class="aic-timestamp">${escHtml(msg.timestamp)}</span>`
      : "";

    // No action toolbar in edit mode (Save/Cancel already cover it) or on
    // a still-streaming assistant reply (copy/retry only make sense once
    // there's finished content to act on).
    const showActions = !isEditing && (isUser || msg.streamComplete);
    const metaRow = showActions
      ? `<div class="aic-msg-meta">${ts}${buildMessageActionsHTML(msg, isUser)}</div>`
      : (ts ? `<div class="aic-msg-meta">${ts}</div>` : "");

    return `
      <div class="${rowCls}" data-msg-id="${msg.id}">
        <div class="aic-avatar ${avatarCls}">${avatarInner}</div>
        <div class="aic-bubble-col">
          ${fileChipsHTML}
          <div class="aic-bubble ${bubbleCls}">${bubbleContent}</div>
          ${metaRow}
        </div>
      </div>`;
  }

  /* ─── Session list renderer ──────────────────────────────────────────────── */
  function renderSessionList() {
    const listEl = el("session-list");
    if (!listEl) return;

    const sorted = sortedSessions();
    if (!sorted.length) {
      listEl.innerHTML = `<p style="font-size:11px;color:var(--muted-foreground);padding:8px 8px;font-family:var(--font-mono)">No chats yet.</p>`;
      return;
    }

    listEl.innerHTML = sorted.map(s => {
      const isActive = s.id === activeId;
      const isPinned = !!s.pinned;
      const pinIcon  = isPinned ? `<i data-lucide="pin" class="aic-session-pin-icon"></i>` : "";
      return `
        <div class="aic-session-item${isActive ? " active" : ""}" data-session-id="${s.id}">
          <button class="aic-session-btn" data-session-btn="${s.id}" aria-label="Open chat: ${escHtml(s.title)}">
            <div class="aic-session-title-row">
              <span class="aic-session-title">${escHtml(s.title)}</span>
              ${pinIcon}
            </div>
            <span class="aic-session-preview">${escHtml(s.preview || "")}</span>
          </button>
          <button class="aic-session-more" data-more-btn="${s.id}" aria-label="Options for ${escHtml(s.title)}" aria-haspopup="menu">
            <i data-lucide="more-vertical"></i>
          </button>
        </div>`;
    }).join("");

    refreshIcons();
  }

  /* ─── Message list renderer ──────────────────────────────────────────────── */
  function renderMessages() {
    const listEl = el("message-list");
    if (!listEl) return;

    const session = getSession(activeId);
    if (!session) {
      listEl.innerHTML = `
        <div class="aic-empty-state">
          <i data-lucide="message-square"></i>
          <p>Select a chat or start a new one.</p>
        </div>`;
      refreshIcons();
      return;
    }

    listEl.innerHTML = session.messages.map(m => buildMessageHTML(m)).join("");
    refreshIcons();

    /*
     * Change 7 — mount any charts/scorecards produced by buildAssistantContentHTML()
     * during the innerHTML assignment above. Must happen AFTER the HTML is in the
     * DOM since Chart.js needs the placeholder <div>/<canvas> to actually exist.
     * mountVizCharts() is idempotent (guards on data-mounted), so calling it on
     * every render is safe even for messages that already have their charts mounted.
     */
    session.messages.forEach(m => { if (m._vizSpecs) mountVizCharts(m._vizSpecs); });

    scrollToBottom();
  }

  /* ─── Chat header ────────────────────────────────────────────────────────── */
  function renderChatHeader() {
    const session = getSession(activeId);
    const titleEl = el("chat-title");
    if (titleEl) titleEl.textContent = session ? session.title : "Select a chat";
  }

  /* ─── Full re-render ─────────────────────────────────────────────────────── */
  function render() {
    renderSessionList();
    renderMessages();
    renderChatHeader();
    updateSendBtn();
  }

  /* ─── Scroll to bottom ───────────────────────────────────────────────────── */
  function scrollToBottom() {
    const listEl = el("message-list");
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  /* ─── Send button enabled state / stop-mode toggle (Phase 6) ─────────────── */
  function updateSendBtn() {
    const btn   = el("btn-send");
    const input = el("chat-input");
    if (!btn) return;

    if (isSending) {
      btn.classList.add("stop-mode");
      btn.disabled = false;
      btn.setAttribute("aria-label", "Stop response");
      btn.innerHTML = `<i data-lucide="square"></i>`;
      refreshIcons();
      return;
    }

    btn.classList.remove("stop-mode");
    btn.setAttribute("aria-label", "Send message");
    btn.innerHTML = `<i data-lucide="send"></i>`;
    refreshIcons();

    const hasText  = input && input.value.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    btn.disabled = (!hasText && !hasFiles) || !activeId;
  }

  /* ─── refreshIcons wrapper ───────────────────────────────────────────────── */
  function refreshIcons() {
    if (global.Utils && typeof global.Utils.refreshIcons === "function") {
      global.Utils.refreshIcons();
    } else if (global.lucide) {
      global.lucide.createIcons();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SESSION OPERATIONS
  ═══════════════════════════════════════════════════════════════════════════ */

  function createNewSession() {
    const id       = `chat-${Date.now()}`;
    const greeting = "Hello! I'm your MCP Observability AI. I have full context across all connected sources.\n\nWhat would you like to explore?";
    const session  = {
      id,
      createdAt: Date.now(),
      title:     "New chat",
      preview:   greeting.slice(0, 60),
      pinned:    false,
      pinnedAt:  null,
      messages: [{
        id:        uid(),
        role:      "assistant",
        timestamp: nowTs(),
        content:   greeting,
      }],
    };
    sessions.unshift(session);
    setActiveSession(id);
  }

  function setActiveSession(id) {
    activeId = id;
    closeContextMenu();
    render();
  }

  function renameSession(id) {
    const s = getSession(id);
    if (!s) return;
    const next = window.prompt("Rename chat", s.title);
    if (next && next.trim()) {
      s.title = next.trim();
      render();
    }
    closeContextMenu();
  }

  function togglePinSession(id) {
    const s = getSession(id);
    if (!s) return;
    s.pinned   = !s.pinned;
    s.pinnedAt = s.pinned ? Date.now() : null;
    renderSessionList();
    closeContextMenu();
  }

  function deleteSession(id) {
    const s = getSession(id);
    if (!s) return;
    if (!window.confirm(`Delete "${s.title}"?`)) { closeContextMenu(); return; }
    sessions = sessions.filter(x => x.id !== id);
    if (activeId === id) {
      activeId = sessions.length ? sortedSessions()[0].id : null;
    }
    /* If the deleted session was the last-messaged one, clear the tracker */
    if (lastMessagedSessionId === id) {
      lastMessagedSessionId = null;
    }
    render();
    closeContextMenu();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CONTEXT MENU
  ═══════════════════════════════════════════════════════════════════════════ */

  function openContextMenu(sessionId, anchorEl) {
    openMenuId = sessionId;
    const menuEl = el("session-menu");
    if (!menuEl) return;

    const s = getSession(sessionId);
    const pinLabel = el("menu-pin-label");
    if (pinLabel) pinLabel.textContent = s && s.pinned ? "Unpin chat" : "Pin chat to top";

    const rect = anchorEl.getBoundingClientRect();
    menuEl.style.top  = `${rect.bottom + 4}px`;
    menuEl.style.left = `${Math.min(rect.left, window.innerWidth - 170)}px`;

    menuEl.classList.remove("hidden");
    refreshIcons();
  }

  function closeContextMenu() {
    openMenuId = null;
    const menuEl = el("session-menu");
    if (menuEl) menuEl.classList.add("hidden");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MESSAGING
  ═══════════════════════════════════════════════════════════════════════════ */

  async function sendMessage() {
    if (isSending || !activeId) return;
    const inputEl = el("chat-input");
    if (!inputEl) return;

    const text  = inputEl.value.trim();
    const files = [...pendingFiles];
    if (!text && !files.length) return;

    isSending = true;
    updateSendBtn();

    inputEl.value = "";
    inputEl.style.height = "auto";
    pendingFiles = [];
    renderFilePreview();

    const session = getSession(activeId);
    if (!session) { isSending = false; updateSendBtn(); return; }

    const userMsg = {
      id:        uid(),
      role:      "user",
      timestamp: nowTs(),
      content:   text,
      files:     files.length ? files : undefined,
    };
    const thinkMsg = {
      id:       uid() + "-think",
      role:     "assistant",
      content:  "",
      thinking: true,
    };

    if (session.title === "New chat" && text) {
      session.title = text.slice(0, 40);
    }
    session.preview = text || session.preview;
    session.messages.push(userMsg, thinkMsg);

    /*
     * Change 6 — record which session the user last actively messaged.
     * Recorded here (before the await) so it is set even if the API call
     * fails — the user is definitively in this session.
     */
    lastMessagedSessionId = activeId;

    renderMessages();
    renderSessionList();

    try {
      // Insert a real (empty) assistant bubble to stream into
      session.messages = session.messages.filter(m => !m.thinking);
      const streamMsg = {
        id:         uid() + "-reply",
        role:       "assistant",
        timestamp:  nowTs(),
        content:    "",
        rawContent: "",
        createdTs:  Date.now(),
        streamComplete: false,
        tasks:      [],       // Phase 5 — [{ text, ts }]
        tasksTotal: 5,        // matches ChatMiddleware's TASK_STEPS length; used only for the "step N of 5" label
      };
      session.messages.push(streamMsg);
      currentStreamMsg = streamMsg;
      renderMessages();

      // Patches just the streaming bubble in place — cheaper than a full
      // renderMessages() on every task/chunk event, and avoids re-parsing
      // table/chart tokens mid-stream (streamComplete is still false here).
      const patchBubble = () => {
        const bubbleEl = document.querySelector(`[data-msg-id="${streamMsg.id}"] .aic-bubble`);
        if (bubbleEl) {
          bubbleEl.innerHTML = buildAssistantContentHTML(streamMsg);
          refreshIcons();
        }
        scrollToBottom();
      };

      await new Promise((resolve, reject) => {
        currentStreamResolve = resolve;

        currentAbortHandle = API.postChat(
          {
            sessionId: activeId,
            message:   text,
            history:   session.messages
              .filter(m => !m.thinking && m.id !== streamMsg.id)
              .map(m => ({ role: m.role, content: m.content })),
          },
          (chunk) => {
            streamMsg.rawContent += chunk;
            applyRawContent(streamMsg, streamMsg.rawContent);
            patchBubble();
          },
          () => resolve(),
          (err) => reject(err),
          (taskLabel) => {
            // Phase 5 — task-progress event, kept separate from answer text
            streamMsg.tasks.push({ text: taskLabel, ts: Date.now() });
            patchBubble();
          }
        );
      });

      if (!streamMsg.content && !streamMsg.streamComplete) streamMsg.content = FALLBACK_REPLY;

      /*
       * Change 7 — mark the message complete now that the stream has
       * finished. The next renderMessages() call (in `finally` below) will
       * pick this up and run the table/chart-aware renderMarkdownFinal()
       * exactly once, then mount any charts/scorecards.
       * (No-op if stopStreaming() already marked it complete.)
       */
      streamMsg.streamComplete = true;
    } catch (err) {
      console.warn("[ai_chat] sendMessage error:", err);
      // Remove thinking bubble if streaming never started
      session.messages = session.messages.filter(m => !m.thinking);
      // If streamMsg was already pushed but stayed empty, set fallback
      const existing = session.messages.find(m => m.id && m.id.endsWith("-reply"));
      if (existing && !existing.content) {
        existing.content = FALLBACK_REPLY;
        existing.streamComplete = true;
      } else if (!existing) {
        session.messages.push({
          id:        uid() + "-err",
          role:      "assistant",
          timestamp: nowTs(),
          content:   FALLBACK_REPLY,
          streamComplete: true,
        });
      }
    } finally {
      isSending          = false;
      currentAbortHandle = null;
      currentStreamResolve = null;
      currentStreamMsg   = null;
      updateSendBtn();
      renderMessages();
      renderSessionList();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     STOP BUTTON (Phase 6)
  ═══════════════════════════════════════════════════════════════════════════ */

  function stopStreaming() {
    if (currentAbortHandle) {
      currentAbortHandle.abort();
      currentAbortHandle = null;
    }

    if (currentStreamMsg) {
      const msg = currentStreamMsg;
      msg.content = msg.content && msg.content.trim()
        ? msg.content.trim() + "\n\n[Request terminated by user.]"
        : "[Request terminated by user.]";
      msg.rawContent = msg.content;
      msg.streamComplete = true;
    }

    // postChat() swallows AbortError internally (never calls onDone/onError),
    // so the Promise sendMessage() is awaiting would otherwise hang forever —
    // resolve it directly here to let sendMessage()'s `finally` block run.
    if (currentStreamResolve) {
      const resolve = currentStreamResolve;
      currentStreamResolve = null;
      resolve();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     MESSAGE ACTIONS: copy / edit / retry (Phase 7)
  ═══════════════════════════════════════════════════════════════════════════ */

  function copyMessageText(text) {
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    } else {
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity  = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* best effort */ }
    document.body.removeChild(ta);
  }

  function copyMessage(id) {
    const session = getSession(activeId);
    const msg = session && session.messages.find(m => m.id === id);
    if (!msg) return;
    copyMessageText(msg.content || "");
  }

  function startEditMessage(id) {
    if (isSending) return; // don't allow editing mid-stream
    editingId = id;
    renderMessages();
    const ta = document.querySelector(`[data-edit-textarea="${id}"]`);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  function cancelEditMessage() {
    editingId = null;
    renderMessages();
  }

  function saveEditMessage(id) {
    const session = getSession(activeId);
    const ta = document.querySelector(`[data-edit-textarea="${id}"]`);
    if (!session || !ta) { editingId = null; renderMessages(); return; }

    const newText = ta.value.trim();
    editingId = null;
    if (!newText) { renderMessages(); return; }

    // Drop the edited message and everything after it — it gets re-sent
    // through the normal sendMessage() pipeline for consistent
    // tasks/streaming behaviour, same as a brand-new message.
    const idx = session.messages.findIndex(m => m.id === id);
    if (idx !== -1) session.messages = session.messages.slice(0, idx);

    const inputEl = el("chat-input");
    if (inputEl) inputEl.value = newText;
    sendMessage();
  }

  function retryMessage(id) {
    if (isSending) return;
    const session = getSession(activeId);
    if (!session) return;

    const idx = session.messages.findIndex(m => m.id === id);
    if (idx === -1) return;

    // Walk back to the nearest preceding user message to re-send.
    let userIdx = idx - 1;
    while (userIdx >= 0 && session.messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;

    const userText = session.messages[userIdx].content;
    session.messages = session.messages.slice(0, userIdx);

    const inputEl = el("chat-input");
    if (inputEl) inputEl.value = userText;
    sendMessage();
  }

  /* ─── File handling ──────────────────────────────────────────────────────── */

  function handleFileInput(e) {
    const fileList = e.target.files;
    if (!fileList) return;
    for (const f of fileList) {
      pendingFiles.push({
        name: f.name,
        size: `${(f.size / 1024).toFixed(1)} KB`,
        type: f.type.startsWith("image/") ? "image" : "file",
      });
    }
    e.target.value = "";
    renderFilePreview();
    updateSendBtn();
  }

  function removeFile(idx) {
    pendingFiles.splice(idx, 1);
    renderFilePreview();
    updateSendBtn();
  }

  function renderFilePreview() {
    const bar = el("file-preview");
    if (!bar) return;
    if (!pendingFiles.length) {
      bar.innerHTML = "";
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    bar.innerHTML = pendingFiles.map((f, i) => buildFileChipHTML(f, true, i)).join("");
    refreshIcons();

    bar.querySelectorAll(".chip-remove").forEach(btn => {
      btn.addEventListener("click", () => removeFile(parseInt(btn.dataset.idx, 10)));
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENT WIRING
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireEvents() {

    const newBtn       = el("btn-new-chat");
    const headerNewBtn = el("btn-header-new-chat");
    if (newBtn)       newBtn.addEventListener("click",       () => createNewSession());
    if (headerNewBtn) headerNewBtn.addEventListener("click", () => createNewSession());

    const listEl = el("session-list");
    if (listEl) {
      listEl.addEventListener("click", e => {
        const sessionBtn = e.target.closest("[data-session-btn]");
        if (sessionBtn) {
          const id = sessionBtn.dataset.sessionBtn;
          if (id !== activeId) setActiveSession(id);
          return;
        }
        const moreBtn = e.target.closest("[data-more-btn]");
        if (moreBtn) {
          e.stopPropagation();
          const id = moreBtn.dataset.moreBtn;
          if (openMenuId === id) {
            closeContextMenu();
          } else {
            openContextMenu(id, moreBtn);
          }
        }
      });
    }

    const menuEl = el("session-menu");
    if (menuEl) {
      menuEl.addEventListener("click", e => {
        const item = e.target.closest("[data-action]");
        if (!item || !openMenuId) return;
        const action = item.dataset.action;
        if (action === "pin")    togglePinSession(openMenuId);
        if (action === "rename") renameSession(openMenuId);
        if (action === "delete") deleteSession(openMenuId);
      });
    }

    document.addEventListener("click", e => {
      if (!openMenuId) return;
      const menu = el("session-menu");
      if (menu && !menu.contains(e.target)) closeContextMenu();
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && openMenuId) closeContextMenu();
    });

    const inputEl = el("chat-input");
    if (inputEl) {
      inputEl.addEventListener("input", () => {
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
        updateSendBtn();
      });
      inputEl.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    const sendBtn = el("btn-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        if (isSending) stopStreaming();
        else sendMessage();
      });
    }

    const messageListEl = el("message-list");
    if (messageListEl) {
      messageListEl.addEventListener("click", e => {
        const thinkToggleBtn = e.target.closest("[data-think-toggle]");
        if (thinkToggleBtn) {
          const id = thinkToggleBtn.dataset.thinkToggle;
          const session = getSession(activeId);
          const msg = session && session.messages.find(m => m.id === id);
          if (!msg) return;
          msg.reasoningOpen = !msg.reasoningOpen;
          // Toggle in place — no full re-render needed
          const panel = messageListEl.querySelector(`[data-think-id="${id}"]`);
          if (panel) {
            panel.classList.toggle("open", msg.reasoningOpen);
            thinkToggleBtn.setAttribute("aria-expanded", String(msg.reasoningOpen));
          }
          return;
        }

        // Phase 5 — task-log toggle
        const taskToggleBtn = e.target.closest("[data-tasklog-toggle]");
        if (taskToggleBtn) {
          const id = taskToggleBtn.dataset.tasklogToggle;
          const session = getSession(activeId);
          const msg = session && session.messages.find(m => m.id === id);
          if (!msg) return;
          msg.tasksOpen = !msg.tasksOpen;
          const forceOpen = !msg.streamComplete || msg.tasksOpen;
          const panel = messageListEl.querySelector(`[data-tasklog-id="${id}"]`);
          if (panel) {
            panel.classList.toggle("open", forceOpen);
            taskToggleBtn.setAttribute("aria-expanded", String(forceOpen));
          }
          return;
        }

        // Phase 7 — message action toolbar (copy / edit / retry / save / cancel)
        const actionBtn = e.target.closest("[data-action]");
        if (actionBtn && actionBtn.dataset.msgId) {
          const action = actionBtn.dataset.action;
          const id = actionBtn.dataset.msgId;
          if (action === "copy")        copyMessage(id);
          else if (action === "edit")        startEditMessage(id);
          else if (action === "cancel-edit") cancelEditMessage();
          else if (action === "save-edit")   saveEditMessage(id);
          else if (action === "retry")       retryMessage(id);
        }
      });

      // Phase 7 — Enter saves an in-progress edit, Shift+Enter inserts a
      // newline, Escape cancels. Delegated since the textarea is re-created
      // on every render.
      messageListEl.addEventListener("keydown", e => {
        const ta = e.target.closest("[data-edit-textarea]");
        if (!ta) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          saveEditMessage(ta.dataset.editTextarea);
        } else if (e.key === "Escape") {
          cancelEditMessage();
        }
      });
    }

    const attachBtn = el("btn-attach");
    const fileInput = el("file-input");
    if (attachBtn && fileInput) {
      attachBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", handleFileInput);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BOOTSTRAP
  ═══════════════════════════════════════════════════════════════════════════ */

  document.addEventListener("DOMContentLoaded", () => {

    /*
     * Shared header — safe to call even inside an iframe.
     * common.js detects (window !== top) and returns immediately when running
     * inside the SPA shell, so this is a no-op in production and correctly
     * renders the header when the page is opened directly in development.
     */
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }

    /* Stamp static lucide icons */
    if (global.lucide) global.lucide.createIcons();

    /* Set default active session to first pinned, then first overall */
    const sorted = sortedSessions();
    activeId = sorted.length ? sorted[0].id : null;

    /* Initial render */
    render();

    /* Wire all interactions */
    wireEvents();
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     Change 6 — onTabActivated()

     Called by the SPA shell (index.html / Shell.showTab) each time the
     AI Chat tab becomes visible.

     Behaviour:
       • If the user last sent a message in a session that still exists,
         restore activeId to that session and re-render so the conversation
         is always visible when they return to this tab.
       • If lastMessagedSessionId is null (no message ever sent, or that
         session was deleted), leave activeId as-is — don't disrupt whatever
         session the sidebar was already showing.
       • The isFirstActivation argument is accepted but not used here; the
         restore logic should run on every activation, not just the first.
  ═══════════════════════════════════════════════════════════════════════════ */
  global.onTabActivated = function onTabActivated(/* isFirstActivation */) {
    if (lastMessagedSessionId && getSession(lastMessagedSessionId)) {
      if (activeId !== lastMessagedSessionId) {
        activeId = lastMessagedSessionId;
        render();
      }
    }
  };

  /* ─── Public surface (debug + shell integration) ─────────────────────────── */
  global.AIC = {
    getSessions:  () => sessions,
    getActiveId:  () => activeId,
    getLastMessagedSessionId: () => lastMessagedSessionId,
    createChat:   createNewSession,
    sendMessage:  sendMessage,
  };

})(window);