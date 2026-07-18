/**
 * infrastructure.js — Infrastructure page logic (Phase 6)
 *
 * Data table only: Host Name, OS Type, Status, Entity ID.
 * No filters, no KPIs, no detail modal — this page is deliberately simple.
 *
 * Follows the same lazy-load convention introduced for AI Monitoring
 * (ai_monitoring.js, Change 7): data is fetched exactly once, the first time
 * the SPA shell activates this tab — not on every tab switch, and not on a
 * poll/interval. window.onTabActivated(isFirstActivation) is the hook the
 * shell (index.html / Shell.showTab) calls.
 *
 * DATA SOURCE:
 *   GET /api/infrastructure via API.getInfrastructure() (api.js).
 *   Fallback: { infrastructure: [] } → table renders its own empty state.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 *   jQuery + DataTables (vendored, loaded in infrastructure.html <head>)
 */

(function (global) {
  "use strict";

  /* ─── Guard ─────────────────────────────────────────────────────────────── */
  if (!global.CFG) {
    console.error("[infrastructure.js] CFG not found — did config.js load?");
    return;
  }
  if (!global.API) {
    console.error("[infrastructure.js] API not found — did api.js load?");
    return;
  }

  // jQuery $ and local $ must not conflict — keep jQ alias for DataTables
  // (same convention as dashboard.js)
  const jQ = global.jQuery || global.$;

  let dtInstance = null;

  /* ─── Status → tone mapping ──────────────────────────────────────────────
     Reuses shared.css's .status-badge tone classes (healthy/degraded/offline)
     — the same component already used on the AI Monitoring page header.
  ──────────────────────────────────────────────────────────────────────── */
  function statusTone(status) {
    const s = (status || "").toLowerCase();
    if (s === "online" || s === "healthy" || s === "connected") return "healthy";
    if (s === "degraded" || s === "warning")                    return "degraded";
    return "offline"; // Offline, Error, Disconnected, unknown, etc.
  }

  function statusChipHtml(status) {
    const tone = statusTone(status);
    return `<span class="status-badge ${tone}"><span class="dot"></span>${Utils.escapeHtml(status || "Unknown")}</span>`;
  }

  /* ─── Error banner ───────────────────────────────────────────────────────── */
  function setError(message) {
    const banner = document.getElementById("error-banner");
    const text   = document.getElementById("error-banner-text");
    if (!banner) return;
    if (message) {
      if (text) text.textContent = `Falling back to empty infrastructure list: ${message}`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  /* ─── Render ─────────────────────────────────────────────────────────────── */
  function buildRowData(hosts) {
    return hosts.map(h => [
      `<span style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${Utils.escapeHtml(h.hostName)}</span>`,
      `<span style="font-size:12px">${Utils.escapeHtml(h.osType)}</span>`,
      statusChipHtml(h.status),
      `<span style="font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(h.entityId)}</span>`,
    ]);
  }

  function renderTable(hosts) {
    const rowData = buildRowData(hosts);

    if (dtInstance) {
      dtInstance.clear().rows.add(rowData).draw(false);
      Utils.refreshIcons();
      return;
    }

    dtInstance = jQ("#infrastructure-table").DataTable({
      data: rowData,
      columns: [
        { title: "Host Name" },
        { title: "OS Type"   },
        { title: "Status"    },
        { title: "Entity ID" },
      ],
      pageLength: 10,
      lengthMenu: [10, 25, 50, 100],
      order: [[0, "asc"]],
      scrollX: true,
      autoWidth: false,
      language: {
        emptyTable:   "No Infrastructure found.",
        info:         "Showing _START_ to _END_ of _TOTAL_ entries",
        infoEmpty:    "No entries",
        infoFiltered: "(filtered from _MAX_ total)",
        search:       "Table filter:",
        lengthMenu:   "Show _MENU_ entries",
        paginate:     { first: "«", last: "»", next: "›", previous: "‹" },
      },
      drawCallback: function () {
        Utils.refreshIcons();
      },
    });
  }

  /* ─── Data fetch ─────────────────────────────────────────────────────────── */
  async function loadInfrastructure() {
    try {
      const data  = await API.getInfrastructure();
      const hosts = Array.isArray(data.infrastructure) ? data.infrastructure : [];
      setError(null);
      renderTable(hosts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[infrastructure] getInfrastructure error:", msg);
      setError(msg);
      renderTable([]);
    }
  }

  /* ─── Bootstrap ──────────────────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", function () {
    /*
     * Shared header — safe to call even inside an iframe. common.js detects
     * (window !== top) and returns immediately when running inside the SPA
     * shell, so this is a no-op in production and only renders the flat
     * header when the page is opened directly in development.
     */
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }

    if (global.lucide) {
      global.lucide.createIcons();
    }

    /*
     * No initial loadInfrastructure() call here, no polling — data is
     * fetched exactly once, when onTabActivated(true) fires. See below.
     */
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     onTabActivated(isFirstActivation)

     Called by the SPA shell (index.html / Shell.showTab) each time the
     Infrastructure tab becomes visible.

     isFirstActivation === true  → tab has never been shown before this
       session. Fetch data now (the only fetch that will ever happen).
     isFirstActivation === false → user is returning to an already-visited
       tab. Data from the first load is still displayed; do nothing.

     Standalone / dev mode: if the page is opened directly (no shell),
     onTabActivated() is never called automatically — trigger it manually via
     INFRA.reload() or window.onTabActivated(true) from the console.
  ═══════════════════════════════════════════════════════════════════════════ */
  global.onTabActivated = function onTabActivated(isFirstActivation) {
    if (isFirstActivation) {
      loadInfrastructure();
    }
    /* On subsequent activations: nothing to do — rendered data stays visible */
  };

  /* ─── Public surface ─────────────────────────────────────────────────────── */
  global.INFRA = {
    reload: loadInfrastructure,
  };

})(window);
