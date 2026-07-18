/**
 * topology.js — Topology Map page logic (Phase 9)
 *
 * Per decision #3: manual composition only (no auto-discovery). Driven by
 * the vendored D3 subset — d3-selection, d3-force, d3-drag, d3-zoom (loaded
 * in that order in topology.html's <head>, since force/drag/zoom extend
 * the base d3 namespace selection provides).
 *
 * PERSISTENCE — OPEN ITEM (see handoff doc Section 6, Phase 9 note):
 *   Whether saved topologies need a real backend endpoint hasn't been
 *   decided yet. For now this page persists to localStorage (key below) so
 *   Add Topology / Connect Nodes survive a reload during review — purely a
 *   client-side placeholder, same spirit as capacity.js's mock data. Every
 *   read/write funnels through loadStore()/saveStore() below; swapping to a
 *   real backend later means replacing just those two functions' bodies
 *   with API calls (same shape), same pattern as capacity.js's
 *   getCapacityData() swap-in path.
 *
 * DATA MODEL (per application):
 *   { nodes: [{ id, label, kind: host|service|procgroup,
 *               origin: discovered|manual, status: healthy|problem|disconnected,
 *               source, entityId, x, y }],
 *     edges: [{ from, to, origin: discovered|manual, problem: bool }] }
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG   (TOOLS, for the Source picker)
 *   api.js     → window.API
 *   common.js  → window.Utils
 *   d3 (vendored: selection, force, drag, zoom — all attach to window.d3)
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[topology.js] CFG not found — did config.js load?");
    return;
  }

  const TOOLS = global.CFG.TOOLS || [];
  const STORAGE_KEY = "mcp-topology-data";

  const COLORS = {
    discovered:   "var(--accent-indigo, #6366f1)",
    manual:       "var(--accent-teal, #14b8a6)",
    problem:      "var(--accent-red, #e5534b)",
    disconnected: "var(--muted-foreground, #8b8b96)",
  };

  const KIND_FILTER_KEY = { host: "hosts", service: "services", procgroup: "procgroups" };

  /* ─── State ───────────────────────────────────────────────────────────── */
  const state = {
    apps: [],                 // string[] application names
    currentApp: null,
    scope: "problem",         // "problem" | "full"
    filters: { hosts: true, services: true, procgroups: true },
    search: "",
    selectedNodeId: null,
    loaded: false,
  };

  let svg, zoomGroup, simulation, zoomBehavior;

  /* ─── Store (localStorage-backed placeholder — see doc comment) ─────────── */
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to seed */ }
    return seedStore();
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      console.warn("[topology] failed to persist topology store:", e);
    }
  }

  /* ─── Seed data — one application with a populated topology, so the page
     doesn't look broken on first load; others intentionally start empty to
     demonstrate the empty state. ─────────────────────────────────────────── */
  function seedStore() {
    const store = {
      "Payments Gateway": generateMockTopology("Payments Gateway", "dynatrace"),
      "Order Service": { nodes: [], edges: [] },
      "Inventory API": { nodes: [], edges: [] },
    };
    saveStore(store);
    return store;
  }

  let idCounter = 1;
  function nextId(prefix) { return `${prefix}-${idCounter++}`; }

  function generateMockTopology(appName, sourceId) {
    const tool = TOOLS.find(t => t.id === sourceId);
    const sourceName = tool ? tool.name : sourceId;
    const hostCount = 3, svcCount = 4, pgCount = 2;
    const nodes = [];
    const edges = [];

    for (let i = 0; i < hostCount; i++) {
      nodes.push({
        id: nextId("host"), label: `host-${appName.slice(0, 3).toLowerCase()}-${i + 1}`,
        kind: "host", origin: "discovered",
        status: i === 0 ? "problem" : "healthy",
        source: sourceName, entityId: `ENT-${Math.floor(1000 + Math.random() * 9000)}`,
      });
    }
    for (let i = 0; i < svcCount; i++) {
      nodes.push({
        id: nextId("svc"), label: `${appName.split(" ")[0].toLowerCase()}-svc-${i + 1}`,
        kind: "service", origin: "discovered",
        status: i === 1 ? "problem" : (i === 3 ? "disconnected" : "healthy"),
        source: sourceName, entityId: `ENT-${Math.floor(1000 + Math.random() * 9000)}`,
      });
    }
    for (let i = 0; i < pgCount; i++) {
      nodes.push({
        id: nextId("pg"), label: `proc-group-${i + 1}`,
        kind: "procgroup", origin: "discovered", status: "healthy",
        source: sourceName, entityId: `ENT-${Math.floor(1000 + Math.random() * 9000)}`,
      });
    }

    // Wire a plausible chain: hosts -> proc groups -> services
    const hosts = nodes.filter(n => n.kind === "host");
    const svcs  = nodes.filter(n => n.kind === "service");
    const pgs   = nodes.filter(n => n.kind === "procgroup");
    hosts.forEach((h, i) => {
      const pg = pgs[i % pgs.length];
      edges.push({ from: h.id, to: pg.id, origin: "discovered", problem: h.status === "problem" });
    });
    pgs.forEach((pg, i) => {
      const svc = svcs[i % svcs.length];
      edges.push({ from: pg.id, to: svc.id, origin: "discovered", problem: svc.status === "problem" });
    });
    for (let i = 1; i < svcs.length; i++) {
      if (svcs[i].status !== "disconnected") {
        edges.push({ from: svcs[0].id, to: svcs[i].id, origin: "discovered", problem: false });
      }
    }

    return { nodes, edges };
  }

  /* ─── Derived helpers ─────────────────────────────────────────────────── */
  function getCurrentTopology(store) {
    return store[state.currentApp] || { nodes: [], edges: [] };
  }

  function visibleNodes(topology) {
    const q = state.search.trim().toLowerCase();
    return topology.nodes.filter(n => {
      if (!state.filters[KIND_FILTER_KEY[n.kind]]) return false;
      if (state.scope === "problem" && !hasProblemNeighborhood(n, topology)) return false;
      if (q && !n.label.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function hasProblemNeighborhood(node, topology) {
    if (node.status === "problem" || node.status === "disconnected") return true;
    return topology.edges.some(e =>
      (e.from === node.id || e.to === node.id) && e.problem
    );
  }

  /* ─── Render: application picker ─────────────────────────────────────── */
  function renderAppSelect() {
    const sel = document.getElementById("topo-app-select");
    if (!sel) return;
    sel.innerHTML = state.apps.map(a =>
      `<option value="${Utils.escapeHtml(a)}"${a === state.currentApp ? " selected" : ""}>${Utils.escapeHtml(a)}</option>`
    ).join("");
  }

  function renderSourceSelect(selectEl) {
    selectEl.innerHTML = TOOLS.map(t =>
      `<option value="${Utils.escapeHtml(t.id)}">${Utils.escapeHtml(t.name)}</option>`
    ).join("");
  }

  /* ─── Render: graph ───────────────────────────────────────────────────── */
  function ensureSvg() {
    if (svg) return;
    svg = d3.select("#topo-svg");
    zoomGroup = svg.append("g").attr("class", "topo-zoom-group");
    zoomBehavior = d3.zoom()
      .scaleExtent([0.3, 2.5])
      .on("zoom", (event) => zoomGroup.attr("transform", event.transform));
    svg.call(zoomBehavior);
  }

  function renderGraph() {
    ensureSvg();
    const store = loadStore();
    const topology = getCurrentTopology(store);
    const emptyState = document.getElementById("topo-empty-state");

    if (!topology.nodes.length) {
      if (emptyState) emptyState.classList.remove("hidden");
      zoomGroup.selectAll("*").remove();
      if (simulation) { simulation.stop(); simulation = null; }
      return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    const nodes = visibleNodes(topology).map(n => Object.assign({}, n));
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = topology.edges
      .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map(e => Object.assign({}, e));

    zoomGroup.selectAll("*").remove();

    if (simulation) simulation.stop();
    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id(d => d.id).distance(90).strength(0.6))
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(360, 220))
      .force("collide", d3.forceCollide(34));

    const link = zoomGroup.append("g").attr("class", "topo-links")
      .selectAll("line")
      .data(edges)
      .join("line")
      .attr("class", d => "topo-link" + (d.problem ? " problem" : ""))
      .attr("stroke", d => d.problem ? COLORS.problem : (d.origin === "manual" ? COLORS.manual : COLORS.discovered))
      .attr("stroke-opacity", 0.55);

    const nodeGroup = zoomGroup.append("g").attr("class", "topo-nodes")
      .selectAll("g")
      .data(nodes, d => d.id)
      .join("g")
      .attr("class", d => "topo-node" + (d.id === state.selectedNodeId ? " selected" : ""))
      .call(dragBehavior(simulation))
      .on("click", (event, d) => { event.stopPropagation(); selectNode(d.id); });

    nodeGroup.append("circle")
      .attr("r", d => d.kind === "host" ? 14 : (d.kind === "service" ? 11 : 9))
      .attr("fill", d => nodeColor(d))
      .attr("stroke", "var(--card)");

    nodeGroup.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", d => (d.kind === "host" ? 14 : 11) + 12)
      .text(d => d.label);

    svg.on("click", () => selectNode(null));

    simulation.on("tick", () => {
      link
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      nodeGroup.attr("transform", d => `translate(${d.x},${d.y})`);
    });
  }

  function nodeColor(d) {
    if (d.status === "problem") return COLORS.problem;
    if (d.status === "disconnected") return COLORS.disconnected;
    return d.origin === "manual" ? COLORS.manual : COLORS.discovered;
  }

  function dragBehavior(sim) {
    return d3.drag()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.25).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }

  /* ─── Node selection / detail panel ──────────────────────────────────── */
  function selectNode(nodeId) {
    state.selectedNodeId = nodeId;
    const panel = document.getElementById("topo-detail-panel");
    if (!nodeId) {
      if (panel) panel.classList.remove("open");
      renderGraph();
      return;
    }
    const store = loadStore();
    const topology = getCurrentTopology(store);
    const node = topology.nodes.find(n => n.id === nodeId);
    if (!node || !panel) return;

    document.getElementById("topo-detail-title").textContent = node.label;
    document.getElementById("topo-detail-type").textContent = node.kind;
    document.getElementById("topo-detail-status").textContent = node.status;
    document.getElementById("topo-detail-source").textContent = node.source;
    document.getElementById("topo-detail-origin").textContent = node.origin;
    document.getElementById("topo-detail-entity").textContent = node.entityId;
    panel.classList.add("open");
    renderGraph();
  }

  function removeSelectedNode() {
    if (!state.selectedNodeId) return;
    const store = loadStore();
    const topology = getCurrentTopology(store);
    topology.nodes = topology.nodes.filter(n => n.id !== state.selectedNodeId);
    topology.edges = topology.edges.filter(e => e.from !== state.selectedNodeId && e.to !== state.selectedNodeId);
    store[state.currentApp] = topology;
    saveStore(store);
    document.getElementById("topo-detail-panel").classList.remove("open");
    state.selectedNodeId = null;
    renderGraph();
  }

  /* ─── Toolbar: search, filters, scope ────────────────────────────────── */
  function wireToolbar() {
    const appSelect = document.getElementById("topo-app-select");
    appSelect.addEventListener("change", () => {
      state.currentApp = appSelect.value;
      state.selectedNodeId = null;
      document.getElementById("topo-detail-panel").classList.remove("open");
      renderGraph();
    });

    document.getElementById("topo-search-input").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderGraph();
    });

    document.querySelectorAll(".topo-filter-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const key = chip.getAttribute("data-filter");
        state.filters[key] = !state.filters[key];
        chip.classList.toggle("active", state.filters[key]);
        renderGraph();
      });
    });

    document.querySelectorAll("#topo-scope-segmented .seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#topo-scope-segmented .seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.scope = btn.getAttribute("data-scope");
        renderGraph();
      });
    });

    document.getElementById("topo-refresh-btn").addEventListener("click", () => {
      const store = loadStore();
      const existing = getCurrentTopology(store);
      const manualNodes = existing.nodes.filter(n => n.origin === "manual");
      const manualEdges = existing.edges.filter(e => e.origin === "manual");
      const sourceUsed = existing.nodes[0] ? existing.nodes[0].source : (TOOLS[0] && TOOLS[0].name);
      const toolMatch = TOOLS.find(t => t.name === sourceUsed) || TOOLS[0];
      const fresh = generateMockTopology(state.currentApp, toolMatch ? toolMatch.id : "dynatrace");
      fresh.nodes = fresh.nodes.concat(manualNodes);
      fresh.edges = fresh.edges.concat(manualEdges);
      store[state.currentApp] = fresh;
      saveStore(store);
      renderGraph();
    });

    document.getElementById("topo-fit-btn").addEventListener("click", fitView);
    document.getElementById("topo-zoom-in-btn").addEventListener("click", () => zoomBehavior && svg.transition().duration(150).call(zoomBehavior.scaleBy, 1.3));
    document.getElementById("topo-zoom-out-btn").addEventListener("click", () => zoomBehavior && svg.transition().duration(150).call(zoomBehavior.scaleBy, 0.75));

    document.getElementById("topo-detail-close-btn").addEventListener("click", () => selectNode(null));
    document.getElementById("topo-detail-remove-btn").addEventListener("click", removeSelectedNode);
    document.getElementById("topo-detail-connect-btn").addEventListener("click", () => openConnectModal(state.selectedNodeId));
  }

  function fitView() {
    if (!zoomBehavior || !svg) return;
    svg.transition().duration(200).call(zoomBehavior.transform, d3.zoomIdentity);
  }

  /* ─── Add Topology modal ─────────────────────────────────────────────── */
  function openAddModal(prefillApp) {
    const overlay = document.getElementById("topo-add-modal-overlay");
    const appInput = document.getElementById("topo-add-app-input");
    const sourceSelect = document.getElementById("topo-add-source-select");
    const existingRow = document.getElementById("topo-add-existing-row");
    const existingList = document.getElementById("topo-existing-topo-list");
    const hint = document.getElementById("topo-add-app-hint");
    const title = document.getElementById("topo-add-modal-title");

    renderSourceSelect(sourceSelect);
    appInput.value = prefillApp || "";

    function refreshExistingPreview() {
      const name = appInput.value.trim();
      const store = loadStore();
      const exists = name && store[name] && store[name].nodes.length;
      if (exists) {
        title.textContent = "Add Topology From Another Tool";
        hint.textContent = "This application already has a topology — the new source's data will be merged in.";
        existingRow.style.display = "";
        const sources = Array.from(new Set(store[name].nodes.map(n => n.source)));
        existingList.innerHTML = sources.map(s => `
          <div class="topo-existing-topo-item"><span>${Utils.escapeHtml(s)}</span><span class="topo-subtitle" style="margin:0">${store[name].nodes.filter(n=>n.source===s).length} nodes</span></div>
        `).join("");
      } else {
        title.textContent = "Add Topology";
        hint.textContent = name ? "New application — a fresh topology will be created." : "Enter an application name to continue.";
        existingRow.style.display = "none";
        existingList.innerHTML = "";
      }
    }
    appInput.oninput = refreshExistingPreview;
    refreshExistingPreview();

    overlay.classList.remove("hidden");
  }

  function closeAddModal() {
    document.getElementById("topo-add-modal-overlay").classList.add("hidden");
  }

  function saveAddModal() {
    const appName = document.getElementById("topo-add-app-input").value.trim();
    const sourceId = document.getElementById("topo-add-source-select").value;
    if (!appName) return;

    const store = loadStore();
    const fresh = generateMockTopology(appName, sourceId);

    if (store[appName] && store[appName].nodes.length) {
      // Merge in — this is the "add from a different tool, same application" path.
      store[appName].nodes = store[appName].nodes.concat(fresh.nodes);
      store[appName].edges = store[appName].edges.concat(fresh.edges);
    } else {
      store[appName] = fresh;
    }
    saveStore(store);

    if (!state.apps.includes(appName)) {
      state.apps.push(appName);
      renderAppSelect();
    }
    state.currentApp = appName;
    document.getElementById("topo-app-select").value = appName;
    closeAddModal();
    renderGraph();
  }

  /* ─── Connect Nodes modal ─────────────────────────────────────────────── */
  function openConnectModal(prefillFromId) {
    const store = loadStore();
    const topology = getCurrentTopology(store);
    if (!topology.nodes.length) return;

    const fromSelect = document.getElementById("topo-connect-from-select");
    const toSelect = document.getElementById("topo-connect-to-select");
    const optionsHtml = topology.nodes.map(n =>
      `<option value="${Utils.escapeHtml(n.id)}">${Utils.escapeHtml(n.label)} (${n.kind})</option>`
    ).join("");
    fromSelect.innerHTML = optionsHtml;
    toSelect.innerHTML = optionsHtml;

    if (prefillFromId) fromSelect.value = prefillFromId;

    document.getElementById("topo-connect-modal-overlay").classList.remove("hidden");
  }

  function closeConnectModal() {
    document.getElementById("topo-connect-modal-overlay").classList.add("hidden");
  }

  function saveConnectModal() {
    const fromId = document.getElementById("topo-connect-from-select").value;
    const toId = document.getElementById("topo-connect-to-select").value;
    if (!fromId || !toId || fromId === toId) { closeConnectModal(); return; }

    const store = loadStore();
    const topology = getCurrentTopology(store);
    const already = topology.edges.some(e =>
      (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
    );
    if (!already) {
      topology.edges.push({ from: fromId, to: toId, origin: "manual", problem: false });
      store[state.currentApp] = topology;
      saveStore(store);
      renderGraph();
    }
    closeConnectModal();
  }

  /* ─── Modal wiring ────────────────────────────────────────────────────── */
  function wireModals() {
    document.getElementById("topo-add-btn").addEventListener("click", () => openAddModal(state.currentApp));
    document.getElementById("topo-empty-add-btn").addEventListener("click", () => openAddModal(state.currentApp));
    document.getElementById("topo-add-from-tool-btn").addEventListener("click", () => openAddModal(state.currentApp));
    document.getElementById("topo-add-modal-close-btn").addEventListener("click", closeAddModal);
    document.getElementById("topo-add-modal-cancel-btn").addEventListener("click", closeAddModal);
    document.getElementById("topo-add-modal-save-btn").addEventListener("click", saveAddModal);
    document.getElementById("topo-add-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "topo-add-modal-overlay") closeAddModal();
    });

    document.getElementById("topo-connect-btn").addEventListener("click", () => openConnectModal(null));
    document.getElementById("topo-connect-modal-close-btn").addEventListener("click", closeConnectModal);
    document.getElementById("topo-connect-modal-cancel-btn").addEventListener("click", closeConnectModal);
    document.getElementById("topo-connect-modal-save-btn").addEventListener("click", saveConnectModal);
    document.getElementById("topo-connect-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "topo-connect-modal-overlay") closeConnectModal();
    });
  }

  /* ─── Bootstrap ───────────────────────────────────────────────────────── */
  function initPage() {
    const store = loadStore();
    state.apps = Object.keys(store);
    state.currentApp = state.apps[0] || null;
    renderAppSelect();
    wireToolbar();
    wireModals();
    renderGraph();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }
    if (global.lucide) {
      global.lucide.createIcons();
    }
    // Toolbar/modals are wired here (cheap, no data dependency); the graph
    // itself renders lazily via onTabActivated, same convention as
    // infrastructure.js / services.js / capacity.js.
  });

  global.onTabActivated = function onTabActivated(isFirstActivation) {
    if (isFirstActivation && !state.loaded) {
      state.loaded = true;
      initPage();
    }
  };

  /* ─── Public surface ─────────────────────────────────────────────────── */
  global.TOPOLOGY = {
    reload: renderGraph,
    getState: () => Object.assign({}, state),
  };

})(window);
