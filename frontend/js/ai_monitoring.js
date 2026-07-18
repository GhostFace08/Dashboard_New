/**
 * ai_monitoring.js — AI Monitoring page logic
 *
 * Change 5: initHeader() is now a no-op when this page runs inside the SPA
 *   shell iframe (window !== top).  The call is kept so the page still works
 *   when opened directly in development (standalone mode).
 *
 * Change 7: Load data only on tab open, not continuously.
 *   Removed:  setInterval auto-poll and the visibilitychange handler.
 *   Removed:  The initial loadStats() call from DOMContentLoaded.
 *   Added:    window.onTabActivated(isFirstActivation) — exposed so the SPA
 *             shell can call it when this tab becomes visible.
 *             loadStats() is called only when isFirstActivation === true
 *             (i.e. the very first time the user opens the AI Monitoring tab
 *             in this browser session).  Subsequent tab switches do nothing —
 *             the data rendered on first load stays visible and stale.
 *
 *   Rationale from the plan: the page should not silently burn API quota by
 *   polling in the background while the user is on another tab, and it should
 *   not re-fetch on every tab switch — one fetch per session is enough for a
 *   monitoring overview that does not change second-by-second.
 *
 * DATA SOURCE:
 *   Direct fetch from ../../backend/data/chatstats.json (no middleware).
 *   Path is configurable via API.CHAT_STATS_PATH (set in api.js).
 *   Falls back to CFG.AI_MONITORING_DEFAULTS on any error.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 */

(function (global) {
  "use strict";

  /* ─── Guard ─────────────────────────────────────────────────────────────── */
  if (!global.CFG) {
    console.error("[ai_monitoring.js] CFG not found — did config.js load?");
    return;
  }
  if (!global.API) {
    console.error("[ai_monitoring.js] API not found — did api.js load?");
    return;
  }

  /* ─── Helpers ────────────────────────────────────────────────────────────── */

  function el(id) {
    const node = document.getElementById(id);
    if (!node) console.warn(`[ai_monitoring] #${id} not found`);
    return node;
  }

  function fmtPct(n) {
    return `${Math.round(n || 0)}%`;
  }

  function clampPct(n) {
    return Math.min(100, Math.max(0, n || 0));
  }

  /* ─── Status helpers ─────────────────────────────────────────────────────── */

  function resolveStatusClasses(status) {
    const s = (status || "").toLowerCase();
    if (s === "healthy")  return { badgeClass: "healthy",  modelClass: "healthy",  iconColor: "#10b981" };
    if (s === "degraded") return { badgeClass: "degraded", modelClass: "degraded", iconColor: "#e5a030" };
    return                       { badgeClass: "offline",  modelClass: "offline",  iconColor: "#e5534b" };
  }

  /* ─── Render ─────────────────────────────────────────────────────────────── */

  function render(stats) {
    const u = stats.usage     || {};
    const r = stats.resources || {};
    const m = stats.model     || {};
    const b = stats.bottom    || {};

    /* ── Usage stats ── */
    setText("stat-totalTokens",        (u.totalTokens        || 0).toLocaleString());
    setText("stat-questionsToday",     String(u.questionsToday     || 0));
    setText("stat-requestsProcessed",  (u.requestsProcessed  || 0).toLocaleString());
    setText("stat-totalConversations", String(u.totalConversations || 0));
    setText("stat-promptTokens",       (u.promptTokens       || 0).toLocaleString());
    setText("stat-completionTokens",   (u.completionTokens   || 0).toLocaleString());
    setText("stat-avgResponseMs",      `${u.avgResponseMs || 0} ms`);
    setText("stat-p95Ms",              `P95: ${u.p95Ms || 0} ms`);
    setText("stat-cacheHitRatePct",    fmtPct(u.cacheHitRatePct));

    /* ── Resource meters ── */
    setMeter("cachePct",  r.cachePct);
    setMeter("memoryPct", r.memoryPct);
    setMeter("gpuPct",    r.gpuPct);
    setMeter("cpuPct",    r.cpuPct);

    /* ── Active model card ── */
    const { badgeClass, modelClass, iconColor } = resolveStatusClasses(m.status);

    setText("model-name",     m.name     || "—");
    setText("model-endpoint", m.endpoint || "—");
    setText("model-device",   m.device   || "—");

    const statusValueEl = el("model-status-value");
    if (statusValueEl) {
      statusValueEl.textContent = m.status || "Offline";
      statusValueEl.className = `aim-model-value aim-model-status ${modelClass}`;
    }

    const statusIconEl = el("model-status-icon");
    if (statusIconEl) {
      statusIconEl.style.color = iconColor;
    }

    /* ── Header badge ── */
    const badge    = el("model-status-badge");
    const badgeTxt = el("model-status-text");
    if (badge)    badge.className   = `status-badge ${badgeClass}`;
    if (badgeTxt) badgeTxt.textContent = m.status || "Offline";

    /* ── Bottom infrastructure stats ── */
    setText("stat-vectorStoreDocs", (b.vectorStoreDocs || 0).toLocaleString());
    setText("stat-storageUsed",     `${(b.storageUsedGb  || 0).toFixed(1)} GB`);
    setText("stat-storageTotal",    `of ${b.storageTotalGb || 0} GB`);
    setText("stat-throughput",      `${b.throughputTokPerSec || 0} t/s`);
    setText("stat-errorRate",       fmtPct(b.errorRatePct));

    if (global.Utils && typeof global.Utils.refreshIcons === "function") {
      global.Utils.refreshIcons();
    }
  }

  function setText(id, text) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function setMeter(key, value) {
    const pct     = clampPct(value);
    const fillEl  = el(`meter-${key}`);
    const labelEl = el(`meter-${key}-label`);
    if (fillEl)  fillEl.style.width    = `${pct}%`;
    if (labelEl) labelEl.textContent   = `${pct}%`;
  }

  /* ─── Error banner ───────────────────────────────────────────────────────── */

  function setError(message) {
    const banner = el("error-banner");
    const text   = el("error-banner-text");
    if (!banner) return;

    if (message) {
      if (text) text.textContent =
        `Falling back to default AI monitoring values: ${message}`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  /* ─── Data fetch ─────────────────────────────────────────────────────────── */

  async function loadStats() {
    try {
      const stats = await API.getChatStats();
      setError(null);
      render(stats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[ai_monitoring] getChatStats error:", msg);
      setError(msg);
      render(CFG.AI_MONITORING_DEFAULTS || {});
    }
  }

  /* ─── Bootstrap ──────────────────────────────────────────────────────────── */

  document.addEventListener("DOMContentLoaded", function () {

    /*
     * Shared header — safe to call even inside an iframe.
     * common.js detects (window !== top) and returns immediately when running
     * inside the SPA shell, so this is a no-op in production and correctly
     * renders the header when the page is opened directly in development.
     */
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }

    /* Stamp lucide icons that exist in static HTML */
    if (global.lucide) {
      global.lucide.createIcons();
    }

    /*
     * Change 7 — NO initial loadStats() call here.
     * NO setInterval auto-poll.
     * NO visibilitychange handler.
     *
     * Data is fetched exactly once: when onTabActivated() is called for the
     * first time by the SPA shell.  See onTabActivated() below.
     */
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     Change 7 — onTabActivated(isFirstActivation)

     Called by the SPA shell (index.html / Shell.showTab) each time the
     AI Monitoring tab becomes visible.

     isFirstActivation === true  → the tab has never been shown before in this
       browser session.  Fetch data now (the only fetch that will ever happen).

     isFirstActivation === false → the user is returning to a tab they have
       already visited.  Data from the first load is still displayed; do nothing.

     This means:
       • Zero API calls while the user is on other tabs.
       • Zero re-fetches on tab revisits — the data stays as-is.
       • One clean fetch the very first time the user opens this tab.

     Standalone / dev mode:
       If the page is opened directly (no shell), onTabActivated() is never
       called by the shell.  In that case loadStats() is called manually via
       the public AIM.reload() surface, or the developer can call
       window.onTabActivated(true) from the console.
  ═══════════════════════════════════════════════════════════════════════════ */
  global.onTabActivated = function onTabActivated(isFirstActivation) {
    if (isFirstActivation) {
      loadStats();
    }
    /* On subsequent activations: nothing to do — rendered data stays visible */
  };

  /* ─── Public surface ─────────────────────────────────────────────────────── */
  global.AIM = {
    /*
     * reload() — manual trigger for dev/debug or for future use
     * (e.g. a "Refresh" button on the page itself could call AIM.reload()).
     */
    reload: loadStats
  };

})(window);