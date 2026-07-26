/**
 * api.js — Unified MCP Dashboard
 * All backend endpoint definitions and fetch wrappers.
 * Exposes: window.API
 *
 * As of the 6-way middleware split, six services back this file:
 *   ObservabilityMiddleware :8081, CapacityMiddleware :8082,
 *   TopologyMiddleware :8083, ChatMiddleware :5100,
 *   SettingsMiddleware :5200, AdminMiddleware :8086.
 * See the CONSTANTS block below for the full port map.
 *
 * ENDPOINTS:
 *   GET  /api/issues                → getIssues()              [Observability]
 *   GET  /api/status                → getStatus()               [Observability]
 *   POST /api/refresh               → triggerRefresh()          [Observability]
 *   GET  /api/infrastructure        → getInfrastructure()       [Observability]
 *   GET  /api/services              → getServices()             [Observability]
 *   GET  /api/mcp-sample            → getMcpSample(source)      [Observability]
 *   GET  /api/capacity/forecast     → getCapacityForecast()     [Capacity — not wired into capacity.js yet]
 *   GET  /api/topology/servers      → getTopologyServers()      [Topology — not wired into topology.js yet]
 *   GET  /api/config/:filename      → getConfig(filename)       [Settings]
 *   PUT  /api/config/:filename      → putConfig(filename, content) [Settings]
 *   POST /api/settings/save         → saveSettings(payload)     [Settings]
 *   POST /api/chat                  → postChat(...) (fallback)  [Chat]
 *   POST /api/chat/stream           → postChat(...) (primary)   [Chat]
 *   GET  /api/network-devices       → getNetworkDevices()       [Admin]
 *   GET  /api/processes             → getProcesses()            [Admin]
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[api.js] window.CFG not found — make sure config.js loads before api.js.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CONSTANTS — ONE PLACE TO EDIT WHEN BACKEND IS READY
  //
  // Six middlewares now, as of the 6-way split. Ports:
  //   OBSERVABILITY_URL — ObservabilityMiddleware :8081  (issues, status, refresh,
  //                                                        infrastructure, services,
  //                                                        mcp-sample — was DashboardMiddleware :8080)
  //   CAPACITY_URL       — CapacityMiddleware      :8082  (capacity forecast — stub, not wired below yet)
  //   TOPOLOGY_URL        — TopologyMiddleware       :8083  (topology servers — proxy, not wired below yet)
  //   CHAT_URL            — ChatMiddleware            :5100  (chat, streaming chat)
  //   SETTINGS_URL        — SettingsMiddleware         :5200  (config read/write, settings save)
  //   ADMIN_URL           — AdminMiddleware            :8086  (users, network-devices, processes)
  // ═══════════════════════════════════════════════════════════════════════════

  const OBSERVABILITY_URL = "http://localhost:8081";
  const CAPACITY_URL      = "http://localhost:8082";
  const TOPOLOGY_URL      = "http://localhost:8083";
  const CHAT_URL          = "http://localhost:5100";
  const SETTINGS_URL      = "http://localhost:5200";
  const ADMIN_URL         = "http://localhost:8086";

  /** @deprecated Renamed to OBSERVABILITY_URL as part of the 6-way split (was DashboardMiddleware :8080). */
  const DASHBOARD_URL = OBSERVABILITY_URL;

  /** @deprecated Use the specific *_URL constants above instead. */
  const BASE_URL = OBSERVABILITY_URL;

  const DEFAULT_TIMEOUT_MS = 20_000;

  const CHAT_STATS_PATH = "../../backend/data/chatstats.json";

  const ENDPOINTS = {
    // Observability middleware (8081) — was Dashboard middleware (8080)
    issues:       "/api/issues",          // GET
    status:       "/api/status",          // GET  — middleware metadata
    refresh:      "/api/refresh",         // POST — trigger Java fetch service
    infrastructure: "/api/infrastructure",// GET  — Phase 6
    services:       "/api/services",      // GET  — Phase 7
    mcpSample:      "/api/mcp-sample",    // GET ?source= — Phase 15 mapping wizard

    // Capacity middleware (8082) — NEW, stub, not called by any function below yet
    capacityForecast: "/api/capacity/forecast", // GET

    // Topology middleware (8083) — NEW, real proxy, not called by any function below yet
    topologyServers: "/api/topology/servers",   // GET

    // Settings middleware (5200)
    config:       "/api/config",          // GET | PUT /:filename
    settingsSave: "/api/settings/save",   // POST — atomic multi-file save

    // Chat middleware (5100)
    chat:         "/api/chat",            // POST — full response via Intent Agent
    chatStream:   "/api/chat/stream",     // POST — SSE stream via RAG backend

    // Admin middleware (8086) — moved here from Observability; these were
    // previously pointed at DashboardMiddleware but never actually served
    // (no context was registered for them there — silent 404 → demo-data
    // fallback). Now served for real (as stubs) by AdminMiddleware.
    networkDevices: "/api/network-devices",// GET — Network Devices page
    processes:      "/api/processes",     // GET — Processes page
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. CORE FETCH WRAPPER
  // ═══════════════════════════════════════════════════════════════════════════

  async function fetchWithFallback(url, options = {}, fallback = null) {
    const { responseType = "json", timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOpts } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...fetchOpts, signal: controller.signal });

      if (!response.ok) {
        console.warn(`[API] ${fetchOpts.method || "GET"} ${url} → HTTP ${response.status}`);
        return fallback;
      }

      if (responseType === "text") {
        const text = await response.text().catch(() => null);
        return text !== null ? text : fallback;
      }

      const data = await response.json().catch(() => null);
      return data !== null ? data : fallback;

    } catch (err) {
      if (err.name === "AbortError") {
        console.warn(`[API] ${url} timed out after ${timeoutMs}ms`);
      } else {
        console.warn(`[API] ${url} fetch error:`, err.message);
      }
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. NAMED ENDPOINT FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * getIssues()
   * GET /api/issues
   * Fallback: { allIssues: [] }
   */
  async function getIssues() {
    const url = `${OBSERVABILITY_URL}${ENDPOINTS.issues}`;
    const fallback = { allIssues: [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    if (!Array.isArray(data.allIssues)) {
      if (Array.isArray(data)) return { allIssues: data };
      return fallback;
    }
    return data;
  }

  /**
   * getInfrastructure()
   * GET /api/infrastructure
   * Fallback: { infrastructure: [] }
   * (Phase 6)
   */
  async function getInfrastructure() {
    const url = `${OBSERVABILITY_URL}${ENDPOINTS.infrastructure}`;
    const fallback = { infrastructure: (global.DEMO_DATA && global.DEMO_DATA.infrastructure) || [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    if (!Array.isArray(data.infrastructure)) {
      if (Array.isArray(data)) return { infrastructure: data };
      return fallback;
    }
    return data;
  }

  /**
   * getServices()
   * GET /api/services
   * Fallback: { services: [] }
   * (Phase 7)
   */
  async function getServices() {
    const url = `${OBSERVABILITY_URL}${ENDPOINTS.services}`;
    const fallback = { services: (global.DEMO_DATA && global.DEMO_DATA.services) || [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    if (!Array.isArray(data.services)) {
      if (Array.isArray(data)) return { services: data };
      return fallback;
    }
    return data;
  }

  /**
   * getNetworkDevices()
   * GET /api/network-devices
   * Fallback: { networkDevices: [] }
   */
  async function getNetworkDevices() {
    const url = `${ADMIN_URL}${ENDPOINTS.networkDevices}`;
    const fallback = { networkDevices: (global.DEMO_DATA && global.DEMO_DATA.networkDevices) || [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    if (!Array.isArray(data.networkDevices)) {
      if (Array.isArray(data)) return { networkDevices: data };
      return fallback;
    }
    return data;
  }

  /**
   * getProcesses()
   * GET /api/processes
   * Fallback: { processes: [] }
   */
  async function getProcesses() {
    const url = `${ADMIN_URL}${ENDPOINTS.processes}`;
    const fallback = { processes: (global.DEMO_DATA && global.DEMO_DATA.processes) || [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    if (!Array.isArray(data.processes)) {
      if (Array.isArray(data)) return { processes: data };
      return fallback;
    }
    return data;
  }

  /**
   * getMcpServers()
   * Reads backend/data/mcpservers.json (via getConfig) and returns the
   * parsed { servers: [...] } list — the same admin-defined server list
   * Settings → MCP Servers edits. Used by the dashboard to segregate tools
   * by live, configured MCP servers instead of the old hardcoded CFG.TOOLS.
   * Fallback: { servers: [] }.
   */
  async function getMcpServers() {
    try {
      const text = await getConfig("mcpservers.json");
      const parsed = text ? JSON.parse(text) : { servers: [] };
      return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
    } catch (e) {
      console.warn("[api] getMcpServers failed:", e);
      return { servers: [] };
    }
  }

  /**
   * getMcpSample(source)
   * GET /api/mcp-sample?source=<id>
   * Mocked single-issue fetch used by the MCP Servers → Mapping wizard tab
   * (Phase 15). Fallback returns a minimal stub sample so the wizard's
   * field-dropdown population never has nothing to work with, even if the
   * middleware is unreachable.
   */
  async function getMcpSample(source) {
    const url = `${OBSERVABILITY_URL}${ENDPOINTS.mcpSample}?source=${encodeURIComponent(source)}`;
    const fallback = { source, sample: { id: "SAMPLE-0000", title: "No sample available" } };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object" || !data.sample) return fallback;
    return data;
  }

  /**
   * getChatStats()
   * Direct fetch from static file: backend/data/chatstats.json
   * Fallback: CFG.AI_MONITORING_DEFAULTS
   */
  async function getChatStats() {
    const cfg = global.CFG || {};
    const fallback = cfg.AI_MONITORING_DEFAULTS || {};
    const data = await fetchWithFallback(CHAT_STATS_PATH, { cache: "no-store" }, null);
    if (!data || typeof data !== "object") return fallback;
    return {
      ...fallback,
      ...data,
      usage:     { ...(fallback.usage     || {}), ...(data.usage     || {}) },
      resources: { ...(fallback.resources || {}), ...(data.resources || {}) },
      model:     { ...(fallback.model     || {}), ...(data.model     || {}) },
      bottom:    { ...(fallback.bottom    || {}), ...(data.bottom    || {}) },
    };
  }

  /**
   * getConfig(filename)
   * GET /api/config/:filename
   * Returns file content as raw text. Fallback: ""
   */
  async function getConfig(filename) {
    if (!filename) return "";
    const url = `${SETTINGS_URL}${ENDPOINTS.config}/${encodeURIComponent(filename)}`;
    return await fetchWithFallback(url, { responseType: "text", cache: "no-store" }, "");
  }

  /**
   * putConfig(filename, content)
   * PUT /api/config/:filename
   * Writes raw text. Returns true on 2xx, false on failure.
   */
  async function putConfig(filename, content) {
    if (!filename) return false;
    const url = `${SETTINGS_URL}${ENDPOINTS.config}/${encodeURIComponent(filename)}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let ok = false;
      try {
        const response = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: String(content),
          signal: controller.signal,
        });
        ok = response.ok;
        if (!ok) console.warn(`[API] PUT ${url} → HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
      return ok;
    } catch (err) {
      if (err.name === "AbortError") console.warn(`[API] PUT ${url} timed out`);
      else console.warn(`[API] PUT ${url} error:`, err.message);
      return false;
    }
  }

  /**
   * saveSettings(payload)
   * POST /api/settings/save
   *
   * Sends all config files in a single atomic request to DashboardMiddleware.
   * The backend writes them all or rolls back on any error.
   *
   * payload shape:
   * {
   *   "conf.ini":           "<raw text>",
   *   "mcpconf.properties": "<raw text>",
   *   "apmconf.properties": "<raw text>",
   *   "category.json":      "<json string>",
   *   "mapping.json":       "<json string>"   // optional
   * }
   *
   * Returns { ok: true } on success, { ok: false, error: "..." } on failure.
   * Falls back to individual putConfig() calls if the POST endpoint is absent
   * (404/405), enabling backward-compat with older backend builds.
   *
   * @param {Object<string,string>} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async function saveSettings(payload) {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Invalid payload" };
    }

    const url = `${SETTINGS_URL}${ENDPOINTS.settingsSave}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      // If /api/settings/save not yet deployed, fall back to individual PUTs
      if (response.status === 404 || response.status === 405) {
        console.warn("[API] POST /api/settings/save not available — falling back to individual PUTs");
        return _saveSettingsFallback(payload);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(`[API] POST ${url} → HTTP ${response.status}`, body);
        return { ok: false, error: `HTTP ${response.status}: ${body}` };
      }

      const data = await response.json().catch(() => ({ ok: true }));
      return { ok: true, ...data };

    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        console.warn(`[API] POST ${url} timed out — falling back to individual PUTs`);
      } else {
        console.warn(`[API] POST ${url} error:`, err.message, "— falling back to individual PUTs");
      }
      // Network error — try individual PUTs as fallback
      return _saveSettingsFallback(payload);
    }
  }

  /**
   * _saveSettingsFallback(payload)
   * Internal: fires individual putConfig() for each file when the unified
   * POST /api/settings/save endpoint is not yet available.
   */
  async function _saveSettingsFallback(payload) {
    const entries = Object.entries(payload);
    const results = await Promise.all(
      entries.map(([filename, content]) => putConfig(filename, content))
    );
    const failed = entries.filter((_, i) => !results[i]).map(([f]) => f);
    if (failed.length > 0) {
      return { ok: false, error: `Failed to save: ${failed.join(", ")}` };
    }
    return { ok: true };
  }

  /**
   * getStatus()
   * GET /api/status
   * Returns middleware metadata: lastFileModifiedAt, lastDataUpdatedAt,
   * lastCheckedAt, hasNewData.
   * Throws on network error so callers can catch and silently ignore.
   */
  async function getStatus() {
    const url = `${OBSERVABILITY_URL}${ENDPOINTS.status}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * triggerRefresh()
   * POST /api/refresh
   * Tells the middleware to schedule a file check in ~60 s (simulates triggering
   * the Java fetch service).
   * Returns { scheduled: true, checkIn: 60 } on success.
   * Throws on network error so callers can catch and handle.
   */
  async function triggerRefresh() {
    const url = `${OBSERVABILITY_URL}${ENDPOINTS.refresh}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * postChat(payload, onChunk, onDone, onError, onTask)
   * POST /api/chat/stream → ChatMiddleware → Intent Agent (task events + pseudo-stream)
   *
   * Streams the response token-by-token via Server-Sent Events. Before the
   * actual answer, ChatMiddleware emits a handful of "data: [TASK] <label>"
   * events describing pipeline progress (querying MCP servers, indexing into
   * RAG, etc.) — these are routed to onTask() instead of onChunk() so the UI
   * can render them as a separate task log (Phase 5).
   *
   * <think>...</think> blocks are left intact by ChatMiddleware — the caller
   * is expected to parse them client-side into a collapsible reasoning panel.
   *
   * @param {Object}   payload           - { message: string, file_ids?: string[] }
   * @param {Function} onChunk(text)     - called for each answer token as it arrives
   * @param {Function} onDone()          - called when stream ends cleanly ([DONE])
   * @param {Function} onError(message)  - called on network/middleware error
   * @param {Function} onTask(label)     - called for each "[TASK] <label>" progress event
   *
   * Returns a controller object with an abort() method so the caller can
   * cancel mid-stream (Phase 6 stop button, or navigating away).
   *
   * Falls back to non-streaming POST /api/chat if streaming is unavailable.
   */
  function postChat(payload, onChunk, onDone, onError, onTask) {
    const cfg          = global.CFG || {};
    const FALLBACK_REPLY = cfg.CHAT_FALLBACK_REPLY || "Backend unavailable.";

    // Normalise callbacks so callers don't have to pass all five
    onChunk = onChunk || (() => {});
    onDone  = onDone  || (() => {});
    onError = onError || ((msg) => console.warn("[postChat] error:", msg));
    onTask  = onTask  || (() => {});

    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(`${CHAT_URL}${ENDPOINTS.chatStream}`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            message:  payload.message,
            file_ids: payload.file_ids || [],
          }),
          signal: controller.signal,
        });

        // ── Streaming unavailable — fall back to non-streaming /api/chat ──
        if (!response.ok || !response.body) {
          console.warn(`[postChat] stream endpoint returned HTTP ${response.status} — falling back`);
          await _postChatFallback(payload, onChunk, onDone, onError, FALLBACK_REPLY);
          return;
        }

        // ── Read SSE stream line by line ───────────────────────────────────
        const reader  = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let   buffer  = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by "\n\n"; each event is "data: <payload>\n"
          const events = buffer.split("\n\n");
          // Keep the last (possibly incomplete) chunk in the buffer
          buffer = events.pop();

          for (const event of events) {
            // Strip the "data: " prefix SSE mandates
            const line = event.startsWith("data: ")
              ? event.slice(6)
              : event.trim();

            if (!line) continue;

            if (line === "[DONE]") {
              onDone();
              return;
            }

            if (line.startsWith("[ERROR]")) {
              onError(line.slice(7).trim());
              return;
            }

            if (line.startsWith("[TASK]")) {
              // Task-progress event (Phase 5) — routed separately from
              // answer text, never appended to the message content.
              onTask(line.slice(6).trim().replace(/\\n/g, "\n"));
              continue;
            }

            // ChatMiddleware escapes newlines as \n inside SSE payloads so
            // the event stays on one line — unescape them here for display.
            const text = line.replace(/\\n/g, "\n");
            onChunk(text);
          }
        }

        // Stream ended without [DONE] — treat as complete
        onDone();

      } catch (err) {
        if (err.name === "AbortError") {
          // Caller cancelled — not an error
          return;
        }
        console.warn("[postChat] stream failed:", err.message, "— falling back");
        await _postChatFallback(payload, onChunk, onDone, onError, FALLBACK_REPLY);
      }
    })();

    // Return an abort handle so the chat UI can cancel on unmount/navigation
    return { abort: () => controller.abort() };
  }

  /**
   * _postChatFallback — non-streaming fallback via POST /api/chat
   * Used when the stream endpoint is unavailable or errors immediately.
   * Delivers the full reply as a single onChunk() call then fires onDone().
   */
  async function _postChatFallback(payload, onChunk, onDone, onError, fallbackReply) {
    try {
      const response = await fetch(`${CHAT_URL}${ENDPOINTS.chat}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ message: payload.message }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data  = await response.json();
      const reply = data?.reply || fallbackReply;

      console.log(
        `[postChat fallback] intent=${data?.meta?.intent} | elapsed=${data?.meta?.elapsed}ms`
      );

      onChunk(reply);
      onDone();

    } catch (err) {
      console.warn("[postChat fallback] also failed:", err.message);
      onChunk(fallbackReply);
      onDone();
    }
  }

  /**
   * getCapacityForecast()
   * GET /api/capacity/forecast
   * NEW — CapacityMiddleware (8082). Not called by capacity.js yet; that
   * page still computes its numbers client-side. This exists so the
   * migration to a real server-computed forecast is a capacity.js change
   * only, not an api.js change too.
   * Fallback: { implemented: false, servers: [] }
   */
  async function getCapacityForecast() {
    const url = `${CAPACITY_URL}${ENDPOINTS.capacityForecast}`;
    const fallback = { implemented: false, servers: [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object") return fallback;
    return data;
  }

  /**
   * getTopologyServers()
   * GET /api/topology/servers
   * NEW — TopologyMiddleware (8083), a read-only proxy in front of
   * SettingsMiddleware's mcpservers.json. Not called by topology.js yet;
   * that page still calls getMcpServers() directly. Prefer this once
   * topology.js is updated — it decouples Topology from Settings' file
   * layout.
   * Fallback: { servers: [] }
   */
  async function getTopologyServers() {
    const url = `${TOPOLOGY_URL}${ENDPOINTS.topologyServers}`;
    const fallback = { servers: [] };
    const data = await fetchWithFallback(url, { cache: "no-store" }, fallback);
    if (!data || typeof data !== "object" || !Array.isArray(data.servers)) return fallback;
    return data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. PUBLIC SURFACE
  // ═══════════════════════════════════════════════════════════════════════════

  global.API = {
    // URL constants — use these if you ever need to construct a URL manually
    OBSERVABILITY_URL,
    CAPACITY_URL,
    TOPOLOGY_URL,
    CHAT_URL,
    SETTINGS_URL,
    ADMIN_URL,
    DASHBOARD_URL,  // @deprecated alias for OBSERVABILITY_URL
    BASE_URL,       // @deprecated alias for OBSERVABILITY_URL
    ENDPOINTS,
    CHAT_STATS_PATH,

    fetchWithFallback,

    // Observability (8081) — was Dashboard (8080)
    getIssues,
    getStatus,
    triggerRefresh,
    getChatStats,
    getInfrastructure,
    getServices,
    getMcpServers,
    getMcpSample,

    // Capacity (8082) — new, not called anywhere in the frontend yet
    getCapacityForecast,

    // Topology (8083) — new, not called anywhere in the frontend yet
    getTopologyServers,

    // Settings (5200)
    getConfig,
    putConfig,
    saveSettings,

    // Chat (5100)
    postChat,         // streaming-first, falls back to non-streaming automatically

    // Admin (8086) — moved here from Observability, see ENDPOINTS comment above
    getNetworkDevices,
    getProcesses,
  };

  Object.freeze(global.API);


})(window);