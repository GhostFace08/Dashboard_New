/**
 * settings.js — Unified MCP Dashboard
 *
 * Phase 15 — MCP Servers overhaul:
 *  - Removed the old hardcoded-4-tool "Monitoring Services" UI
 *    (buildMonitoringSection) and the old Issue Categorization / Field
 *    Mapping / AI Keywords editors (buildCatTabs, renderCatList,
 *    buildMappingSection, renderAIKeywords, etc.) — all of that targeted
 *    DOM this project's own Phase 14 pass had already removed from
 *    settings.html, so the JS was dead code guarding on missing elements.
 *  - Replaced with a single MCP Servers admin module (Section 5 below):
 *    a server list (backed by backend/data/mcpconf.ini) with an Add
 *    Server modal and a multi-tab Edit modal (Server Details / Mapping /
 *    Issue Categorization / Time Mapping / AI Keywords). Issue
 *    Categorization now edits per-server keyword lists inside a shared
 *    categories doc (backend/data/categorization.json); AI Keywords edits
 *    a per-server list inside backend/data/llm.ini's [keywords] section.
 *    Each tab saves immediately via API.putConfig() rather than through
 *    the global Save-Changes footer, which covers
 *    conf.properties/llm.ini/rag.ini/performance.ini/chat.ini/capacity.ini.
 *  - category.json, keywords.json, conf.ini, mcpconf.properties, and
 *    apmconf.properties are gone — superseded by the file layout above
 *    (mcpconf.ini holds the per-server "Details" tab; mapping.json now
 *    holds Mapping/Dashboards/Time-Mapping, which used to live embedded
 *    inside mcpservers.json with mapping.json itself sitting orphaned).
 *
 * DEPENDENCIES: config.js → api.js → common.js must load first.
 */

(function (global) {
  "use strict";

  if (!global.CFG)   { console.error("[settings] CFG missing"); return; }
  if (!global.API)   { console.error("[settings] API missing"); return; }
  if (!global.Utils) { console.error("[settings] Utils missing"); return; }

  /* ═══════════════════════════════════════════════════════════════════════════
     0. NAV CONFIG
  ═══════════════════════════════════════════════════════════════════════════ */

  const NAV = [
    { id: "general",     label: "General",              icon: "settings",           desc: "Application, logging & service defaults" },
    { id: "monitoring",  label: "MCP Servers",           icon: "activity",           desc: "Admin-defined monitoring servers" },
    { id: "capacity",    label: "Capacity & Forecasting",icon: "trending-up",        desc: "Forecasting defaults (coming soon)" },
    { id: "ai",          label: "AI & Models",           icon: "brain",              desc: "Local LLM & intent detection" },
    { id: "rag",         label: "Retrieval (RAG)",       icon: "database",           desc: "Vector store, documents & ranking" },
    { id: "performance", label: "Performance",           icon: "cpu",                desc: "GPU & resources" },
    { id: "advanced",    label: "Advanced",              icon: "wrench",             desc: "Prompt templates & paths" },
  ];

  /* ═══════════════════════════════════════════════════════════════════════════
     1. STATE
  ═══════════════════════════════════════════════════════════════════════════ */

  let activeSection = "general";
  let dirty         = false;

  // Canonical fields every server's Mapping tab lets you set.
  const CANONICAL_FIELDS = [
    { key: "issueId",          label: "Issue ID"          },
    { key: "title",            label: "Title"             },
    { key: "application",      label: "Application"       },
    { key: "affectedEntities", label: "Affected Entities" },
    { key: "severity",         label: "Severity"          },
    { key: "category",         label: "Category"          },
    { key: "status",           label: "Status"            },
    { key: "startTime",        label: "Start Time"        },
    { key: "endTime",          label: "End Time"          },
    { key: "description",      label: "Description"       },
  ];

  // Fixed vendor list for the Type/Vendor dropdown — matches CFG.TOOLS'
  // four hardcoded tools, plus a 5th "Custom Tool" escape hatch that reveals
  // a free-text name input.
  const VENDOR_OPTIONS = [
    { id: "dynatrace",    label: "DynaTrace"    },
    { id: "opmanager",    label: "OPManager"    },
    { id: "appdynamics",  label: "AppDynamics"  },
    { id: "heal",         label: "HEAL"         },
    { id: "custom",       label: "Custom Tool"  },
  ];

  // ── Phase 15 — MCP Servers state ────────────────────────────────────────
  let mcpServers       = [];          // [{ id, name, mode, baseUrl, mapping, sample, ... }]
  let mcpCategorization = { unknownLabel: "Unknown", categories: [] };
  let mcpKeywords      = {};          // { [serverId]: [keyword, ...] }
  let mcpLoaded        = false;

  let editingServerId  = null;
  let editingTab       = "details";
  let addCertAcked     = false;
  let editCertAcked    = false;

  // Tool Registry state — a registry is either a plain file the admin
  // uploads (one path per line) or a JSON tool-registry document fetched
  // from an endpoint, e.g.:
  //   { "src": "dynatrace", "tools": [
  //       { "name": "gdx", "description": "...", "api url": "https://…/api/tools/xyz" },
  //       ...
  //   ] }
  // Either shape is normalized into a flat list of
  // { name, path, description } entries — "path" is the value actually
  // used to populate the "Registry Path for Fetching Issues" dropdown
  // (and the 5 Dashboards-tab dropdowns), "name" is what's shown in the
  // option label.
  let addRegistryPaths  = [];   // [{name, path, description}, ...] parsed from the Add-modal
  let editRegistryPaths = {};   // { [serverId]: [{name, path, description}, ...] } parsed on edit-modal

  // Time Mapping tab — per-server map of generalized-timestamp component
  // (token, e.g. "YYYY") → how this server's own timestamp supplies it.
  // { [serverId]: { format: "<general format string this was built from>",
  //                 tokens: { [token]: value } } }
  let editTimeMapping = {};

  // Normalizes any supported Tool Registry shape into a flat list of
  // { name, path, description } entries. Supports, in order of preference:
  //   1. { "tools": [ { name, description, "api url" | apiUrl | api_url | url }, ... ] }
  //      (the vendor-tool-registry shape, e.g. { "src": "dynatrace", "tools": [...] })
  //   2. { "paths": ["/a", "/b", ...] }  — legacy JSON shape
  //   3. [ "/a", "/b", ... ]             — bare JSON array of path strings
  //   4. plain text, one path per line (# comments and blank lines skipped)
  // Display-only mirror of SettingsMiddleware's combineRegistryUrl(), so the
  // UI can preview the full URL before the admin actually fetches. The real
  // combination — and the actual request — always happens server-side.
  function combineRegistryUrlForDisplay(baseUrl, path) {
    const p = String(path || "").trim();
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p;
    const b = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!b) return p;
    return b + (p.startsWith("/") ? p : `/${p}`);
  }

  function parseRegistryContent(text) {
    // Strip a UTF-8 BOM some editors/exports prepend — left in place, it
    // silently breaks the "{"/"[" check below and everything falls back to
    // being split line-by-line as if it were a plain-text registry.
    const raw = String(text || "").replace(/^\uFEFF/, "");
    const trimmed = raw.trim();

    if (trimmed) {
      try {
        const json = JSON.parse(trimmed);

        if (Array.isArray(json)) {
          return json.map(String).filter(Boolean).map(p => ({ name: p, path: p, description: "" }));
        }

        if (json && Array.isArray(json.tools)) {
          return json.tools.map(t => {
            const path = String(t["api url"] ?? t.apiUrl ?? t.api_url ?? t.url ?? t.path ?? "").trim();
            const name = String(t.name ?? path).trim();
            return { name: name || path, path: path || name, description: String(t.description ?? "") };
          }).filter(e => e.path);
        }

        if (json && Array.isArray(json.paths)) {
          return json.paths.map(String).filter(Boolean).map(p => ({ name: p, path: p, description: "" }));
        }

        // Valid JSON, but not a shape we recognize (no tools/paths array
        // and not itself an array) — nothing usable to extract.
        return [];
      } catch (_) { /* not valid JSON — fall through to line parsing */ }
    }

    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#"))
      .map(p => ({ name: p, path: p, description: "" }));
  }

  // @deprecated kept as a thin alias — old name for parseRegistryContent.
  function parseRegistryFile(text) { return parseRegistryContent(text); }

  // The "needs a payload" toggle is only interactable once the Tool
  // Registry Endpoint URL has a value. Clearing the URL forces the
  // toggle back off and re-disables it, and hides the payload box.
  function updateRegistryPayloadToggleState(urlInputId, toggleId, payloadWrapId) {
    const urlVal = ($(urlInputId)?.value || "").trim();
    const toggle = $(toggleId);
    const wrap   = $(payloadWrapId);
    if (!toggle) return;
    if (!urlVal) {
      toggle.disabled = true;
      toggle.dataset.on = "false";
      toggle.classList.remove("on");
      wrap?.classList.add("hidden");
    } else {
      toggle.disabled = false;
    }
    wrap?.classList.toggle("hidden", !(urlVal && toggle.dataset.on === "true"));
  }

  // Fetch a tool registry from an endpoint path (e.g. "/api/tools"). The
  // actual HTTP request happens server-side, in SettingsMiddleware: it
  // combines this server's Base URL with the path given here (path may
  // also be a full absolute URL, kept as-is for back-compat with older
  // records) and performs the GET/POST itself — the browser never talks
  // to the target host directly, so there's no CORS to worry about.
  async function fetchRegistryFromUrl(baseUrl, path, authToken, payload) {
    const result = await API.fetchToolRegistry({ baseUrl, path, token: authToken, payload });
    if (!result || !result.ok) {
      throw new Error((result && result.error) || "Fetch failed");
    }
    if (result.status && (result.status < 200 || result.status >= 300)) {
      throw new Error(`HTTP ${result.status}`);
    }
    return parseRegistryContent(result.body);
  }

  // True for a string that looks like a fragment of raw JSON source rather
  // than an actual tool/path name — e.g. "{", "},", "\"tools\": [",
  // "\"name\": \"alarms\",". This is what a corrupted pre-fix registry
  // (saved back when the JSON-detection could silently fail and fall
  // through to line-splitting) looks like: every line of the original
  // file ends up stored as its own "path" entry. Filtering these out at
  // render time means a server whose registry.paths was already saved
  // in that broken shape gets cleaned up automatically instead of
  // displaying the raw file forever.
  function looksLikeJsonSyntaxFragment(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    if (/^[{}\[\],]+$/.test(t)) return true;           // bare braces/brackets/commas: {  }  [  ],  {,
    if (/^"[^"]*"\s*:\s*.*,?$/.test(t)) return true;    // "key": value  /  "key": "value",
    return false;
  }

  // paths: array of either { name, path, description } entries or plain
  // strings (back-compat with records saved before this change).
  // The dropdown label is ALWAYS just the tool name — the (often long)
  // api url only ever goes in as the option's value, never shown.
  function registryPathOptionsHtml(paths, selected) {
    const clean = (paths || []).filter(p => {
      const name = typeof p === "string" ? p : (p && (p.name ?? p.path));
      return !looksLikeJsonSyntaxFragment(name);
    });

    if (clean.length === 0) {
      return (paths && paths.length > 0)
        ? `<option value="">Saved registry data looks invalid — re-upload or re-fetch it</option>`
        : `<option value="">Upload a Tool Registry first…</option>`;
    }
    return `<option value="">Select a path…</option>` +
      clean.map(p => {
        const entry = (typeof p === "string") ? { name: p, path: p } : p;
        const value = entry.path;
        const label = entry.name || entry.path;
        return `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
      }).join("");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     2. HELPERS
  ═══════════════════════════════════════════════════════════════════════════ */

  const $   = id => document.getElementById(id);
  const esc = Utils.escapeHtml;

  function markDirty() { dirty = true; updateFooter(); }

  function updateFooter() {
    const unsaved = $("unsaved-badge");
    const saved   = $("saved-badge");
    if (!unsaved || !saved) return;
    unsaved.classList.toggle("hidden", !dirty);
    saved.style.display = dirty ? "none" : "";
  }

  function refreshIcons() { Utils.refreshIcons(); }
  function toast(message, type) {
    if (Utils.showToast) Utils.showToast(message, type);
    else if (type === "error") alert(message);
  }

  /** Read the active data-val from a segmented control */
  function activeSegValue(segId) {
    const el = $(segId);
    if (!el) return null;
    return el.querySelector(".seg-btn.active")?.dataset.val ?? null;
  }

  /** Read a toggle's on/off state */
  function toggleOn(id) {
    const el = $(id);
    return el ? el.dataset.on === "true" : false;
  }

  /** Read an input/select value with fallback */
  function val(id, fallback = "") {
    return $(id)?.value ?? fallback;
  }

  function slugify(name) {
    return (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `server-${Date.now()}`;
  }

  /** Flattens a nested object into dot/bracket-path → value pairs, for the Mapping wizard's field picker. */
  function flattenSample(obj, prefix = "", out = {}) {
    if (obj === null || obj === undefined) return out;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => flattenSample(v, `${prefix}[${i}]`, out));
      return out;
    }
    if (typeof obj === "object") {
      Object.entries(obj).forEach(([k, v]) => flattenSample(v, prefix ? `${prefix}.${k}` : k, out));
      return out;
    }
    out[prefix] = obj;
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     3. LEFT NAV
  ═══════════════════════════════════════════════════════════════════════════ */

  function renderNav(filter) {
    const list = $("nav-list");
    if (!list) return;
    const lower = (filter || "").toLowerCase();
    const visible = NAV.filter(n =>
      !lower || n.label.toLowerCase().includes(lower) || n.desc.toLowerCase().includes(lower)
    );
    list.innerHTML = visible.map(n => `
      <button class="snav-item${n.id === activeSection ? " active" : ""}" data-nav="${n.id}">
        <i data-lucide="${n.icon}"></i>
        <div class="min-w-0">
          <p class="snav-item-label">${esc(n.label)}</p>
          <p class="snav-item-desc">${esc(n.desc)}</p>
        </div>
      </button>
    `).join("");
    list.querySelectorAll(".snav-item").forEach(btn =>
      btn.addEventListener("click", () => switchSection(btn.dataset.nav))
    );
    refreshIcons();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     4. SECTION SWITCHING
  ═══════════════════════════════════════════════════════════════════════════ */

  function switchSection(id) {
    activeSection = id;
    document.querySelectorAll(".settings-section").forEach(s => {
      s.classList.remove("active");
      s.classList.add("hidden");
    });
    const target = $(`sec-${id}`);
    if (target) { target.classList.remove("hidden"); target.classList.add("active"); }
    const titleEl = $("section-title");
    const nav     = NAV.find(n => n.id === id);
    if (titleEl && nav) titleEl.textContent = nav.label;
    renderNav();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     5. MCP SERVERS  (Phase 15)
  ═══════════════════════════════════════════════════════════════════════════ */

  async function loadMcpData() {
    try {
      const serversText = await API.getConfig("mcpconf.ini");
      const parsed = serversText ? JSON.parse(serversText) : { servers: [] };
      mcpServers = Array.isArray(parsed.servers) ? parsed.servers : [];
    } catch (e) {
      console.warn("[settings] Could not load mcpconf.ini:", e);
      mcpServers = [];
    }
    // mapping.json holds the Mapping/Dashboards/Time-Mapping tab data, keyed
    // by server id — merge it back onto each server object in memory so the
    // rest of the page (which reads s.mapping/s.dashboards/s.timeMapping
    // directly) doesn't need to change at all.
    try {
      const mapText = await API.getConfig("mapping.json");
      const parsed = mapText ? JSON.parse(mapText) : {};
      mcpServers.forEach(s => {
        const entry = (parsed && typeof parsed === "object") ? parsed[s.id] : null;
        if (entry) {
          s.mapping     = entry.mapping     || s.mapping     || {};
          s.dashboards  = entry.dashboards  || s.dashboards  || {};
          s.timeMapping = entry.timeMapping || s.timeMapping || {};
        }
      });
    } catch (e) {
      console.warn("[settings] Could not load mapping.json:", e);
    }
    try {
      const catText = await API.getConfig("categorization.json");
      const parsed  = catText ? JSON.parse(catText) : null;
      if (parsed && Array.isArray(parsed.categories)) mcpCategorization = parsed;
    } catch (e) {
      console.warn("[settings] Could not load categorization.json:", e);
    }
    // Keywords now live inside llm.ini's [keywords] section (merged with
    // AI & Models on Phase 16's file reorganization) instead of the old
    // standalone keywords.json.
    try {
      const llmText = await API.getConfig("llm.ini");
      mcpKeywords = parseKeywordsFromLlmIni(llmText || "");
    } catch (e) {
      console.warn("[settings] Could not load llm.ini for keywords:", e);
    }
    // One-time migration shim: registry.payloadIsUpload (pre-Tool-Registry-
    // patch field name) → registry.usesPayload. Without this, any server
    // entry saved before that rename would silently lose its toggle state
    // the first time it loaded under the new code.
    mcpServers.forEach(s => {
      if (s.registry && s.registry.payloadIsUpload !== undefined && s.registry.usesPayload === undefined) {
        s.registry.usesPayload = s.registry.payloadIsUpload;
        delete s.registry.payloadIsUpload;
      }
    });
    mcpLoaded = true;
    renderServerList();
  }

  // Parses the "[keywords]\nserverId = kw1, kw2, kw3" section out of an
  // llm.ini text blob back into { [serverId]: [kw1, kw2, kw3] }.
  function parseKeywordsFromLlmIni(text) {
    const out = {};
    const lines = text.split("\n");
    let inSection = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "[keywords]") { inSection = true; continue; }
      if (line.startsWith("[")) { inSection = false; continue; }
      if (!inSection) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      out[key] = val ? val.split(",").map(s => s.trim()).filter(Boolean) : [];
    }
    return out;
  }

  // Splits each server's in-memory object into the two files that now own
  // different parts of it: mcpconf.ini gets the "Details" tab fields,
  // mapping.json gets Mapping/Dashboards/Time-Mapping keyed by id. Both are
  // written every time so neither ever goes stale relative to the other.
  async function persistServers() {
    const detailsOnly = mcpServers.map(s => {
      const { mapping, dashboards, timeMapping, ...details } = s;
      return details;
    });
    await API.putConfig("mcpconf.ini", JSON.stringify({ servers: detailsOnly }, null, 2));

    const mappingById = {};
    mcpServers.forEach(s => {
      mappingById[s.id] = {
        mapping:     s.mapping     || {},
        dashboards:  s.dashboards  || {},
        timeMapping: s.timeMapping || {},
      };
    });
    await API.putConfig("mapping.json", JSON.stringify(mappingById, null, 2));
  }
  async function persistCategorization() {
    await API.putConfig("categorization.json", JSON.stringify(mcpCategorization, null, 2));
  }
  async function persistKeywords() {
    // Keywords now live in llm.ini alongside the AI & Models fields — rebuild
    // the whole file so a per-server "Save Tab" on Keywords never clobbers
    // whatever's currently in the AI & Models fields (buildLlmIni() always
    // reads both live).
    await API.putConfig("llm.ini", buildLlmIni());
  }

  function renderServerList() {
    const list = $("mcp-server-list");
    if (!list) return;
    if (!mcpLoaded) {
      list.innerHTML = `<p class="text-muted" style="font-size:12px">Loading servers…</p>`;
      return;
    }
    if (mcpServers.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size:12px">No MCP servers configured yet. Click "Add MCP Server" to create one.</p>`;
      return;
    }
    const statusClass = s => s === "online" ? "connected" : s === "degraded" ? "degraded" : "offline";
    list.innerHTML = mcpServers.map(s => `
      <div class="mcp-server-card${s.enabled === false ? " mcp-server-disabled" : ""}" data-server="${s.id}">
        <div class="mcp-server-badge" style="background:${s.color || "#6366f1"}22;color:${s.color || "#6366f1"}">${esc(s.shortName || (s.name || "?").slice(0,2).toUpperCase())}</div>
        <div class="mcp-server-info">
          <p class="mcp-server-name">${esc(s.name || s.id)}</p>
          <p class="mcp-server-desc">${esc(s.description || s.baseUrl || "")}</p>
        </div>
        <span class="status-badge ${statusClass(s.status)}"><span class="dot"></span>${esc(s.mode === "onprem" ? "On-Prem" : "SaaS")}</span>
        <div class="mcp-server-actions">
          <button class="btn btn-ghost mcp-test-btn" data-server="${s.id}" style="font-size:11px"><i data-lucide="plug-zap" style="width:12px;height:12px"></i> Test Connection</button>
          <button class="toggle-switch mcp-enable-toggle${s.enabled !== false ? " on" : ""}" data-server="${s.id}" data-on="${s.enabled !== false}" title="${s.enabled !== false ? "Enabled" : "Disabled"}"><span class="toggle-thumb"></span></button>
          <button class="btn btn-ghost mcp-edit-btn" data-server="${s.id}" style="font-size:11px"><i data-lucide="settings-2" style="width:12px;height:12px"></i> Edit</button>
          <button class="btn btn-ghost mcp-delete-btn" data-server="${s.id}" style="font-size:11px;color:var(--destructive,#ef4444)"><i data-lucide="trash-2" style="width:12px;height:12px"></i></button>
        </div>
      </div>
    `).join("");
    list.querySelectorAll(".mcp-edit-btn").forEach(btn =>
      btn.addEventListener("click", () => openEditModal(btn.dataset.server, "details"))
    );
    list.querySelectorAll(".mcp-test-btn").forEach(btn =>
      btn.addEventListener("click", () => testServerConnection(btn.dataset.server))
    );
    list.querySelectorAll(".mcp-enable-toggle").forEach(btn =>
      btn.addEventListener("click", () => toggleServerEnabled(btn.dataset.server))
    );
    list.querySelectorAll(".mcp-delete-btn").forEach(btn =>
      btn.addEventListener("click", () => deleteServer(btn.dataset.server))
    );
    refreshIcons();
  }

  /**
   * Mocked connection check — mirrors the McpSampleHandler's own scope (no
   * real HTTP call to the server's baseUrl yet). Reuses the Mapping wizard's
   * sample endpoint as a stand-in "can we reach this source" probe: a real
   * sample coming back counts as reachable, the generic fallback stub counts
   * as unreachable.
   */
  async function testServerConnection(id) {
    const s = mcpServers.find(x => x.id === id);
    if (!s) return;
    const btn = document.querySelector(`.mcp-test-btn[data-server="${id}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = `<i data-lucide="loader-2" style="width:12px;height:12px;animation:spin 1s linear infinite"></i> Testing…`; refreshIcons(); }
    let ok = false;
    try {
      const res = await API.getMcpSample(s.type || s.id);
      ok = !!(res && res.sample && res.sample.id !== "SAMPLE-0000" && res.sample.id !== "SAMPLE-0001");
    } catch (e) {
      ok = false;
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = ok
        ? `<i data-lucide="check-circle-2" style="width:12px;height:12px;color:var(--success,#10b981)"></i> Reachable`
        : `<i data-lucide="x-circle" style="width:12px;height:12px;color:var(--destructive,#ef4444)"></i> No response`;
      refreshIcons();
      toast(ok ? `${s.name}: connection reachable.` : `${s.name}: no response from server.`, ok ? "success" : "error");
      setTimeout(() => {
        if (btn) { btn.innerHTML = `<i data-lucide="plug-zap" style="width:12px;height:12px"></i> Test Connection`; refreshIcons(); }
      }, 3000);
    }
  }

  /**
   * validateLlmModel()
   * Ollama-style check: hits {base URL}/api/tags and confirms the selected
   * model is actually present on that server before you rely on it for
   * chat completions. Any reachable-but-model-missing response is reported
   * as a failure too, not just outright network errors.
   */
  async function validateLlmModel() {
    const btn = $("btn-validate-model");
    const baseUrl = val("llm-url", "").trim();
    const model = val("llm-model", "").trim();
    if (!baseUrl) { toast("LLM Base URL is required before validating.", "error"); return; }

    if (btn) { btn.disabled = true; btn.innerHTML = `<i data-lucide="loader-2" style="width:12px;height:12px;animation:spin 1s linear infinite"></i> Validating…`; refreshIcons(); }

    let ok = false, reason = "";
    try {
      const res = await fetch(baseUrl.replace(/\/+$/, "") + "/api/tags", { method: "GET" });
      if (!res.ok) {
        reason = `server responded ${res.status}`;
      } else {
        const data = await res.json();
        const names = (data.models || []).map(m => m.name || m.model || "");
        ok = names.some(n => n === model || n.split(":")[0] === model.split(":")[0]);
        if (!ok) reason = `"${model}" not found on that server`;
      }
    } catch (e) {
      reason = "unreachable";
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = ok
        ? `<i data-lucide="check-circle-2" style="width:12px;height:12px;color:var(--success,#10b981)"></i> Validated`
        : `<i data-lucide="x-circle" style="width:12px;height:12px;color:var(--destructive,#ef4444)"></i> Failed`;
      refreshIcons();
      setTimeout(() => {
        if (btn) { btn.innerHTML = `<i data-lucide="plug-zap" style="width:12px;height:12px"></i> Validate Model`; refreshIcons(); }
      }, 3000);
    }
    toast(ok ? `Model "${model}" is available at ${baseUrl}.` : `Validation failed: ${reason}.`, ok ? "success" : "error");
  }

  /**
   * testRagConnectivity()
   * Pings the RAG service Base URL directly from the browser. Any response
   * at all (even a non-2xx one, since a lot of these services don't expose
   * a dedicated health route) counts as "reachable" — only a network-level
   * failure (refused/timed out/unresolvable) counts as unreachable.
   */
  async function testRagConnectivity() {
    const btn = $("btn-test-rag");
    const baseUrl = val("rag-base-url", "").trim();
    if (!baseUrl) { toast("RAG Base URL is required before testing.", "error"); return; }

    if (btn) { btn.disabled = true; btn.innerHTML = `<i data-lucide="loader-2" style="width:12px;height:12px;animation:spin 1s linear infinite"></i> Testing…`; refreshIcons(); }

    let ok = false;
    try {
      await fetch(baseUrl, { method: "GET", mode: "no-cors" });
      // With mode:"no-cors" a resolved promise means the request reached
      // the server (opaque response) — a rejected one means it didn't.
      ok = true;
    } catch (e) {
      ok = false;
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = ok
        ? `<i data-lucide="check-circle-2" style="width:12px;height:12px;color:var(--success,#10b981)"></i> Reachable`
        : `<i data-lucide="x-circle" style="width:12px;height:12px;color:var(--destructive,#ef4444)"></i> No response`;
      refreshIcons();
      setTimeout(() => {
        if (btn) { btn.innerHTML = `<i data-lucide="plug-zap" style="width:12px;height:12px"></i> Test Connectivity`; refreshIcons(); }
      }, 3000);
    }
    toast(ok ? `RAG service reachable at ${baseUrl}.` : `RAG service unreachable at ${baseUrl}.`, ok ? "success" : "error");
  }

  async function toggleServerEnabled(id) {
    const s = mcpServers.find(x => x.id === id);
    if (!s) return;
    s.enabled = s.enabled === false ? true : false;
    await persistServers();
    renderServerList();
    toast(`${s.name} ${s.enabled ? "enabled" : "disabled"}.`, "info");
  }

  // ── Add Server modal ─────────────────────────────────────────────────────


  function openAddModal() {
    addCertAcked = false;
    addRegistryPaths = [];
    ["mcp-add-name","mcp-add-type","mcp-add-baseurl","mcp-add-token"].forEach(id => { const el = $(id); if (el) el.value = ""; });
    const timeoutEl = $("mcp-add-timeout"); if (timeoutEl) timeoutEl.value = "30";
    const certStatus = $("mcp-add-cert-status"); if (certStatus) certStatus.textContent = "";
    const registryInput = $("mcp-add-registry"); if (registryInput) registryInput.value = "";
    const registryStatus = $("mcp-add-registry-status"); if (registryStatus) registryStatus.textContent = "";
    const registryFetchStatus = $("mcp-add-registry-fetch-status"); if (registryFetchStatus) registryFetchStatus.textContent = "";
    const registryUrlPreview = $("mcp-add-registry-url-preview"); if (registryUrlPreview) registryUrlPreview.textContent = "";
    const registryPayload = $("mcp-add-registry-payload"); if (registryPayload) registryPayload.value = "";
    const registryToggle = $("mcp-add-registry-payload-toggle");
    if (registryToggle) { registryToggle.dataset.on = "false"; registryToggle.classList.remove("on"); registryToggle.disabled = true; }
    $("mcp-add-registry-payload-wrap")?.classList.add("hidden");
    const vendorSel = $("mcp-add-vendor"); if (vendorSel) vendorSel.value = "dynatrace";
    $("mcp-add-custom-type-wrap")?.classList.add("hidden");
    const pathSel = $("mcp-add-registry-path");
    if (pathSel) { pathSel.innerHTML = registryPathOptionsHtml([], null); pathSel.disabled = true; }
    const modeSeg = $("mcp-add-mode");
    if (modeSeg) modeSeg.querySelectorAll(".seg-btn").forEach((b,i) => b.classList.toggle("active", i === 0));
    $("mcp-add-modal")?.classList.remove("hidden");
  }
  function closeAddModal() { $("mcp-add-modal")?.classList.add("hidden"); }

  async function saveNewServer() {
    const name = val("mcp-add-name", "").trim();
    const baseUrl = val("mcp-add-baseurl", "").trim();
    if (!name) { toast("Server Name is required.", "error"); return; }
    if (baseUrl && !/^https?:\/\/.+/.test(baseUrl)) { toast("Base URL must start with http:// or https://", "error"); return; }

    const vendor = val("mcp-add-vendor", "dynatrace");
    const customType = val("mcp-add-type", "").trim();
    if (vendor === "custom" && !customType) { toast("Custom Tool Name is required when Type/Vendor is Custom Tool.", "error"); return; }
    const type = vendor === "custom" ? customType : vendor;

    if (addRegistryPaths.length > 0) {
      const chosenPath = val("mcp-add-registry-path", "");
      if (!chosenPath) { toast("Registry Path for Fetching Issues is required once a Tool Registry is uploaded.", "error"); return; }
    }

    let id = slugify(name);
    if (mcpServers.some(s => s.id === id)) id = `${id}-${Date.now().toString().slice(-4)}`;

    const mapping = {};
    CANONICAL_FIELDS.forEach(f => { mapping[f.key] = null; });

    const server = {
      id,
      name,
      shortName: name.slice(0, 2).toUpperCase(),
      color: "#6366f1",
      type,
      vendor,
      mode: activeSegValue("mcp-add-mode") || "saas",
      baseUrl,
      endpoint: "",
      timeout: parseInt(val("mcp-add-timeout", "30"), 10) || 30,
      collection: "file",
      dataFile: "backend/data/all_issues.json",
      enabled: true,
      status: "online",
      latency: "—",
      description: "",
      url: baseUrl,
      certUploaded: addCertAcked,
      registry: addRegistryPaths.length > 0
        ? {
            url: val("mcp-add-registry-url", "").trim(),
            usesPayload: $("mcp-add-registry-payload-toggle")?.dataset.on === "true",
            payload: val("mcp-add-registry-payload", ""),
            fileName: $("mcp-add-registry")?.files?.[0]?.name || "",
            paths: addRegistryPaths.slice(),
          }
        : null,
      issuesRegistryPath: addRegistryPaths.length > 0 ? val("mcp-add-registry-path", "") : null,
      mapping,
      timeMapping: {},
      dashboards: {
        issuesPath: addRegistryPaths.length > 0 ? val("mcp-add-registry-path", "") : null,
        infrastructure: null,
        networkDevices: null,
        services: null,
        topology: null,
      },
      sample: null,
    };

    mcpServers.push(server);
    mcpKeywords[id] = mcpKeywords[id] || [];
    mcpCategorization.categories.forEach(c => {
      c.keywordsBySource = c.keywordsBySource || {};
      if (!c.keywordsBySource[id]) c.keywordsBySource[id] = [];
    });

    await persistServers();
    await persistCategorization();
    await persistKeywords();
    renderServerList();
    closeAddModal();
    toast(`${name} added.`, "success");
  }

  // ── Edit Server modal ────────────────────────────────────────────────────

  function getEditingServer() { return mcpServers.find(s => s.id === editingServerId) || null; }

  function openEditModal(id, tab = "details") {
    editingServerId = id;
    editingTab = tab;
    editCertAcked = false;
    const s = getEditingServer();
    if (!s) return;
    const titleEl = $("mcp-edit-title");
    if (titleEl) titleEl.textContent = `Edit — ${s.name}`;
    $("mcp-edit-tabs")?.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.editTab === tab));
    renderEditTabBody();
    $("mcp-edit-modal")?.classList.remove("hidden");
  }
  function closeEditModal() { $("mcp-edit-modal")?.classList.add("hidden"); editingServerId = null; }

  function switchEditTab(tab) {
    editingTab = tab;
    $("mcp-edit-tabs")?.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.editTab === tab));
    renderEditTabBody();
  }

  function renderEditTabBody() {
    const body = $("mcp-edit-body");
    const s = getEditingServer();
    if (!body || !s) return;
    if (editingTab === "details")        body.innerHTML = detailsTabHtml(s);
    else if (editingTab === "mapping")    body.innerHTML = mappingTabHtml(s);
    else if (editingTab === "categorization") body.innerHTML = categorizationTabHtml(s);
    else if (editingTab === "time")       body.innerHTML = timeTabHtml(s);
    else if (editingTab === "keywords")   body.innerHTML = keywordsTabHtml(s);
    else if (editingTab === "dashboards") body.innerHTML = dashboardsTabHtml(s);
    wireEditTabBody(s);
    refreshIcons();
  }

  function detailsTabHtml(s) {
    const vendor = s.vendor || (VENDOR_OPTIONS.some(v => v.id === s.type) ? s.type : "custom");
    const paths = editRegistryPaths[s.id] || (s.registry?.paths || []);
    return `
      <div class="grid-2">
        <label class="sfield"><span class="sfield-label">Server Name</span><input id="edit-name" type="text" class="input" value="${esc(s.name)}" /></label>
        <label class="sfield"><span class="sfield-label">Type / Vendor</span>
          <select id="edit-vendor" class="select">
            ${VENDOR_OPTIONS.map(v => `<option value="${v.id}"${v.id === vendor ? " selected" : ""}>${esc(v.label)}</option>`).join("")}
          </select>
        </label>
        <label class="sfield${vendor === "custom" ? "" : " hidden"}" id="edit-custom-type-wrap"><span class="sfield-label">Custom Tool Name</span><input id="edit-type" type="text" class="input" value="${esc(s.type || "")}" /></label>
        <label class="sfield"><span class="sfield-label">Deployment</span>
          <div class="segmented" id="edit-mode">
            <button class="seg-btn${s.mode !== "onprem" ? " active" : ""}" data-val="saas">SaaS</button>
            <button class="seg-btn${s.mode === "onprem" ? " active" : ""}" data-val="onprem">On-Prem</button>
          </div>
        </label>
        <label class="sfield"><span class="sfield-label">Base URL</span><input id="edit-baseurl" type="text" class="input input-mono" value="${esc(s.baseUrl || "")}" /></label>
        <label class="sfield"><span class="sfield-label">Auth Token</span><input id="edit-token" type="password" class="input input-mono" placeholder="unchanged" /></label>
        <label class="sfield"><span class="sfield-label">Timeout (s)</span><input id="edit-timeout" type="number" class="input input-mono" value="${s.timeout ?? 30}" /></label>
      </div>
      <div class="sfield mt-2">
        <span class="sfield-label">Security Certificate</span>
        <span class="sfield-hint">${s.certUploaded ? "A certificate is on file for this server." : "Only needed if the server presents a self-signed / private CA certificate."}</span>
        <div class="flex gap-2 items-center mt-1">
          <input id="edit-cert" type="file" class="input" style="max-width:260px" />
          <span id="edit-cert-status" class="text-muted" style="font-size:11px"></span>
        </div>
      </div>
      <div class="sfield mt-2">
        <span class="sfield-label">Tool Registry Endpoint</span>
        <span class="sfield-hint">${s.registry?.url ? `On file: <strong>${esc(s.registry.url)}</strong> → fetched from <strong>${esc(combineRegistryUrlForDisplay(s.baseUrl, s.registry.url))}</strong>. Change to replace it.` : "Enter just the path (e.g. <code>/api/tools</code>) — it's appended to this server's Base URL above. Or skip this and upload a registry document below instead."}</span>
        <input id="edit-registry-url" type="text" class="input input-mono" placeholder="/api/tools" value="${esc(s.registry?.url || "")}" />
        <span class="text-muted" id="edit-registry-url-preview" style="font-size:11px"></span>
      </div>
      <div class="toggle-row" id="edit-registry-payload-row">
        <div class="toggle-info">
          <p class="toggle-label">This fetch needs a payload</p>
          <p class="toggle-desc">Turn on if the endpoint requires a request body to return the registry. Enter a URL above to enable this.</p>
        </div>
        <button class="toggle-switch${s.registry?.usesPayload ? " on" : ""}" id="edit-registry-payload-toggle" data-on="${s.registry?.usesPayload ? "true" : "false"}"${s.registry?.url ? "" : " disabled"}><span class="toggle-thumb"></span></button>
      </div>
      <div class="sfield mt-2${s.registry?.usesPayload && s.registry?.url ? "" : " hidden"}" id="edit-registry-payload-wrap">
        <span class="sfield-label">Payload</span>
        <span class="sfield-hint">Sent as the request body when fetching the registry (raw JSON or text).</span>
        <textarea id="edit-registry-payload" class="input input-mono" rows="4" placeholder='{ "key": "value" }'>${esc(s.registry?.payload || "")}</textarea>
      </div>
      <div class="sfield mt-2">
        <div class="flex gap-2 items-center">
          <button class="btn btn-ghost" id="edit-registry-fetch" type="button" style="font-size:11px">
            <i data-lucide="download" style="width:12px;height:12px"></i> Fetch Tool Registry
          </button>
          <span class="text-muted" style="font-size:11px">— or —</span>
          <input id="edit-registry" type="file" class="input" style="max-width:220px" />
        </div>
        <span id="edit-registry-status" class="text-muted" style="font-size:11px">${s.registry?.fileName ? `On file: ${esc(s.registry.fileName)} (${paths.length} path${paths.length === 1 ? "" : "s"})` : ""}</span>
        <span id="edit-registry-fetch-status" class="text-muted" style="font-size:11px"></span>
      </div>
      <label class="sfield mt-2">
        <span class="sfield-label">Registry Path for Fetching Issues <span style="color:var(--accent-red)">*</span></span>
        <span class="sfield-hint">Required once a Tool Registry is uploaded or fetched.</span>
        <select id="edit-registry-path" class="select"${paths.length === 0 ? " disabled" : ""}>
          ${registryPathOptionsHtml(paths, s.issuesRegistryPath)}
        </select>
      </label>
    `;
  }

  function mappingTabHtml(s) {
    const flat = s.sample ? flattenSample(s.sample) : null;
    const keys = flat ? Object.keys(flat) : [];
    return `
      <div class="banner banner-info mb-3">
        <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
        <span class="banner-text">Fetch a sample issue to see this server's raw field names, then map each canonical field below. Leave a field unmapped if this server doesn't provide it.</span>
      </div>
      <div class="flex gap-2 items-center mb-3">
        <button class="btn btn-ghost" id="btn-fetch-sample" style="font-size:11px"><i data-lucide="download" style="width:12px;height:12px"></i> Fetch Sample Issue</button>
        <span class="text-muted" style="font-size:11px">${flat ? `${keys.length} fields found in last sample` : "No sample fetched yet"}</span>
      </div>
      <div class="grid-2">
        ${CANONICAL_FIELDS.map(f => {
          const current = s.mapping?.[f.key] ?? "";
          const options = keys.length
            ? keys.map(k => `<option value="${esc(k)}"${k === current ? " selected" : ""}>${esc(k)}</option>`).join("")
            : (current ? `<option value="${esc(current)}" selected>${esc(current)}</option>` : "");
          return `
          <label class="sfield">
            <span class="sfield-label">${esc(f.label)}</span>
            <span class="sfield-hint" style="font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)">canonical: <strong>${f.key}</strong></span>
            <select class="select" id="map-${f.key}"${keys.length === 0 && !current ? " disabled" : ""}>
              <option value="">— Not mapped —</option>
              ${options}
            </select>
          </label>
        `;
        }).join("")}
      </div>
    `;
  }

  function categorizationTabHtml(s) {
    const cats = [...mcpCategorization.categories].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    return `
      <div class="banner banner-info mb-3">
        <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
        <span class="banner-text">
          Categories are shared across servers; the keywords below are specific to <strong>${esc(s.name)}</strong>.
          An issue's title is checked against this server's keywords first (in priority order below); if nothing matches,
          all servers' keywords for each category are checked; if still nothing matches, the issue falls into
          "${esc(mcpCategorization.unknownLabel || "Unknown")}".
        </span>
      </div>
      <div class="sfield mb-3">
        <span class="sfield-label">Add Category</span>
        <span class="sfield-hint">New categories are shared across every server — this adds an empty bucket that any server can then attach its own keywords to below.</span>
        <div class="flex gap-2 items-center mt-1">
          <input type="text" class="input input-mono" id="mcp-cat-new-name" placeholder="e.g. Database" style="max-width:220px" />
          <button class="btn btn-ghost" id="mcp-cat-add-btn" type="button" style="font-size:11px"><i data-lucide="plus" style="width:12px;height:12px"></i> Add Category</button>
        </div>
        <span id="mcp-cat-add-status" class="text-muted" style="font-size:11px"></span>
      </div>
      ${cats.map(c => {
        const kws = (c.keywordsBySource && c.keywordsBySource[s.id]) || [];
        return `
          <div class="mcp-cat-block" data-cat="${c.id}">
            <div class="mcp-cat-block-head flex items-center gap-2">
              <span class="mcp-cat-priority">#${c.priority ?? "—"}</span>
              <h4 class="mcp-cat-name">${esc(c.name)}</h4>
              <span class="text-muted" style="font-size:11px">${kws.length} keyword${kws.length === 1 ? "" : "s"}</span>
              <button class="btn btn-ghost mcp-cat-delete-btn" data-cat="${c.id}" data-name="${esc(c.name)}" type="button" title="Delete category" style="font-size:11px;color:var(--destructive,#ef4444);margin-left:auto"><i data-lucide="trash-2" style="width:12px;height:12px"></i></button>
            </div>
            <div class="flex flex-wrap gap-1 mb-2">
              ${kws.length === 0
                ? `<span class="text-muted" style="font-size:11px">No keywords for this server yet.</span>`
                : kws.map(k => `<span class="kw-chip">${esc(k)}<button class="kw-remove mcp-cat-kw-remove" data-cat="${c.id}" data-kw="${esc(k)}"><i data-lucide="x" style="width:10px;height:10px"></i></button></span>`).join("")}
            </div>
            <div class="flex gap-2">
              <input type="text" class="input input-mono mcp-cat-kw-input" data-cat="${c.id}" placeholder="Add keyword…" style="max-width:220px" />
              <button class="btn btn-ghost mcp-cat-kw-add" data-cat="${c.id}" style="font-size:11px"><i data-lucide="plus" style="width:12px;height:12px"></i> Add</button>
            </div>
          </div>
        `;
      }).join("")}
    `;
  }

  // Adds a new shared category (name only — the admin attaches keywords
  // per server afterwards, same as any pre-existing category). Priority
  // is appended to the end of the current ordering so nothing already
  // defined shifts. Every existing server gets an empty keyword bucket
  // for it so the per-server tab can render immediately, mirroring what
  // addServer() does for existing categories.
  function addCategory(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return { ok: false, error: "Enter a category name." };
    const dupe = mcpCategorization.categories.some(c => c.name.toLowerCase() === trimmed.toLowerCase());
    if (dupe) return { ok: false, error: `"${trimmed}" already exists.` };

    let id = slugify(trimmed);
    if (mcpCategorization.categories.some(c => c.id === id)) id = `${id}-${Date.now().toString().slice(-4)}`;
    const nextPriority = mcpCategorization.categories.reduce((max, c) => Math.max(max, c.priority ?? 0), 0) + 1;

    const keywordsBySource = {};
    mcpServers.forEach(srv => { keywordsBySource[srv.id] = []; });

    mcpCategorization.categories.push({ id, name: trimmed, priority: nextPriority, keywordsBySource });
    return { ok: true };
  }

  function deleteCategory(id) {
    mcpCategorization.categories = mcpCategorization.categories.filter(c => c.id !== id);
  }

  // ── Time Mapping helpers ──────────────────────────────────────────────
  // Splits a generalized timestamp format (from Settings ▸ General ▸
  // Dashboard Defaults ▸ Generalized Timestamp Format) into its ordered
  // component tokens, e.g. "YYYY-MM-DD HH:mm:ss" → ["YYYY","MM","DD","HH","mm","ss"].
  // Epoch formats are treated as a single token.
  const TIME_TOKEN_REGEX = /YYYY|YY|MM|DD|HH|hh|mm|ss|A|Z|T/g;

  const TIME_TOKEN_META = {
    YYYY: { label: "Year (4-digit)",   isTime: false },
    YY:   { label: "Year (2-digit)",   isTime: false },
    MM:   { label: "Month",            isTime: false },
    DD:   { label: "Day",              isTime: false },
    HH:   { label: "Hour (24h)",       isTime: true  },
    hh:   { label: "Hour (12h)",       isTime: true  },
    mm:   { label: "Minute",           isTime: true  },
    ss:   { label: "Second",           isTime: true  },
    A:    { label: "AM/PM",            isTime: true  },
    Z:    { label: "Timezone offset",  isTime: false },
    T:    { label: "Date/time separator", isTime: false },
  };

  // Options offered in each mapping dropdown: the server's own raw
  // timestamp component types it could supply for this generalized slot,
  // plus the two hard defaults.
  const SERVER_TOKEN_OPTIONS = [
    { value: "server_YYYY", label: "Server field: Year (4-digit)" },
    { value: "server_YY",   label: "Server field: Year (2-digit)" },
    { value: "server_MM",   label: "Server field: Month (numeric)" },
    { value: "server_MMM",  label: "Server field: Month (name)" },
    { value: "server_DD",   label: "Server field: Day" },
    { value: "server_HH",   label: "Server field: Hour (24h)" },
    { value: "server_hh",   label: "Server field: Hour (12h)" },
    { value: "server_A",    label: "Server field: AM/PM" },
    { value: "server_mm",   label: "Server field: Minute" },
    { value: "server_ss",   label: "Server field: Second" },
    { value: "server_epoch_s",  label: "Server field: Epoch seconds" },
    { value: "server_epoch_ms", label: "Server field: Epoch milliseconds" },
    { value: "default_00",  label: "00 (default)" },
    { value: "default_now", label: "System/Server current (default)" },
  ];

  function generalizedTimestampFormat() {
    return ($("dash-timestamp-format")?.value || "YYYY-MM-DD HH:mm:ss").trim();
  }

  function timestampTokens(format) {
    if (format === "epoch_s")  return ["epoch_s"];
    if (format === "epoch_ms") return ["epoch_ms"];
    const found = format.match(TIME_TOKEN_REGEX) || [];
    // De-dupe while preserving first-seen order (e.g. "YYYY" appearing once).
    const seen = new Set();
    return found.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
  }

  function defaultTokenMapping(tokens) {
    const map = {};
    tokens.forEach(t => {
      if (t === "epoch_s" || t === "epoch_ms") { map[t] = "default_now"; return; }
      const meta = TIME_TOKEN_META[t];
      map[t] = meta && meta.isTime ? "default_00" : "default_now";
    });
    return map;
  }

  function timeTabHtml(s) {
    const format = generalizedTimestampFormat();
    const tokens = timestampTokens(format);
    if (!editTimeMapping[s.id] || editTimeMapping[s.id].format !== format) {
      editTimeMapping[s.id] = {
        format,
        tokens: { ...defaultTokenMapping(tokens), ...(editTimeMapping[s.id]?.tokens || {}) },
      };
    }
    const mapping = editTimeMapping[s.id].tokens;
    return `
      <div class="banner banner-info mb-3">
        <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
        <span class="banner-text">
          Generalized timestamp: <strong>${esc(format)}</strong> (set in General ▸ Dashboard Defaults).
          Map each part below onto what <strong>${esc(s.name)}</strong> actually provides. Time parts default to
          <strong>00</strong>; date parts default to <strong>System/Server current</strong>.
        </span>
      </div>
      <div class="grid-2">
        ${tokens.map(t => `
          <label class="sfield">
            <span class="sfield-label">${esc(t)}${TIME_TOKEN_META[t] ? ` — ${esc(TIME_TOKEN_META[t].label)}` : ""}</span>
            <select class="select time-map-select" data-token="${esc(t)}">
              ${SERVER_TOKEN_OPTIONS.map(o => `<option value="${o.value}"${o.value === mapping[t] ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
            </select>
          </label>
        `).join("")}
      </div>
    `;
  }

  function keywordsTabHtml(s) {
    const kws = mcpKeywords[s.id] || [];
    return `
      <div class="banner banner-info mb-3">
        <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
        <span class="banner-text">Keywords used by the AI chat's intent detection to decide when a query is about <strong>${esc(s.name)}</strong>.</span>
      </div>
      <div class="flex flex-wrap gap-1 mb-2" id="mcp-kw-chips">
        ${kws.length === 0
          ? `<span class="text-muted" style="font-size:11px">No keywords yet.</span>`
          : kws.map(k => `<span class="kw-chip">${esc(k)}<button class="kw-remove mcp-kw-remove" data-kw="${esc(k)}"><i data-lucide="x" style="width:10px;height:10px"></i></button></span>`).join("")}
      </div>
      <div class="flex gap-2">
        <input type="text" class="input input-mono" id="mcp-kw-input" placeholder="Add keyword…" style="max-width:240px" />
        <button class="btn btn-ghost" id="mcp-kw-add" style="font-size:11px"><i data-lucide="plus" style="width:12px;height:12px"></i> Add</button>
      </div>
    `;
  }

  // Fields on the Dashboards tab: which of this server's registry paths
  // feeds each dashboard page. Issues Path/Registry / Infrastructure /
  // Network Devices / Services are required; Topology is optional.
  const DASHBOARD_FIELDS = [
    { key: "issuesPath",      label: "Issues Path / Registry", required: true  },
    { key: "infrastructure",  label: "Infrastructure",         required: true  },
    { key: "networkDevices",  label: "Network Devices",        required: true  },
    { key: "services",        label: "Services",                required: true  },
    { key: "processes",       label: "Processes",               required: true  },
    { key: "topology",        label: "Topology",                required: false },
  ];

  function dashboardsTabHtml(s) {
    const paths = editRegistryPaths[s.id] || (s.registry?.paths || []);
    s.dashboards = s.dashboards || {};
    return `
      <div class="banner banner-info mb-3">
        <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
        <span class="banner-text">Pick which registry path (from this server's Tool Registry, set on the Server Details tab) feeds each dashboard page. All but Topology are required.</span>
      </div>
      <div class="grid-2">
        ${DASHBOARD_FIELDS.map(f => `
          <label class="sfield">
            <span class="sfield-label">${esc(f.label)}${f.required ? ` <span style="color:var(--accent-red)">*</span>` : " (optional)"}</span>
            <select class="select" id="dash-${f.key}"${paths.length === 0 ? " disabled" : ""}>
              ${registryPathOptionsHtml(paths, s.dashboards[f.key])}
            </select>
          </label>
        `).join("")}
      </div>
      ${paths.length === 0 ? `<div class="banner banner-warn mt-3"><i data-lucide="alert-triangle" style="width:16px;height:16px;flex-shrink:0"></i><span class="banner-text">Upload a Tool Registry on the Server Details tab first — these dropdowns populate from it.</span></div>` : ""}
    `;
  }

  function wireEditTabBody(s) {
    if (editingTab === "details") {
      const certInput = $("edit-cert");
      if (certInput) certInput.addEventListener("change", () => {
        editCertAcked = certInput.files && certInput.files.length > 0;
        const status = $("edit-cert-status");
        if (status) status.textContent = editCertAcked ? "Certificate added ✓ (saved with this server on Save)" : "";
      });
      const vendorSel = $("edit-vendor");
      if (vendorSel) vendorSel.addEventListener("change", () => {
        $("edit-custom-type-wrap")?.classList.toggle("hidden", vendorSel.value !== "custom");
      });
      const registryInput = $("edit-registry");
      updateRegistryPayloadToggleState("edit-registry-url", "edit-registry-payload-toggle", "edit-registry-payload-wrap");
      // File upload is an independent OR path — parses on choose,
      // regardless of the URL/payload toggle state.
      if (registryInput) registryInput.addEventListener("change", async () => {
        const file = registryInput.files && registryInput.files[0];
        const status = $("edit-registry-status");
        if (!file) return;
        const text = await file.text();
        editRegistryPaths[s.id] = parseRegistryFile(text);
        if (status) status.textContent = `Registry parsed ✓ (${editRegistryPaths[s.id].length} paths found — saved on Save)`;
        // Update the Registry Path select in place — avoid a full
        // renderEditTabBody() here, which would discard any unsaved edits
        // the user has already typed into this tab's other fields.
        const pathSel = $("edit-registry-path");
        if (pathSel) {
          pathSel.innerHTML = registryPathOptionsHtml(editRegistryPaths[s.id], null);
          pathSel.disabled = editRegistryPaths[s.id].length === 0;
        }
      });
      $("edit-registry-url")?.addEventListener("input", () => {
        updateRegistryPayloadToggleState("edit-registry-url", "edit-registry-payload-toggle", "edit-registry-payload-wrap");
        const preview = $("edit-registry-url-preview");
        if (preview) {
          const combined = combineRegistryUrlForDisplay(val("edit-baseurl", s.baseUrl || ""), val("edit-registry-url", ""));
          preview.textContent = combined ? `→ ${combined}` : "";
        }
      });
      $("edit-registry-payload-toggle")?.addEventListener("click", (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        const on = btn.dataset.on !== "true";
        btn.dataset.on = String(on);
        btn.classList.toggle("on", on);
        $("edit-registry-payload-wrap")?.classList.toggle("hidden", !on);
      });
      $("edit-registry-fetch")?.addEventListener("click", async () => {
        const btn = $("edit-registry-fetch");
        const status = $("edit-registry-fetch-status");
        const path = ($("edit-registry-url")?.value || "").trim();
        if (!path) { if (status) status.textContent = "Enter a Tool Registry Endpoint path first."; return; }
        const payloadToggle = $("edit-registry-payload-toggle");
        const usePayload = payloadToggle && payloadToggle.dataset.on === "true";
        const payload = usePayload ? ($("edit-registry-payload")?.value || "") : "";
        if (btn) { btn.disabled = true; btn.textContent = "Fetching…"; }
        try {
          editRegistryPaths[s.id] = await fetchRegistryFromUrl(val("edit-baseurl", s.baseUrl || ""), path, val("edit-token", ""), payload || undefined);
          if (status) status.textContent = `Registry fetched ✓ (${editRegistryPaths[s.id].length} paths found — saved on Save)`;
        } catch (err) {
          if (status) status.textContent = `Fetch failed: ${err.message || err}`;
        } finally {
          if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="download" style="width:12px;height:12px"></i> Fetch Tool Registry`; refreshIcons(); }
        }
        const pathSel = $("edit-registry-path");
        if (pathSel) {
          pathSel.innerHTML = registryPathOptionsHtml(editRegistryPaths[s.id] || [], null);
          pathSel.disabled = !editRegistryPaths[s.id] || editRegistryPaths[s.id].length === 0;
        }
      });
    } else if (editingTab === "time") {
      $("mcp-edit-body").querySelectorAll(".time-map-select").forEach(sel => {
        sel.addEventListener("change", () => {
          editTimeMapping[s.id] = editTimeMapping[s.id] || { format: generalizedTimestampFormat(), tokens: {} };
          editTimeMapping[s.id].tokens[sel.dataset.token] = sel.value;
        });
      });
    } else if (editingTab === "mapping") {
      $("btn-fetch-sample")?.addEventListener("click", async () => {
        const btn = $("btn-fetch-sample");
        if (btn) { btn.disabled = true; btn.textContent = "Fetching…"; }
        const res = await API.getMcpSample(s.type || s.id);
        s.sample = res?.sample || null;
        renderEditTabBody();
      });
    } else if (editingTab === "categorization") {
      const addCatBtn   = $("mcp-cat-add-btn");
      const addCatInput = $("mcp-cat-new-name");
      const addCatStatus = $("mcp-cat-add-status");
      const runAddCategory = () => {
        const res = addCategory(addCatInput?.value);
        if (!res.ok) { if (addCatStatus) addCatStatus.textContent = res.error; return; }
        renderEditTabBody();
      };
      if (addCatBtn)   addCatBtn.addEventListener("click", runAddCategory);
      if (addCatInput) addCatInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); runAddCategory(); } });
      $("mcp-edit-body").querySelectorAll(".mcp-cat-delete-btn").forEach(btn =>
        btn.addEventListener("click", () => {
          if (!window.confirm(`Delete category "${btn.dataset.name}"? This removes its keywords for every server, not just ${s.name}.`)) return;
          deleteCategory(btn.dataset.cat);
          renderEditTabBody();
        })
      );
      $("mcp-edit-body").querySelectorAll(".mcp-cat-kw-remove").forEach(btn =>
        btn.addEventListener("click", () => {
          const cat = mcpCategorization.categories.find(c => c.id === btn.dataset.cat);
          if (!cat) return;
          cat.keywordsBySource[s.id] = (cat.keywordsBySource[s.id] || []).filter(k => k !== btn.dataset.kw);
          renderEditTabBody();
        })
      );
      $("mcp-edit-body").querySelectorAll(".mcp-cat-kw-add").forEach(btn =>
        btn.addEventListener("click", () => {
          const input = $("mcp-edit-body").querySelector(`.mcp-cat-kw-input[data-cat="${btn.dataset.cat}"]`);
          const v = (input?.value || "").trim().toLowerCase();
          if (!v) return;
          const cat = mcpCategorization.categories.find(c => c.id === btn.dataset.cat);
          if (!cat) return;
          cat.keywordsBySource[s.id] = cat.keywordsBySource[s.id] || [];
          if (!cat.keywordsBySource[s.id].includes(v)) cat.keywordsBySource[s.id].push(v);
          renderEditTabBody();
        })
      );
    } else if (editingTab === "keywords") {
      const addBtn = $("mcp-kw-add");
      const input  = $("mcp-kw-input");
      const add = () => {
        const v = (input?.value || "").trim();
        if (!v) return;
        mcpKeywords[s.id] = mcpKeywords[s.id] || [];
        if (!mcpKeywords[s.id].includes(v)) mcpKeywords[s.id].push(v);
        renderEditTabBody();
      };
      if (addBtn) addBtn.addEventListener("click", add);
      if (input)  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); add(); } });
      $("mcp-edit-body").querySelectorAll(".mcp-kw-remove").forEach(btn =>
        btn.addEventListener("click", () => {
          mcpKeywords[s.id] = (mcpKeywords[s.id] || []).filter(k => k !== btn.dataset.kw);
          renderEditTabBody();
        })
      );
    }
  }

  async function saveEditTab() {
    const s = getEditingServer();
    if (!s) return;
    const saveBtn = $("mcp-edit-save");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }

    if (editingTab === "details") {
      s.name     = val("edit-name", s.name).trim() || s.name;
      const vendor = val("edit-vendor", s.vendor || "custom");
      s.vendor   = vendor;
      s.type     = vendor === "custom" ? val("edit-type", s.type).trim() : vendor;
      s.mode     = activeSegValue("edit-mode") || s.mode;
      s.baseUrl  = val("edit-baseurl", s.baseUrl).trim();
      s.timeout  = parseInt(val("edit-timeout", s.timeout), 10) || s.timeout;
      if (editCertAcked) s.certUploaded = true;
      const editRegistryPayloadToggle = $("edit-registry-payload-toggle");
      if (editRegistryPaths[s.id]) {
        s.registry = {
          fileName: $("edit-registry")?.files?.[0]?.name || s.registry?.fileName || "",
          url: val("edit-registry-url", s.registry?.url || "").trim(),
          usesPayload: editRegistryPayloadToggle ? editRegistryPayloadToggle.dataset.on === "true" : !!s.registry?.usesPayload,
          payload: val("edit-registry-payload", s.registry?.payload || ""),
          paths: editRegistryPaths[s.id].slice(),
        };
      }
      const paths = editRegistryPaths[s.id] || (s.registry?.paths || []);
      if (paths.length > 0) {
        const chosenPath = val("edit-registry-path", "");
        if (!chosenPath) { toast("Registry Path for Fetching Issues is required once a Tool Registry is uploaded.", "error"); if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Tab"; } return; }
        s.issuesRegistryPath = chosenPath;
        s.dashboards = s.dashboards || {};
        s.dashboards.issuesPath = chosenPath;
      }
      await persistServers();
    } else if (editingTab === "time") {
      s.timeMapping = {
        format: editTimeMapping[s.id]?.format || generalizedTimestampFormat(),
        tokens: { ...(editTimeMapping[s.id]?.tokens || {}) },
      };
      await persistServers();
    } else if (editingTab === "mapping") {
      CANONICAL_FIELDS.forEach(f => {
        const v = val(`map-${f.key}`, "").trim();
        s.mapping[f.key] = v === "" ? null : v;
      });
      await persistServers();
    } else if (editingTab === "categorization") {
      await persistCategorization();
    } else if (editingTab === "keywords") {
      await persistKeywords();
    } else if (editingTab === "dashboards") {
      s.dashboards = s.dashboards || {};
      const missing = [];
      DASHBOARD_FIELDS.forEach(f => {
        const v = val(`dash-${f.key}`, "");
        if (f.required && !v) missing.push(f.label);
        s.dashboards[f.key] = v || null;
      });
      if (missing.length > 0) {
        toast(`These Dashboards-tab fields are required: ${missing.join(", ")}`, "error");
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Tab"; }
        return;
      }
      await persistServers();
    }
    // Time tab has nothing to persist.

    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Tab"; }
    renderServerList();
    toast(`${s.name}: ${editingTab} tab saved.`, "success");
  }

  async function deleteServer(id) {
    const s = mcpServers.find(x => x.id === id);
    if (!s) return;
    if (!window.confirm(`Delete "${s.name}"? This removes it from mcpconf.ini — its category/keyword entries are left in place.`)) return;
    mcpServers = mcpServers.filter(x => x.id !== id);
    await persistServers();
    closeEditModal();
    renderServerList();
    toast(`${s.name} deleted.`, "success");
  }

  function wireMcpEvents() {
    $("btn-add-mcp-server")?.addEventListener("click", openAddModal);
    $("mcp-add-close")?.addEventListener("click", closeAddModal);
    $("mcp-add-cancel")?.addEventListener("click", closeAddModal);
    $("mcp-add-save")?.addEventListener("click", saveNewServer);
    $("mcp-add-mode")?.querySelectorAll(".seg-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        $("mcp-add-mode").querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      })
    );
    $("mcp-add-cert")?.addEventListener("change", () => {
      const input = $("mcp-add-cert");
      addCertAcked = input.files && input.files.length > 0;
      const status = $("mcp-add-cert-status");
      if (status) status.textContent = addCertAcked ? "Certificate added ✓" : "";
    });
    $("mcp-add-vendor")?.addEventListener("change", () => {
      const vendorSel = $("mcp-add-vendor");
      $("mcp-add-custom-type-wrap")?.classList.toggle("hidden", vendorSel.value !== "custom");
    });
    // File upload is an independent OR path — parses on choose,
    // regardless of the URL/payload toggle state.
    $("mcp-add-registry")?.addEventListener("change", async () => {
      const input = $("mcp-add-registry");
      const file = input.files && input.files[0];
      const status = $("mcp-add-registry-status");
      if (!file) return;
      const text = await file.text();
      addRegistryPaths = parseRegistryFile(text);
      if (status) status.textContent = `Registry parsed ✓ (${addRegistryPaths.length} paths found)`;
      const pathSel = $("mcp-add-registry-path");
      if (pathSel) {
        pathSel.innerHTML = registryPathOptionsHtml(addRegistryPaths, null);
        pathSel.disabled = addRegistryPaths.length === 0;
      }
    });
    $("mcp-add-registry-url")?.addEventListener("input", () => {
      updateRegistryPayloadToggleState("mcp-add-registry-url", "mcp-add-registry-payload-toggle", "mcp-add-registry-payload-wrap");
      const preview = $("mcp-add-registry-url-preview");
      if (preview) {
        const combined = combineRegistryUrlForDisplay(val("mcp-add-baseurl", ""), val("mcp-add-registry-url", ""));
        preview.textContent = combined ? `→ ${combined}` : "";
      }
    });
    $("mcp-add-registry-payload-toggle")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const on = btn.dataset.on !== "true";
      btn.dataset.on = String(on);
      btn.classList.toggle("on", on);
      $("mcp-add-registry-payload-wrap")?.classList.toggle("hidden", !on);
    });
    $("mcp-add-registry-fetch")?.addEventListener("click", async () => {
      const btn = $("mcp-add-registry-fetch");
      const status = $("mcp-add-registry-fetch-status");
      const path = ($("mcp-add-registry-url")?.value || "").trim();
      if (!path) { if (status) status.textContent = "Enter a Tool Registry Endpoint path first."; return; }
      const payloadToggle = $("mcp-add-registry-payload-toggle");
      const usePayload = payloadToggle && payloadToggle.dataset.on === "true";
      const payload = usePayload ? ($("mcp-add-registry-payload")?.value || "") : "";
      if (btn) { btn.disabled = true; btn.textContent = "Fetching…"; }
      try {
        addRegistryPaths = await fetchRegistryFromUrl(val("mcp-add-baseurl", ""), path, val("mcp-add-token", ""), payload || undefined);
        if (status) status.textContent = `Registry fetched ✓ (${addRegistryPaths.length} paths found)`;
      } catch (err) {
        if (status) status.textContent = `Fetch failed: ${err.message || err}`;
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="download" style="width:12px;height:12px"></i> Fetch Tool Registry`; refreshIcons(); }
      }
      const pathSel = $("mcp-add-registry-path");
      if (pathSel) {
        pathSel.innerHTML = registryPathOptionsHtml(addRegistryPaths, null);
        pathSel.disabled = addRegistryPaths.length === 0;
      }
    });

    $("mcp-edit-close")?.addEventListener("click", closeEditModal);
    $("mcp-edit-cancel")?.addEventListener("click", closeEditModal);
    $("mcp-edit-save")?.addEventListener("click", saveEditTab);
    $("mcp-edit-tabs")?.querySelectorAll("[data-edit-tab]").forEach(btn =>
      btn.addEventListener("click", () => switchEditTab(btn.dataset.editTab))
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     10. GENERIC TOGGLE / SEGMENTED
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireToggle(btn) {
    btn.addEventListener("click", () => {
      const on = btn.dataset.on !== "true";
      btn.dataset.on = String(on);
      btn.classList.toggle("on", on);
      markDirty();
    });
  }

  function wireSegmented(el) {
    if (!el) return;
    el.querySelectorAll(".seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        el.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        markDirty();
      });
    });
  }

  function wireRange(inputId, labelId) {
    const input = $(inputId);
    const label = $(labelId);
    if (!input || !label) return;
    input.addEventListener("input", () => {
      const base = label.textContent.split(":")[0];
      label.textContent = `${base}: ${input.value}`;
      markDirty();
      if (inputId === "bm25-weight" || inputId === "sem-weight") updateWeightTotal();
    });
  }

  function updateWeightTotal() {
    const bm25 = parseFloat(val("bm25-weight", "0.4"));
    const sem  = parseFloat(val("sem-weight",  "0.6"));
    const totalEl = $("weight-total");
    if (totalEl) totalEl.textContent = (bm25 + sem).toFixed(2);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     11. Settings-page file builders (conf.properties / mcpconf.ini /
         capacity.ini / llm.ini / rag.ini / performance.ini / chat.ini)

     Rewritten so each settings-page section writes to its own,
     correctly-named file instead of everything being jammed into
     "mcpconf.properties" / "apmconf.properties" regardless of which
     section it actually belonged to (that mismatch was the root of
     "settings save in the wrong file" — mcpconf.properties held AI/RAG/
     Performance fields, and apmconf.properties held completely legacy,
     no-longer-live data from before the MCP Servers admin list existed).
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildConfProperties() {
    return [
      "# conf.properties — MCP Dashboard General Configuration",
      "# Auto-saved by Settings UI (General section)",
      "",
      "[logging]",
      `log_level      = ${val("log-level",    "INFO")}`,
      `log_file       = ${val("log-file",      "logs/agent.log")}`,
      `log_max_size   = ${val("log-max-size",  "10485760")}`,
      `log_backups    = ${val("log-backups",   "5")}`,
      "",
      "[dashboard]",
      `periodic_fetch_time = ${val("dash-fetch-time",  "15 min")}`,
      `periodic_check_time = ${val("dash-check-time",  "300")}`,
      `timestamp_format    = ${val("dash-timestamp-format", "YYYY-MM-DD HH:mm:ss")}`,
      "",
      "[infrastructure]",
      `periodic_fetch_time = ${val("infra-fetch-time", "15 min")}`,
      "",
      "[services]",
      `periodic_fetch_time = ${val("services-fetch-time", "15 min")}`,
      "",
      "[network_devices]",
      `periodic_fetch_time = ${val("network-devices-fetch-time", "15 min")}`,
      "",
      "[processes]",
      `periodic_fetch_time = ${val("processes-fetch-time", "15 min")}`,
      "",
      "[topology]",
      `periodic_fetch_time = ${val("topology-fetch-time", "15 min")}`,
    ].join("\n");
  }

  // llm.ini — AI & Models section fields + per-server Keywords tab data
  // (mcpKeywords, in-memory — merged in so both the master "Save Changes"
  // button and a per-server "Save Tab" on the Keywords tab always write the
  // complete, current file rather than clobbering whichever half they
  // didn't touch).
  function buildLlmIni() {
    const lines = [
      "# llm.ini — AI & Models Configuration",
      "# Auto-saved by Settings UI (AI & Models section + MCP Servers → Keywords tab)",
      "",
      "[llm]",
      `url              = ${val("llm-url",         "http://localhost:11434")}`,
      `model            = ${val("llm-model",       "qwen2.5")}`,
      `temperature      = ${val("llm-temp",        "0.2")}`,
      `max_tokens       = ${val("llm-max-tokens",  "2048")}`,
      `intent_mode      = ${activeSegValue("seg-intent") ?? "hybrid"}`,
      `confidence       = ${val("llm-confidence",  "0.7")}`,
      `timeout          = ${val("llm-timeout",     "15")}`,
      "",
      "[keywords]",
    ];
    Object.keys(mcpKeywords).forEach(serverId => {
      lines.push(`${serverId} = ${(mcpKeywords[serverId] || []).join(", ")}`);
    });
    return lines.join("\n");
  }

  function buildRagIni() {
    return [
      "# rag.ini — Retrieval (RAG) Configuration",
      "# Auto-saved by Settings UI (Retrieval (RAG) section)",
      "",
      "[server]",
      `base_url         = ${val("rag-base-url",    "http://localhost:8000")}`,
      `data_endpoint    = ${val("rag-data-ep",     "/data")}`,
      `ask_endpoint     = ${val("rag-ask-ep",      "/ask")}`,
      `metadata_file    = ${val("rag-meta",        "metadata.json")}`,
      `timeout          = ${val("rag-timeout",     "30")}`,
      "",
      "[storage]",
      `upload_folder    = ${val("rag-upload-folder",    "storage/uploads")}`,
      `vector_store     = ${val("rag-vector-store",     "storage/vectors")}`,
      `bm25_store       = ${val("rag-bm25-store",       "storage/bm25")}`,
      "",
      "[config_paths]",
      `instructions_file = ${val("rag-instructions-file", "config/instructions.md")}`,
      `faq_file          = ${val("rag-faq-file",          "config/faq.json")}`,
      `settings_file     = ${val("rag-settings-file",     "config/settings.yaml")}`,
      "",
      "[search]",
      `embed_model    = ${val("embed-model",    "bge-small-en-v1.5")}`,
      `chunk_size     = ${val("chunk-size",     "512")}`,
      `chunk_overlap  = ${val("chunk-overlap",  "64")}`,
      `top_k          = ${val("top-k",          "8")}`,
      `bm25_weight    = ${val("bm25-weight",    "0.4")}`,
      `sem_weight     = ${val("sem-weight",     "0.6")}`,
      `rerank_enabled = ${toggleOn("toggle-rerank")}`,
      `rerank_model   = ${val("rerank-model",   "bge-reranker-base")}`,
      `top_n          = ${val("top-n",          "3")}`,
      "",
      "[cache]",
      `enabled         = ${toggleOn("toggle-cache")}`,
      `sim_threshold   = ${val("sim-threshold",  "0.92")}`,
      `size            = ${val("cache-size",     "1024")}`,
      `ttl             = ${val("cache-ttl",      "3600")}`,
    ].join("\n");
  }

  function buildPerformanceIni() {
    return [
      "# performance.ini — Performance Configuration",
      "# Auto-saved by Settings UI (Performance section)",
      "",
      "[performance]",
      `gpu_threshold = ${val("gpu-threshold", "85")}`,
    ].join("\n");
  }

  function buildChatIni() {
    return [
      "# chat.ini — Advanced Configuration",
      "# Auto-saved by Settings UI (Advanced section)",
      "",
      "[prompts]",
      `main_prompt_path = ${val("main-prompt", "prompts/main.txt")}`,
      `viz_prompt_path  = ${val("viz-prompt",  "prompts/visualization.txt")}`,
    ].join("\n");
  }

  // capacity.ini — Capacity & Forecasting section is left unwired per
  // spec (Capacity's real data comes from CapacityMiddleware's live
  // forecast endpoint, not from saved settings). File exists so the
  // settings-file layout is complete and predictable, but intentionally
  // holds no real fields yet.
  function buildCapacityIni() {
    return [
      "# capacity.ini — Capacity & Forecasting Configuration",
      "# Intentionally left blank — Capacity & Forecasting settings are not",
      "# yet wired to persistence. Reserved for future use.",
    ].join("\n");
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     13. VALIDATION
  ═══════════════════════════════════════════════════════════════════════════ */

  function validate() {
    const errors = [];

    const urlFields = [
      { id: "llm-url",      label: "LLM Base URL"  },
      { id: "rag-base-url", label: "RAG Base URL"  },
    ];
    urlFields.forEach(({ id, label }) => {
      const v = val(id, "").trim();
      if (v && !v.match(/^https?:\/\/.+/)) {
        errors.push(`${label}: must start with http:// or https://`);
      }
    });

    const numFields = [
      { id: "llm-max-tokens", label: "Max Tokens",    min: 1,   max: 32768 },
      { id: "llm-timeout",    label: "LLM Timeout",   min: 1,   max: 300   },
      { id: "rag-timeout",    label: "RAG Timeout",   min: 1,   max: 300   },
      { id: "top-k",          label: "Top K",         min: 1,   max: 100   },
      { id: "top-n",          label: "Top N",         min: 1,   max: 50    },
      { id: "log-max-size",   label: "Max Log Size",  min: 1024,max: Infinity },
      { id: "log-backups",    label: "Log Backups",   min: 0,   max: 100   },
    ];
    numFields.forEach(({ id, label, min, max }) => {
      const v = parseFloat(val(id, ""));
      if (isNaN(v) || v < min || v > max) {
        errors.push(`${label}: value must be between ${min} and ${max}`);
      }
    });

    return errors;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     14. SAVE  (conf.properties / capacity.ini / llm.ini / rag.ini /
         performance.ini / chat.ini — the section-level files.
         mcpconf.ini / mapping.json / categorization.json save per-tab,
         see Section 5.)
  ═══════════════════════════════════════════════════════════════════════════ */

  async function saveSettings() {
    const errors = validate();
    if (errors.length > 0) {
      toast("Cannot save — please fix: " + errors.join("; "), "error");
      return;
    }

    const btn = $("btn-save");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" style="width:14px;height:14px;animation:spin 1s linear infinite"></i> Saving…'; refreshIcons(); }

    const payload = {
      "conf.properties":  buildConfProperties(),
      "capacity.ini":      buildCapacityIni(),
      "llm.ini":           buildLlmIni(),
      "rag.ini":           buildRagIni(),
      "performance.ini":   buildPerformanceIni(),
      "chat.ini":          buildChatIni(),
    };

    const result = await API.saveSettings(payload);

    if (btn) {
      btn.disabled  = false;
      btn.innerHTML = result.ok
        ? '<i data-lucide="save" style="width:14px;height:14px"></i> Save Changes'
        : '<i data-lucide="alert-circle" style="width:14px;height:14px"></i> Save Failed';
      refreshIcons();
    }

    if (result.ok) {
      dirty = false;
      updateFooter();
      console.info("[settings] All config files saved.");
      toast("Settings saved.", "success");
    } else {
      console.warn("[settings] Save failed:", result.error);
      toast(`Save failed: ${result.error || "unknown error"}`, "error");
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     16. EVENT WIRING
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireEvents() {
    const navSearch = $("nav-search");
    if (navSearch) navSearch.addEventListener("input", Utils.debounce(e => renderNav(e.target.value), 200));

    document.querySelectorAll(".toggle-switch").forEach(wireToggle);

    ["seg-density", "seg-theme", "seg-intent"].forEach(id => wireSegmented($(id)));

    wireRange("llm-temp",       "temp-label");
    wireRange("llm-confidence", "conf-label");
    wireRange("bm25-weight",    "bm25-label");
    wireRange("sem-weight",     "sem-label");
    wireRange("sim-threshold",  "sim-label");

    const gpuThresh = $("gpu-threshold");
    const gpuLabel  = $("gpu-thresh-label");
    const gpuDisp   = $("gpu-thresh-display");
    if (gpuThresh) {
      gpuThresh.addEventListener("input", () => {
        const v = gpuThresh.value;
        if (gpuLabel) gpuLabel.textContent = `GPU Memory Threshold (%): ${v}`;
        if (gpuDisp)  gpuDisp.textContent  = `Threshold ${v}%`;
        markDirty();
      });
    }

    ["bm25-weight", "sem-weight"].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener("input", updateWeightTotal);
    });

    const rerankToggle = $("toggle-rerank");
    const rerankFields = $("rerank-fields");
    if (rerankToggle && rerankFields) {
      rerankToggle.addEventListener("click", () => {
        rerankFields.style.display = rerankToggle.dataset.on === "true" ? "none" : "";
      });
    }

    const cacheToggle = $("toggle-cache");
    const cacheFields = $("cache-fields");
    if (cacheToggle && cacheFields) {
      cacheToggle.addEventListener("click", () => {
        cacheFields.style.display = cacheToggle.dataset.on === "true" ? "none" : "";
      });
    }

    $("btn-save")?.addEventListener("click", saveSettings);
    $("btn-cancel")?.addEventListener("click", () => { dirty = false; updateFooter(); });
    $("btn-reset")?.addEventListener("click",  () => { dirty = false; updateFooter(); });
    $("btn-validate-model")?.addEventListener("click", validateLlmModel);
    $("btn-test-rag")?.addEventListener("click", testRagConnectivity);

    document.querySelectorAll("#settings-body input, #settings-body select, #settings-body textarea").forEach(el =>
      el.addEventListener("change", markDirty)
    );

    wireMcpEvents();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     17. BOOTSTRAP
  ═══════════════════════════════════════════════════════════════════════════ */

  document.addEventListener("DOMContentLoaded", () => {
    Utils.initHeader();

    if (global.lucide) global.lucide.createIcons();

    renderNav();
    wireEvents();
    switchSection(activeSection);
    updateFooter();
    refreshIcons();

    // Load MCP Servers / Categorization / Keywords from backend (non-blocking)
    loadMcpData().catch(e => console.warn("[settings] loadMcpData failed:", e));
  });

  // Public debug surface
  global.SET = {
    switchSection,
    getState: () => ({ activeSection, dirty, editingServerId, editingTab }),
    getMcpServers: () => mcpServers,
  };

})(window);