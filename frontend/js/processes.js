/**
 * processes.js — Processes page logic
 *
 * Data table only: Source, Application, Process Name, Process Type,
 * Hosting Service, Status, ID.
 * No filters, no KPIs, no detail modal — same deliberately simple shape as
 * infrastructure.js / services.js.
 *
 * Follows the same lazy-load convention as Infrastructure/Services/AI
 * Monitoring: data is fetched exactly once, the first time the SPA shell
 * activates this tab. window.onTabActivated(isFirstActivation) is the hook
 * the shell (index.html / Shell.showTab) calls.
 *
 * DATA SOURCE:
 *   GET /api/processes via API.getProcesses() (api.js).
 *   Fallback: { processes: [] } → table renders its own empty state.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG
 *   api.js     → window.API
 *   common.js  → window.Utils
 *   jQuery + DataTables (vendored, loaded in processes.html <head>)
 */

(function (global) {
  "use strict";

  /* ─── Guard ─────────────────────────────────────────────────────────────── */
  if (!global.CFG) {
    console.error("[processes.js] CFG not found — did config.js load?");
    return;
  }
  if (!global.API) {
    console.error("[processes.js] API not found — did api.js load?");
    return;
  }

  // jQuery $ and local $ must not conflict — keep jQ alias for DataTables
  // (same convention as dashboard.js / infrastructure.js / services.js)
  const jQ = global.jQuery || global.$;

  let dtInstance = null;

  /* ─── Status → tone mapping ──────────────────────────────────────────────
     Reuses shared.css's .status-badge tone classes (healthy/degraded/offline)
     — same component used on Infrastructure's / Services' Status column.
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
      if (text) text.textContent = `Falling back to empty processes list: ${message}`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  /* ─── Render ─────────────────────────────────────────────────────────────── */
  function buildRowData(procs) {
    return procs.map(d => [
      `<span style="font-size:12px">${Utils.escapeHtml(d.source)}</span>`,
      `<span style="font-size:12px">${Utils.escapeHtml(d.application)}</span>`,
      `<span style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${Utils.escapeHtml(d.processName)}</span>`,
      `<span style="font-size:12px">${Utils.escapeHtml(d.processType)}</span>`,
      `<span style="font-size:12px">${Utils.escapeHtml(d.hostingService)}</span>`,
      statusChipHtml(d.status),
      `<span style="font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);white-space:nowrap">${Utils.escapeHtml(d.id)}</span>`,
    ]);
  }

  function renderTable(procs) {
    const rowData = buildRowData(procs);

    if (dtInstance) {
      dtInstance.clear().rows.add(rowData).draw(false);
      Utils.refreshIcons();
      return;
    }

    dtInstance = jQ("#processes-table").DataTable({
      data: rowData,
      columns: [
        { title: "Source"          },
        { title: "Application"     },
        { title: "Process Name"    },
        { title: "Process Type"    },
        { title: "Hosting Service" },
        { title: "Status"          },
        { title: "ID"              },
      ],
      pageLength: 10,
      lengthMenu: [10, 25, 50, 100],
      order: [[2, "asc"]],
      scrollX: true,
      autoWidth: false,
      language: {
        emptyTable:   "No processes found.",
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
  async function loadProcesses() {
    try {
      const data  = await API.getProcesses();
      const procs = Array.isArray(data.processes) ? data.processes : [];
      setError(null);
      renderTable(procs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[processes] getProcesses error:", msg);
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
     * No initial loadProcesses() call here, no polling — data is
     * fetched exactly once, when onTabActivated(true) fires. See below.
     */
  });

  /* ═══════════════════════════════════════════════════════════════════════════
     onTabActivated(isFirstActivation)

     Called by the SPA shell (index.html / Shell.showTab) each time the
     Processes tab becomes visible.

     isFirstActivation === true  → tab has never been shown before this
       session. Fetch data now (the only fetch that will ever happen).
     isFirstActivation === false → user is returning to an already-visited
       tab. Data from the first load is still displayed; do nothing.

     Standalone / dev mode: if the page is opened directly (no shell),
     onTabActivated() is never called automatically — trigger it manually via
     PROC.reload() or window.onTabActivated(true) from the console.
  ═══════════════════════════════════════════════════════════════════════════ */
  global.onTabActivated = function onTabActivated(isFirstActivation) {
    if (isFirstActivation) {
      loadProcesses();
    }
    /* On subsequent activations: nothing to do — rendered data stays visible */
  };

  /* ─── Public surface ─────────────────────────────────────────────────────── */
  global.PROC = {
    reload: loadProcesses,
  };

})(window);
