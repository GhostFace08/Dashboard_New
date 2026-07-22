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
 *    a server list (backed by backend/data/mcpservers.json) with an Add
 *    Server modal and a multi-tab Edit modal (Server Details / Mapping /
 *    Issue Categorization / Time Mapping / AI Keywords). Issue
 *    Categorization now edits per-server keyword lists inside a shared
 *    categories doc (backend/data/categorization.json); AI Keywords edits
 *    a per-server list (backend/data/keywords.json). Each tab saves
 *    immediately via API.putConfig() rather than through the global
 *    Save-Changes footer, which still only covers conf.ini/mcpconf/apmconf.
 *  - category.json / mapping.json are no longer read or written by this
 *    page — they were the old shared/per-tool files these three new JSON
 *    files replace. Nothing else in the app has been repointed at the new
 *    files yet (out of scope for this phase — see handoff doc).
 *  - CFG.TOOLS / apmconf.properties are untouched and keep working exactly
 *    as before for every other page (Dashboard, Capacity, Topology, User
 *    Management) — this phase adds the new admin model alongside them, it
 *    does not migrate existing consumers onto it yet.
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

  let activeSection = "monitoring";
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

  // Tool Registry state — a registry is a plain file the admin uploads
  // (one path per line); we parse it client-side into a flat list of path
  // strings and use that to populate the "Registry Path for Fetching
  // Issues" dropdown, plus the 5 Dashboards-tab dropdowns.
  let addRegistryPaths  = [];   // parsed from the Add-modal's uploaded file
  let editRegistryPaths = {};   // { [serverId]: [path, ...] } parsed on edit-modal upload

  function parseRegistryFile(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#"));
  }

  function registryPathOptionsHtml(paths, selected) {
    if (!paths || paths.length === 0) {
      return `<option value="">Upload a Tool Registry first…</option>`;
    }
    return `<option value="">Select a path…</option>` +
      paths.map(p => `<option value="${esc(p)}"${p === selected ? " selected" : ""}>${esc(p)}</option>`).join("");
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
      const serversText = await API.getConfig("mcpservers.json");
      const parsed = serversText ? JSON.parse(serversText) : { servers: [] };
      mcpServers = Array.isArray(parsed.servers) ? parsed.servers : [];
    } catch (e) {
      console.warn("[settings] Could not load mcpservers.json:", e);
      mcpServers = [];
    }
    try {
      const catText = await API.getConfig("categorization.json");
      const parsed  = catText ? JSON.parse(catText) : null;
      if (parsed && Array.isArray(parsed.categories)) mcpCategorization = parsed;
    } catch (e) {
      console.warn("[settings] Could not load categorization.json:", e);
    }
    try {
      const kwText = await API.getConfig("keywords.json");
      const parsed = kwText ? JSON.parse(kwText) : {};
      mcpKeywords = (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      console.warn("[settings] Could not load keywords.json:", e);
    }
    mcpLoaded = true;
    renderServerList();
  }

  async function persistServers() {
    await API.putConfig("mcpservers.json", JSON.stringify({ servers: mcpServers }, null, 2));
  }
  async function persistCategorization() {
    await API.putConfig("categorization.json", JSON.stringify(mcpCategorization, null, 2));
  }
  async function persistKeywords() {
    await API.putConfig("keywords.json", JSON.stringify(mcpKeywords, null, 2));
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
      setTimeout(() => {
        if (btn) { btn.innerHTML = `<i data-lucide="plug-zap" style="width:12px;height:12px"></i> Test Connection`; refreshIcons(); }
      }, 3000);
    }
  }

  async function toggleServerEnabled(id) {
    const s = mcpServers.find(x => x.id === id);
    if (!s) return;
    s.enabled = s.enabled === false ? true : false;
    await persistServers();
    renderServerList();
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
    if (!name) { alert("Server Name is required."); return; }
    if (baseUrl && !/^https?:\/\/.+/.test(baseUrl)) { alert("Base URL must start with http:// or https://"); return; }

    const vendor = val("mcp-add-vendor", "dynatrace");
    const customType = val("mcp-add-type", "").trim();
    if (vendor === "custom" && !customType) { alert("Custom Tool Name is required when Type/Vendor is Custom Tool."); return; }
    const type = vendor === "custom" ? customType : vendor;

    if (addRegistryPaths.length > 0) {
      const chosenPath = val("mcp-add-registry-path", "");
      if (!chosenPath) { alert("Registry Path for Fetching Issues is required once a Tool Registry is uploaded."); return; }
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
        ? { fileName: $("mcp-add-registry")?.files?.[0]?.name || "", paths: addRegistryPaths.slice() }
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
        <span class="sfield-label">Tool Registry</span>
        <span class="sfield-hint">${s.registry?.fileName ? `On file: <strong>${esc(s.registry.fileName)}</strong> (${paths.length} path${paths.length === 1 ? "" : "s"}). Upload a new file to replace it.` : "Upload the tool's issue registry (a file listing its available issue paths)."}</span>
        <div class="flex gap-2 items-center mt-1">
          <input id="edit-registry" type="file" class="input" style="max-width:260px" />
          <span id="edit-registry-status" class="text-muted" style="font-size:11px"></span>
        </div>
      </div>
      <label class="sfield mt-2">
        <span class="sfield-label">Registry Path for Fetching Issues <span style="color:var(--accent-red)">*</span></span>
        <span class="sfield-hint">Required once a Tool Registry is uploaded.</span>
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
      ${cats.map(c => {
        const kws = (c.keywordsBySource && c.keywordsBySource[s.id]) || [];
        return `
          <div class="mcp-cat-block" data-cat="${c.id}">
            <div class="mcp-cat-block-head">
              <span class="mcp-cat-priority">#${c.priority ?? "—"}</span>
              <h4 class="mcp-cat-name">${esc(c.name)}</h4>
              <span class="text-muted" style="font-size:11px">${kws.length} keyword${kws.length === 1 ? "" : "s"}</span>
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

  function timeTabHtml() {
    return `
      <div class="banner banner-info">
        <i data-lucide="info" style="width:16px;height:16px;flex-shrink:0"></i>
        <span class="banner-text">Time Mapping isn't configurable yet for individual servers — issues currently use each field's default time parsing. This tab is a placeholder for a future release.</span>
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
    } else if (editingTab === "mapping") {
      $("btn-fetch-sample")?.addEventListener("click", async () => {
        const btn = $("btn-fetch-sample");
        if (btn) { btn.disabled = true; btn.textContent = "Fetching…"; }
        const res = await API.getMcpSample(s.type || s.id);
        s.sample = res?.sample || null;
        renderEditTabBody();
      });
    } else if (editingTab === "categorization") {
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
      if (editRegistryPaths[s.id]) {
        s.registry = { fileName: $("edit-registry")?.files?.[0]?.name || s.registry?.fileName || "", paths: editRegistryPaths[s.id].slice() };
      }
      const paths = editRegistryPaths[s.id] || (s.registry?.paths || []);
      if (paths.length > 0) {
        const chosenPath = val("edit-registry-path", "");
        if (!chosenPath) { alert("Registry Path for Fetching Issues is required once a Tool Registry is uploaded."); if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Tab"; } return; }
        s.issuesRegistryPath = chosenPath;
        s.dashboards = s.dashboards || {};
        s.dashboards.issuesPath = chosenPath;
      }
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
        alert(`These Dashboards-tab fields are required: ${missing.join(", ")}`);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Tab"; }
        return;
      }
      await persistServers();
    }
    // Time tab has nothing to persist.

    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save Tab"; }
    renderServerList();
  }

  async function deleteServer(id) {
    const s = mcpServers.find(x => x.id === id);
    if (!s) return;
    if (!window.confirm(`Delete "${s.name}"? This removes it from mcpservers.json — its category/keyword entries are left in place.`)) return;
    mcpServers = mcpServers.filter(x => x.id !== id);
    await persistServers();
    closeEditModal();
    renderServerList();
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
    $("mcp-add-registry")?.addEventListener("change", async () => {
      const input = $("mcp-add-registry");
      const file = input.files && input.files[0];
      const status = $("mcp-add-registry-status");
      const pathSel = $("mcp-add-registry-path");
      if (!file) return;
      const text = await file.text();
      addRegistryPaths = parseRegistryFile(text);
      if (status) status.textContent = `Registry parsed ✓ (${addRegistryPaths.length} paths found)`;
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
     11. conf.ini / mcpconf.properties / apmconf.properties builders
  ═══════════════════════════════════════════════════════════════════════════ */

  function buildConfIni() {
    return [
      "# conf.ini — MCP Dashboard General Configuration",
      "# Auto-saved by Settings UI",
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
      "[topology]",
      `periodic_fetch_time = ${val("topology-fetch-time", "15 min")}`,
    ].join("\n");
  }

  function buildMcpConf() {
    // Phase 15: llm.rag_keywords is now a legacy/global fallback line only —
    // per-server AI Keywords live in keywords.json (MCP Servers → AI
    // Keywords tab). Kept here so mcpconf.properties stays a valid file for
    // any code that still reads this one shared line.
    return [
      "# mcpconf.properties — MCP AI & RAG Configuration",
      "# Auto-saved by Settings UI",
      "",
      "# AI / LLM",
      `llm.url              = ${val("llm-url",         "http://localhost:11434")}`,
      `llm.model            = ${val("llm-model",       "qwen2.5")}`,
      `llm.temperature      = ${val("llm-temp",        "0.2")}`,
      `llm.max_tokens       = ${val("llm-max-tokens",  "2048")}`,
      `llm.intent_mode      = ${activeSegValue("seg-intent") ?? "hybrid"}`,
      `llm.confidence       = ${val("llm-confidence",  "0.7")}`,
      `llm.timeout          = ${val("llm-timeout",     "15")}`,
      "",
      "# RAG Server",
      `rag.base_url         = ${val("rag-base-url",    "http://localhost:8000")}`,
      `rag.data_endpoint    = ${val("rag-data-ep",     "/data")}`,
      `rag.ask_endpoint     = ${val("rag-ask-ep",      "/ask")}`,
      `rag.metadata_file    = ${val("rag-meta",        "metadata.json")}`,
      `rag.timeout          = ${val("rag-timeout",     "30")}`,
      "",
      "# File Storage",
      `rag.upload_folder    = ${val("rag-upload-folder",    "storage/uploads")}`,
      `rag.vector_store     = ${val("rag-vector-store",     "storage/vectors")}`,
      `rag.bm25_store       = ${val("rag-bm25-store",       "storage/bm25")}`,
      "",
      "# Config Paths",
      `rag.instructions_file = ${val("rag-instructions-file", "config/instructions.md")}`,
      `rag.faq_file          = ${val("rag-faq-file",          "config/faq.json")}`,
      `rag.settings_file     = ${val("rag-settings-file",     "config/settings.yaml")}`,
      "",
      "# Search & Ranking",
      `search.embed_model    = ${val("embed-model",    "bge-small-en-v1.5")}`,
      `search.chunk_size     = ${val("chunk-size",     "512")}`,
      `search.chunk_overlap  = ${val("chunk-overlap",  "64")}`,
      `search.top_k          = ${val("top-k",          "8")}`,
      `search.bm25_weight    = ${val("bm25-weight",    "0.4")}`,
      `search.sem_weight     = ${val("sem-weight",     "0.6")}`,
      `search.rerank_enabled = ${toggleOn("toggle-rerank")}`,
      `search.rerank_model   = ${val("rerank-model",   "bge-reranker-base")}`,
      `search.top_n          = ${val("top-n",          "3")}`,
      "",
      "# Cache",
      `cache.enabled         = ${toggleOn("toggle-cache")}`,
      `cache.sim_threshold   = ${val("sim-threshold",  "0.92")}`,
      `cache.size            = ${val("cache-size",     "1024")}`,
      `cache.ttl             = ${val("cache-ttl",      "3600")}`,
      "",
      "# Performance",
      `perf.gpu_threshold    = ${val("gpu-threshold",  "85")}`,
    ].join("\n");
  }

  function buildApmConf() {
    const lines = [
      "# apmconf.properties — APM Tool Connection Configuration",
      "# Auto-saved by Settings UI",
      "# Unchanged by Phase 15 — CFG.TOOLS' 4 fixed tools still live here;",
      "# admin-defined servers from MCP Servers live in mcpservers.json instead.",
      "",
    ];
    CFG.TOOLS.forEach(t => {
      const id = t.id;
      const base    = CFG.SERVICE_DEFAULTS?.[id]?.baseUrl  ?? "";
      const ep      = CFG.SERVICE_DEFAULTS?.[id]?.endpoint ?? "";
      lines.push(`# ── ${t.name} ─────────────────────────────────────────────────────────────────`);
      lines.push(`${id}.enabled    = true`);
      lines.push(`${id}.base_url   = ${base}`);
      lines.push(`${id}.endpoint   = ${ep}`);
      lines.push(`${id}.timeout    = 30`);
      lines.push(`${id}.collection = file`);
      lines.push(`${id}.data_file  = backend/data/all_issues.json`);
      lines.push("");
    });
    return lines.join("\n");
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
     14. SAVE  (conf.ini / mcpconf.properties / apmconf.properties only —
         MCP Servers / Categorization / Keywords save per-tab, see Section 5)
  ═══════════════════════════════════════════════════════════════════════════ */

  async function saveSettings() {
    const errors = validate();
    if (errors.length > 0) {
      alert("Cannot save — please fix the following:\n\n• " + errors.join("\n• "));
      return;
    }

    const btn = $("btn-save");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2" style="width:14px;height:14px;animation:spin 1s linear infinite"></i> Saving…'; refreshIcons(); }

    const payload = {
      "conf.ini":           buildConfIni(),
      "mcpconf.properties": buildMcpConf(),
      "apmconf.properties": buildApmConf(),
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
    } else {
      console.warn("[settings] Save failed:", result.error);
      alert(`Save failed: ${result.error || "unknown error"}`);
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