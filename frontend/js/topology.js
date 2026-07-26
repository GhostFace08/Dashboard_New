/**
 * topology.js — Topology Map page logic
 *
 * DATA MODEL (rewritten for Estate/Application/Focused views):
 *   store = {
 *     [appName]: {
 *       topologies: {
 *         [topoId]: {
 *           id, label, kind: "mcp"|"api"|"blank", sourceLabel, mcpServerId,
 *           nodes: [{ id, label, kind: host|service|procgroup|device|process,
 *                     origin: discovered|manual, status: healthy|problem|disconnected,
 *                     source, entityId, x, y }],
 *           edges: [{ from, to, origin: discovered|manual, problem: bool, type }]
 *         }
 *       }
 *     }
 *   }
 *
 * VIEWS:
 *   all         — stitches every application's every topology into one graph
 *                 ("Estate view"). Read-only composition; no app/topology row.
 *   application — stitches every topology under the *current* application.
 *                 Add/Delete Application controls live here.
 *   focused     — exactly one topology (current app + current topology).
 *                 Refresh from Sources, Delete Topology, and Add Node's
 *                 topology-scoping only make full sense here.
 *
 * PERSISTENCE: still a localStorage-backed placeholder (see original doc
 * note) — seedStore() now seeds from window.DEMO_DATA.topology when present
 * (see demo_data.js), so the page has real content to demo without a
 * backend. Swapping to a real backend later means replacing loadStore() /
 * saveStore() with API calls of the same shape.
 *
 * DEPENDENCIES (must load before this file):
 *   demo_data.js → window.DEMO_DATA (optional but expected for the demo)
 *   config.js    → window.CFG   (TOOLS, legacy fallback source list)
 *   api.js       → window.API   (API.getTopologyServers() for the live MCP
 *                  list, via TopologyMiddleware; falls back to
 *                  API.getMcpServers() if Topology is unreachable)
 *   common.js    → window.Utils
 *   d3 (vendored: selection, force, drag, zoom — all attach to window.d3)
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[topology.js] CFG not found — did config.js load?");
    return;
  }

  const TOOLS = global.CFG.TOOLS || [];
  const STORAGE_KEY = "mcp-topology-data-v2";

  const COLORS = {
    discovered:   "var(--accent-indigo, #6366f1)",
    manual:       "var(--accent-teal, #14b8a6)",
    problem:      "var(--accent-red, #e5534b)",
    disconnected: "var(--muted-foreground, #8b8b96)",
  };

  const KIND_RADIUS = { host: 14, service: 11, procgroup: 9, device: 12, process: 8 };

  /* ─── State ───────────────────────────────────────────────────────────── */
  const state = {
    view: "all",               // "all" | "application" | "focused"
    apps: [],                  // string[] application names
    currentApp: null,
    currentTopoId: null,       // used in "focused" view
    search: "",
    selectedNodeId: null,
    selectedEdge: null,        // { from, to } of the edge shown in the detail popup
    manualConnectArmed: false,
    manualConnectFirst: null,  // { app, topoId, nodeId } of the first click in manual-connect mode
    mcpServers: [],            // populated from API.getMcpServers()
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

  function seedStore() {
    const demo = (global.DEMO_DATA && global.DEMO_DATA.topology) ? global.DEMO_DATA.topology : null;
    const store = demo ? JSON.parse(JSON.stringify(demo)) : {
      "Payments Gateway": { topologies: {} },
    };
    saveStore(store);
    return store;
  }

  let idCounter = 1;
  function nextId(prefix) { return `${prefix}-${Date.now().toString(36)}-${idCounter++}`; }

  /* ─── Mock topology generator (used by Add Topology[MCP/API] + Refresh) ── */
  function generateMockTopology(appName, sourceLabel) {
    const hostCount = 3, svcCount = 3, pgCount = 2;
    const nodes = [];
    const edges = [];
    const slug = appName.replace(/\s+/g, "-").toLowerCase();

    for (let i = 0; i < hostCount; i++) {
      nodes.push({
        id: nextId("host"), label: `${slug}-host-${i + 1}`,
        kind: "host", origin: "discovered",
        status: i === 0 ? "problem" : "healthy",
        source: sourceLabel, entityId: `ENT-${Math.floor(1000 + Math.random() * 9000)}`,
      });
    }
    for (let i = 0; i < pgCount; i++) {
      nodes.push({
        id: nextId("pg"), label: `${slug}-proc-group-${i + 1}`,
        kind: "procgroup", origin: "discovered", status: "healthy",
        source: sourceLabel, entityId: `ENT-${Math.floor(1000 + Math.random() * 9000)}`,
      });
    }
    for (let i = 0; i < svcCount; i++) {
      nodes.push({
        id: nextId("svc"), label: `${slug}-svc-${i + 1}`,
        kind: "service", origin: "discovered",
        status: i === 1 ? "problem" : "healthy",
        source: sourceLabel, entityId: `ENT-${Math.floor(1000 + Math.random() * 9000)}`,
      });
    }

    const hosts = nodes.filter(n => n.kind === "host");
    const svcs  = nodes.filter(n => n.kind === "service");
    const pgs   = nodes.filter(n => n.kind === "procgroup");
    hosts.forEach((h, i) => {
      const pg = pgs[i % pgs.length];
      edges.push({ from: h.id, to: pg.id, origin: "discovered", problem: h.status === "problem", type: "hosts" });
    });
    pgs.forEach((pg, i) => {
      const svc = svcs[i % svcs.length];
      edges.push({ from: pg.id, to: svc.id, origin: "discovered", problem: svc.status === "problem", type: "runs" });
    });

    return { nodes, edges };
  }

  /* ─── Derived helpers ─────────────────────────────────────────────────── */
  function ensureApp(store, appName) {
    if (!store[appName]) store[appName] = { topologies: {} };
    return store[appName];
  }

  function topologyList(store, appName) {
    const app = store[appName];
    if (!app) return [];
    return Object.values(app.topologies);
  }

  function getFocusedTopology(store) {
    const app = store[state.currentApp];
    if (!app) return null;
    return app.topologies[state.currentTopoId] || null;
  }

  // Stitches multiple topologies (across one app, or across every app) into
  // a single { nodes, edges } graph for rendering. Nodes/edges carry along
  // `_app` and `_topoId` so the rest of the page (search, connect, edge
  // click, node click) can always trace a rendered element back to its
  // owning application + topology, even in the stitched Estate/Application
  // views.
  function stitchGraph(topologies) {
    const nodes = [];
    const edges = [];
    topologies.forEach(({ app, topoId, topology }) => {
      (topology.nodes || []).forEach(n => nodes.push(Object.assign({}, n, { _app: app, _topoId: topoId })));
      (topology.edges || []).forEach(e => edges.push(Object.assign({}, e, { _app: app, _topoId: topoId })));
    });
    return { nodes, edges };
  }

  function currentGraph(store) {
    if (state.view === "all") {
      const all = [];
      state.apps.forEach(app => topologyList(store, app).forEach(topology =>
        all.push({ app, topoId: topology.id, topology })
      ));
      return stitchGraph(all);
    }
    if (state.view === "application") {
      const all = topologyList(store, state.currentApp).map(topology =>
        ({ app: state.currentApp, topoId: topology.id, topology })
      );
      return stitchGraph(all);
    }
    // focused
    const topo = getFocusedTopology(store);
    if (!topo) return { nodes: [], edges: [] };
    return stitchGraph([{ app: state.currentApp, topoId: topo.id, topology: topo }]);
  }

  function visibleNodes(graph) {
    const q = state.search.trim().toLowerCase();
    if (!q) return graph.nodes;
    return graph.nodes.filter(n => n.label.toLowerCase().includes(q));
  }

  /* ─── MCP servers (live list, for Add Topology / Add Node dropdowns) ────
   * Prefers TopologyMiddleware's getTopologyServers() (a read-only proxy in
   * front of Settings' mcpservers.json — see api.js). Falls back to the
   * older direct getMcpServers() path (straight to Settings) if Topology is
   * unreachable or returns an empty list, and from there to CFG.TOOLS as
   * before — this is strictly additive, no existing fallback was removed.
   */
  async function loadMcpServers() {
    try {
      if (global.API && typeof global.API.getTopologyServers === "function") {
        const res = await global.API.getTopologyServers();
        if (Array.isArray(res.servers) && res.servers.length) {
          state.mcpServers = res.servers;
        }
      }
    } catch (e) {
      console.warn("[topology] getTopologyServers failed, falling back to getMcpServers:", e);
    }
    if (!state.mcpServers.length) {
      try {
        if (global.API && typeof global.API.getMcpServers === "function") {
          const res = await global.API.getMcpServers();
          state.mcpServers = Array.isArray(res.servers) ? res.servers : [];
        }
      } catch (e) {
        console.warn("[topology] loadMcpServers failed, falling back to CFG.TOOLS:", e);
      }
    }
    if (!state.mcpServers.length) {
      state.mcpServers = TOOLS.map(t => ({ id: t.id, name: t.name, registry: { paths: [] } }));
    }
  }

  function mcpServerOptionsHtml(selected) {
    return state.mcpServers.map(s =>
      `<option value="${Utils.escapeHtml(s.id)}"${s.id === selected ? " selected" : ""}>${Utils.escapeHtml(s.name)}</option>`
    ).join("");
  }

  function mcpServerLabel(id) {
    const s = state.mcpServers.find(x => x.id === id);
    return s ? s.name : id;
  }

  /* ─── Render: view / app / topology selectors + toolbar visibility ────── */
  function renderAppSelect() {
    const sel = document.getElementById("topo-app-select");
    if (!sel) return;
    sel.innerHTML = state.apps.map(a =>
      `<option value="${Utils.escapeHtml(a)}"${a === state.currentApp ? " selected" : ""}>${Utils.escapeHtml(a)}</option>`
    ).join("");
  }

  function renderTopologySelect() {
    const sel = document.getElementById("topo-topology-select");
    if (!sel) return;
    const store = loadStore();
    const topos = topologyList(store, state.currentApp);
    sel.innerHTML = topos.map(t =>
      `<option value="${Utils.escapeHtml(t.id)}"${t.id === state.currentTopoId ? " selected" : ""}>${Utils.escapeHtml(t.label)} (${Utils.escapeHtml(t.sourceLabel || t.kind)})</option>`
    ).join("");
    if (!state.currentTopoId && topos.length) state.currentTopoId = topos[0].id;
  }

  function applyViewVisibility() {
    document.querySelectorAll("#topo-view-segmented .seg-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.view === state.view)
    );
    document.getElementById("topo-app-row").classList.toggle("hidden", state.view === "all");
    document.getElementById("topo-topo-row").classList.toggle("hidden", state.view !== "focused");
    document.getElementById("topo-add-app-btn").classList.toggle("hidden", state.view !== "application");
    document.getElementById("topo-delete-app-btn").classList.toggle("hidden", state.view !== "application");
    document.getElementById("topo-delete-topo-btn").classList.toggle("hidden", state.view !== "focused");
    const refreshBtn = document.getElementById("topo-refresh-btn");
    refreshBtn.disabled = state.view !== "focused";
    refreshBtn.title = state.view === "focused" ? "" : "Only available in Focused view";
  }

  function switchView(view) {
    state.view = view;
    state.selectedNodeId = null;
    cancelManualConnect();
    document.getElementById("topo-detail-panel").classList.remove("open");
    applyViewVisibility();
    if (view === "focused") renderTopologySelect();
    renderGraph();
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
    const graph = currentGraph(store);
    const emptyState = document.getElementById("topo-empty-state");

    if (!graph.nodes.length) {
      if (emptyState) emptyState.classList.remove("hidden");
      zoomGroup.selectAll("*").remove();
      if (simulation) { simulation.stop(); simulation = null; }
      return;
    }
    if (emptyState) emptyState.classList.add("hidden");

    const nodes = visibleNodes(graph).map(n => Object.assign({}, n));
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = graph.edges
      .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map(e => Object.assign({}, e))
      .map(e => Object.assign({}, e, { source: e.from, target: e.to }));

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
      .attr("stroke-opacity", 0.55)
      .style("cursor", "pointer")
      .on("click", (event, d) => { event.stopPropagation(); openEdgeModal(d); });

    const nodeGroup = zoomGroup.append("g").attr("class", "topo-nodes")
      .selectAll("g")
      .data(nodes, d => d.id)
      .join("g")
      .attr("class", d => "topo-node" + (d.id === state.selectedNodeId ? " selected" : ""))
      .call(dragBehavior(simulation))
      .on("click", (event, d) => { event.stopPropagation(); handleNodeClick(d); });

    nodeGroup.append("circle")
      .attr("r", d => KIND_RADIUS[d.kind] || 10)
      .attr("fill", d => nodeColor(d))
      .attr("stroke", "var(--card)");

    nodeGroup.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", d => (KIND_RADIUS[d.kind] || 10) + 12)
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

  /* ─── Node click: either normal select, or 2nd pick of manual-connect ──── */
  function handleNodeClick(d) {
    if (state.manualConnectArmed) {
      if (!state.manualConnectFirst) {
        state.manualConnectFirst = { app: d._app, topoId: d._topoId, nodeId: d.id };
        Utils.toast ? Utils.toast("Now click the node to connect it to.") : null;
        return;
      }
      const second = { app: d._app, topoId: d._topoId, nodeId: d.id };
      const first = state.manualConnectFirst;
      cancelManualConnect();
      if (first.nodeId === second.nodeId) return;
      openConnectModal({ prefillFrom: first, prefillTo: second });
      return;
    }
    selectNode(d.id);
  }

  function armManualConnect() {
    state.manualConnectArmed = true;
    state.manualConnectFirst = null;
    document.getElementById("topo-connect-manual-btn").classList.add("topo-connect-armed");
    document.getElementById("topo-canvas-wrap").classList.add("topo-connect-picking");
  }

  function cancelManualConnect() {
    state.manualConnectArmed = false;
    state.manualConnectFirst = null;
    document.getElementById("topo-connect-manual-btn").classList.remove("topo-connect-armed");
    document.getElementById("topo-canvas-wrap").classList.remove("topo-connect-picking");
  }

  /* ─── Node selection / detail panel ──────────────────────────────────── */
  function findNodeAnywhere(store, nodeId) {
    for (const app of Object.keys(store)) {
      for (const topo of Object.values(store[app].topologies)) {
        const n = topo.nodes.find(x => x.id === nodeId);
        if (n) return { app, topoId: topo.id, node: n };
      }
    }
    return null;
  }

  function selectNode(nodeId) {
    state.selectedNodeId = nodeId;
    const panel = document.getElementById("topo-detail-panel");
    if (!nodeId) {
      if (panel) panel.classList.remove("open");
      renderGraph();
      return;
    }
    const store = loadStore();
    const found = findNodeAnywhere(store, nodeId);
    if (!found || !panel) return;
    const node = found.node;

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
    const found = findNodeAnywhere(store, state.selectedNodeId);
    if (!found) return;
    const topo = store[found.app].topologies[found.topoId];
    topo.nodes = topo.nodes.filter(n => n.id !== state.selectedNodeId);
    topo.edges = topo.edges.filter(e => e.from !== state.selectedNodeId && e.to !== state.selectedNodeId);
    saveStore(store);
    document.getElementById("topo-detail-panel").classList.remove("open");
    state.selectedNodeId = null;
    renderGraph();
  }

  /* ─── Edge detail modal ───────────────────────────────────────────────── */
  function openEdgeModal(edge) {
    const store = loadStore();
    const fromFound = findNodeAnywhere(store, edge.from);
    const toFound   = findNodeAnywhere(store, edge.to);
    state.selectedEdge = edge;
    document.getElementById("topo-edge-from-app").textContent  = fromFound ? fromFound.app : "—";
    document.getElementById("topo-edge-from-node").textContent = fromFound ? fromFound.node.label : "—";
    document.getElementById("topo-edge-to-app").textContent    = toFound ? toFound.app : "—";
    document.getElementById("topo-edge-to-node").textContent   = toFound ? toFound.node.label : "—";
    document.getElementById("topo-edge-type").textContent      = edge.type || (edge.origin === "manual" ? "manual" : "discovered");
    document.getElementById("topo-edge-modal-overlay").classList.remove("hidden");
  }

  function closeEdgeModal() {
    document.getElementById("topo-edge-modal-overlay").classList.add("hidden");
    state.selectedEdge = null;
  }

  function deleteSelectedEdge() {
    const edge = state.selectedEdge;
    if (!edge) return;
    const store = loadStore();
    const topo = store[edge._app] && store[edge._app].topologies[edge._topoId];
    if (topo) {
      topo.edges = topo.edges.filter(e => !(e.from === edge.from && e.to === edge.to));
      saveStore(store);
    }
    closeEdgeModal();
    renderGraph();
  }

  /* ─── Toolbar: views, search, refresh, add node ──────────────────────── */
  function wireToolbar() {
    document.querySelectorAll("#topo-view-segmented .seg-btn").forEach(btn => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.getElementById("topo-app-select").addEventListener("change", (e) => {
      state.currentApp = e.target.value;
      state.currentTopoId = null;
      state.selectedNodeId = null;
      document.getElementById("topo-detail-panel").classList.remove("open");
      if (state.view === "focused") renderTopologySelect();
      renderGraph();
    });

    document.getElementById("topo-topology-select").addEventListener("change", (e) => {
      state.currentTopoId = e.target.value;
      state.selectedNodeId = null;
      document.getElementById("topo-detail-panel").classList.remove("open");
      renderGraph();
    });

    document.getElementById("topo-search-input").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderGraph();
    });

    document.getElementById("topo-refresh-btn").addEventListener("click", () => {
      if (state.view !== "focused") return;
      openReconcileModal();
    });

    document.getElementById("topo-fit-btn").addEventListener("click", fitView);
    document.getElementById("topo-zoom-in-btn").addEventListener("click", () => zoomBehavior && svg.transition().duration(150).call(zoomBehavior.scaleBy, 1.3));
    document.getElementById("topo-zoom-out-btn").addEventListener("click", () => zoomBehavior && svg.transition().duration(150).call(zoomBehavior.scaleBy, 0.75));

    document.getElementById("topo-detail-close-btn").addEventListener("click", () => selectNode(null));
    document.getElementById("topo-detail-remove-btn").addEventListener("click", removeSelectedNode);
    document.getElementById("topo-detail-connect-btn").addEventListener("click", () => {
      const found = findNodeAnywhere(loadStore(), state.selectedNodeId);
      if (!found) return;
      openConnectModal({ prefillFrom: { app: found.app, topoId: found.topoId, nodeId: found.node.id } });
    });

    document.getElementById("topo-connect-manual-btn").addEventListener("click", () => {
      if (state.manualConnectArmed) cancelManualConnect();
      else armManualConnect();
    });

    document.getElementById("topo-add-app-btn").addEventListener("click", openAddAppModal);
    document.getElementById("topo-delete-app-btn").addEventListener("click", openDeleteAppModal);
    document.getElementById("topo-delete-topo-btn").addEventListener("click", openDeleteTopoModal);
    document.getElementById("topo-add-node-btn").addEventListener("click", openAddNodeModal);

    document.getElementById("topo-edge-modal-close-btn").addEventListener("click", closeEdgeModal);
    document.getElementById("topo-edge-modal-close-btn2").addEventListener("click", closeEdgeModal);
    document.getElementById("topo-edge-delete-btn").addEventListener("click", deleteSelectedEdge);
    document.getElementById("topo-edge-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "topo-edge-modal-overlay") closeEdgeModal();
    });
  }

  function fitView() {
    if (!zoomBehavior || !svg) return;
    svg.transition().duration(200).call(zoomBehavior.transform, d3.zoomIdentity);
  }

  /* ─── Add Topology modal (MCP / API / Blank) ─────────────────────────── */
  let addTopoKind = "mcp";

  function openAddModal(prefillApp) {
    const overlay = document.getElementById("topo-add-modal-overlay");
    const appSel = document.getElementById("topo-add-app-select");
    const hint = document.getElementById("topo-add-app-hint");
    const title = document.getElementById("topo-add-modal-title");

    title.textContent = "Add Topology";
    document.getElementById("topo-add-mcp-server-select").innerHTML = mcpServerOptionsHtml(null);
    updateMcpRegistrySelect();
    document.getElementById("topo-add-api-tool-select").innerHTML = mcpServerOptionsHtml(null);
    document.getElementById("topo-add-blank-mcp-select").innerHTML = mcpServerOptionsHtml(null);

    setAddTopoKind("mcp");

    if (!state.apps.length) {
      appSel.innerHTML = `<option value="">(no applications yet — add one first)</option>`;
      hint.textContent = "No applications yet — use \"Add Application\" first.";
    } else {
      const selected = prefillApp && state.apps.includes(prefillApp) ? prefillApp : state.currentApp;
      appSel.innerHTML = state.apps.map(a =>
        `<option value="${Utils.escapeHtml(a)}"${a === selected ? " selected" : ""}>${Utils.escapeHtml(a)}</option>`
      ).join("");
      hint.textContent = "The new topology will be added to this application.";
    }

    overlay.classList.remove("hidden");
  }

  function updateMcpRegistrySelect() {
    const serverSel = document.getElementById("topo-add-mcp-server-select");
    const regSel = document.getElementById("topo-add-mcp-registry-select");
    const server = state.mcpServers.find(s => s.id === serverSel.value);
    const paths = (server && server.registry && server.registry.paths) || [];
    regSel.innerHTML = paths.length
      ? paths.map(p => `<option value="${Utils.escapeHtml(p)}">${Utils.escapeHtml(p)}</option>`).join("")
      : `<option value="">(no registry paths on file for this server — demo will use a generic mock)</option>`;
  }

  function setAddTopoKind(kind) {
    addTopoKind = kind;
    document.querySelectorAll("#topo-add-kind-segmented .seg-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.kind === kind)
    );
    document.getElementById("topo-add-mcp-fields").classList.toggle("hidden", kind !== "mcp");
    document.getElementById("topo-add-api-fields").classList.toggle("hidden", kind !== "api");
    document.getElementById("topo-add-blank-fields").classList.toggle("hidden", kind !== "blank");
  }

  function closeAddModal() {
    document.getElementById("topo-add-modal-overlay").classList.add("hidden");
  }

  function saveAddModal() {
    const appName = document.getElementById("topo-add-app-select").value;
    if (!appName) return;

    const store = loadStore();
    ensureApp(store, appName);

    let fresh, label, sourceLabel, mcpServerId;
    if (addTopoKind === "mcp") {
      mcpServerId = document.getElementById("topo-add-mcp-server-select").value;
      sourceLabel = mcpServerLabel(mcpServerId);
      label = sourceLabel;
      fresh = generateMockTopology(appName, sourceLabel);
    } else if (addTopoKind === "api") {
      const endpoint = document.getElementById("topo-add-api-endpoint").value.trim() || "API";
      mcpServerId = document.getElementById("topo-add-api-tool-select").value;
      sourceLabel = mcpServerLabel(mcpServerId);
      label = `API — ${endpoint}`;
      fresh = generateMockTopology(appName, sourceLabel);
    } else {
      mcpServerId = document.getElementById("topo-add-blank-mcp-select").value;
      sourceLabel = mcpServerLabel(mcpServerId);
      label = "Blank";
      fresh = { nodes: [], edges: [] };
    }

    const topoId = nextId("topo");
    store[appName].topologies[topoId] = {
      id: topoId, label, kind: addTopoKind, sourceLabel, mcpServerId,
      nodes: fresh.nodes, edges: fresh.edges,
    };
    saveStore(store);

    if (!state.apps.includes(appName)) {
      state.apps.push(appName);
      renderAppSelect();
    }
    state.currentApp = appName;
    state.currentTopoId = topoId;
    document.getElementById("topo-app-select").value = appName;
    closeAddModal();
    if (state.view === "focused") renderTopologySelect();
    renderGraph();
  }

  /* ─── Add Application modal ───────────────────────────────────────────── */
  function openAddAppModal() {
    document.getElementById("topo-add-app-modal-input").value = "";
    document.getElementById("topo-add-app-modal-overlay").classList.remove("hidden");
  }
  function closeAddAppModal() {
    document.getElementById("topo-add-app-modal-overlay").classList.add("hidden");
  }
  function saveAddAppModal() {
    const name = document.getElementById("topo-add-app-modal-input").value.trim();
    if (!name) return;
    const store = loadStore();
    ensureApp(store, name);
    saveStore(store);
    if (!state.apps.includes(name)) { state.apps.push(name); renderAppSelect(); }
    state.currentApp = name;
    document.getElementById("topo-app-select").value = name;
    closeAddAppModal();
    renderGraph();
  }

  /* ─── Delete Application modal ────────────────────────────────────────── */
  function openDeleteAppModal() {
    const sel = document.getElementById("topo-delete-app-select");
    sel.innerHTML = state.apps.map(a => `<option value="${Utils.escapeHtml(a)}">${Utils.escapeHtml(a)}</option>`).join("");
    document.getElementById("topo-delete-app-modal-overlay").classList.remove("hidden");
  }
  function closeDeleteAppModal() {
    document.getElementById("topo-delete-app-modal-overlay").classList.add("hidden");
  }
  function confirmDeleteApp() {
    const name = document.getElementById("topo-delete-app-select").value;
    if (!name) return;
    const store = loadStore();
    delete store[name];
    saveStore(store);
    state.apps = state.apps.filter(a => a !== name);
    if (state.currentApp === name) {
      state.currentApp = state.apps[0] || null;
      state.currentTopoId = null;
    }
    renderAppSelect();
    closeDeleteAppModal();
    renderGraph();
  }

  /* ─── Delete Topology modal ───────────────────────────────────────────── */
  function openDeleteTopoModal() {
    const appSel = document.getElementById("topo-delete-topo-app-select");
    appSel.innerHTML = state.apps.map(a => `<option value="${Utils.escapeHtml(a)}"${a === state.currentApp ? " selected" : ""}>${Utils.escapeHtml(a)}</option>`).join("");
    refreshDeleteTopoOptions();
    appSel.onchange = refreshDeleteTopoOptions;
    document.getElementById("topo-delete-topo-modal-overlay").classList.remove("hidden");
  }
  function refreshDeleteTopoOptions() {
    const appName = document.getElementById("topo-delete-topo-app-select").value;
    const store = loadStore();
    const topos = topologyList(store, appName);
    document.getElementById("topo-delete-topo-select").innerHTML = topos.map(t =>
      `<option value="${Utils.escapeHtml(t.id)}">${Utils.escapeHtml(t.label)}</option>`
    ).join("");
  }
  function closeDeleteTopoModal() {
    document.getElementById("topo-delete-topo-modal-overlay").classList.add("hidden");
  }
  function confirmDeleteTopo() {
    const appName = document.getElementById("topo-delete-topo-app-select").value;
    const topoId = document.getElementById("topo-delete-topo-select").value;
    if (!appName || !topoId) return;
    const store = loadStore();
    if (store[appName]) {
      delete store[appName].topologies[topoId];
      saveStore(store);
    }
    if (state.currentApp === appName && state.currentTopoId === topoId) {
      state.currentTopoId = null;
      renderTopologySelect();
    }
    closeDeleteTopoModal();
    renderGraph();
  }

  /* ─── Connect Nodes modal (manual prefill + full pop-up flow) ────────── */
  let connectPrefill = null;

  function allNodesFlat(store) {
    const flat = [];
    state.apps.forEach(app => {
      topologyList(store, app).forEach(topo => {
        topo.nodes.forEach(n => flat.push({ app, topoId: topo.id, node: n }));
      });
    });
    return flat;
  }

  function nodeOptionsHtml(entries, selectedId) {
    return entries.map(e =>
      `<option value="${Utils.escapeHtml(e.node.id)}"${e.node.id === selectedId ? " selected" : ""}>${Utils.escapeHtml(e.node.label)} (${e.node.kind})</option>`
    ).join("");
  }

  function refreshConnectNodeSelect(appSelectId, nodeSelectId, selectedNodeId) {
    const store = loadStore();
    const appName = document.getElementById(appSelectId).value;
    const entries = allNodesFlat(store).filter(e => e.app === appName);
    document.getElementById(nodeSelectId).innerHTML = nodeOptionsHtml(entries, selectedNodeId);
  }

  function openConnectModal(opts) {
    opts = opts || {};
    connectPrefill = opts;
    const store = loadStore();
    if (!state.apps.length) return;

    const fromAppSel = document.getElementById("topo-connect-from-app-select");
    const toAppSel   = document.getElementById("topo-connect-to-app-select");
    fromAppSel.innerHTML = state.apps.map(a => `<option value="${Utils.escapeHtml(a)}">${Utils.escapeHtml(a)}</option>`).join("");
    toAppSel.innerHTML   = state.apps.map(a => `<option value="${Utils.escapeHtml(a)}">${Utils.escapeHtml(a)}</option>`).join("");

    fromAppSel.value = (opts.prefillFrom && opts.prefillFrom.app) || state.currentApp || state.apps[0];
    toAppSel.value   = (opts.prefillTo && opts.prefillTo.app) || state.currentApp || state.apps[0];

    refreshConnectNodeSelect("topo-connect-from-app-select", "topo-connect-from-select", opts.prefillFrom && opts.prefillFrom.nodeId);
    refreshConnectNodeSelect("topo-connect-to-app-select",   "topo-connect-to-select",   opts.prefillTo && opts.prefillTo.nodeId);

    document.getElementById("topo-connect-type-select").value = "hosts";
    document.getElementById("topo-connect-custom-type-row").classList.add("hidden");
    document.getElementById("topo-connect-custom-type-input").value = "";

    document.getElementById("topo-connect-modal-title").textContent =
      (opts.prefillFrom && opts.prefillTo) ? "Connect Nodes (from canvas — pick a type)" : "Connect Nodes";

    document.getElementById("topo-connect-modal-overlay").classList.remove("hidden");
  }

  function closeConnectModal() {
    document.getElementById("topo-connect-modal-overlay").classList.add("hidden");
    connectPrefill = null;
  }

  function saveConnectModal() {
    const fromId = document.getElementById("topo-connect-from-select").value;
    const toId = document.getElementById("topo-connect-to-select").value;
    const typeSel = document.getElementById("topo-connect-type-select").value;
    const type = typeSel === "custom"
      ? (document.getElementById("topo-connect-custom-type-input").value.trim() || "custom")
      : typeSel;
    if (!fromId || !toId || fromId === toId) { closeConnectModal(); return; }

    const store = loadStore();
    const fromFound = findNodeAnywhere(store, fromId);
    const toFound = findNodeAnywhere(store, toId);
    if (!fromFound || !toFound) { closeConnectModal(); return; }

    // Edges live on the "from" node's topology — cross-topology connections
    // (e.g. Estate view stitching) are recorded there.
    const topo = store[fromFound.app].topologies[fromFound.topoId];
    const already = topo.edges.some(e =>
      (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)
    );
    if (!already) {
      topo.edges.push({ from: fromId, to: toId, origin: "manual", problem: false, type });
      saveStore(store);
      renderGraph();
    }
    closeConnectModal();
  }

  /* ─── Add Node modal ──────────────────────────────────────────────────── */
  function openAddNodeModal() {
    const appSel = document.getElementById("topo-add-node-app-select");
    appSel.innerHTML = state.apps.map(a => `<option value="${Utils.escapeHtml(a)}"${a === state.currentApp ? " selected" : ""}>${Utils.escapeHtml(a)}</option>`).join("");
    refreshAddNodeTopoSelect();
    refreshAddNodePool();
    appSel.onchange = () => { refreshAddNodeTopoSelect(); };
    document.getElementById("topo-add-node-kind-select").onchange = refreshAddNodePool;
    document.getElementById("topo-add-node-modal-overlay").classList.remove("hidden");
  }

  function refreshAddNodeTopoSelect() {
    const appName = document.getElementById("topo-add-node-app-select").value;
    const store = loadStore();
    const topos = topologyList(store, appName);
    document.getElementById("topo-add-node-topo-select").innerHTML = topos.map(t =>
      `<option value="${Utils.escapeHtml(t.id)}">${Utils.escapeHtml(t.label)}</option>`
    ).join("");
  }

  function refreshAddNodePool() {
    const kind = document.getElementById("topo-add-node-kind-select").value;
    const pool = (global.DEMO_DATA && global.DEMO_DATA.topologyNodePool && global.DEMO_DATA.topologyNodePool[kind]) || [];
    const sel = document.getElementById("topo-add-node-select");
    sel.innerHTML = pool.length
      ? pool.map((p, i) => `<option value="${i}">${Utils.escapeHtml(p.label)} — ${Utils.escapeHtml(p.source)}</option>`).join("")
      : `<option value="">(no ${Utils.escapeHtml(kind)} entities in the imported demo data)</option>`;
  }

  function closeAddNodeModal() {
    document.getElementById("topo-add-node-modal-overlay").classList.add("hidden");
  }

  function saveAddNodeModal() {
    const appName = document.getElementById("topo-add-node-app-select").value;
    const topoId  = document.getElementById("topo-add-node-topo-select").value;
    const kind    = document.getElementById("topo-add-node-kind-select").value;
    const idx     = document.getElementById("topo-add-node-select").value;
    if (!appName || !topoId || idx === "") return;

    const pool = (global.DEMO_DATA && global.DEMO_DATA.topologyNodePool && global.DEMO_DATA.topologyNodePool[kind]) || [];
    const picked = pool[Number(idx)];
    if (!picked) return;

    const store = loadStore();
    const topo = store[appName] && store[appName].topologies[topoId];
    if (!topo) return;

    topo.nodes.push({
      id: nextId(kind), label: picked.label, kind,
      origin: "manual", status: "healthy",
      source: picked.source, entityId: picked.entityId,
    });
    saveStore(store);
    closeAddNodeModal();
    renderGraph();
  }

  /* ─── Refresh from Sources — diff + reconciliation (Focused view) ────── */
  let pendingReconcile = null;

  function computeDiff(existing, fresh) {
    const existingIds = new Set(existing.nodes.map(n => n.label)); // compare by label (stand-in for a stable external key)
    const freshIds = new Set(fresh.nodes.map(n => n.label));
    const added = fresh.nodes.filter(n => !existingIds.has(n.label));
    const removed = existing.nodes.filter(n => n.origin === "discovered" && !freshIds.has(n.label));
    return { added, removed };
  }

  function openReconcileModal() {
    const store = loadStore();
    const topo = getFocusedTopology(store);
    if (!topo) return;
    const fresh = generateMockTopology(state.currentApp, topo.sourceLabel || "Source");
    const diff = computeDiff(topo, fresh);

    if (!diff.added.length && !diff.removed.length) {
      renderGraph();
      return;
    }

    pendingReconcile = { fresh, diff };
    const list = document.getElementById("topo-reconcile-list");
    list.innerHTML = [
      ...diff.added.map(n => `
        <label class="topo-diff-item added"><input type="checkbox" class="reconcile-add" data-label="${Utils.escapeHtml(n.label)}" checked />
          <span class="tag">NEW</span> ${Utils.escapeHtml(n.label)} (${Utils.escapeHtml(n.kind)})</label>`),
      ...diff.removed.map(n => `
        <label class="topo-diff-item removed"><input type="checkbox" class="reconcile-remove" data-id="${Utils.escapeHtml(n.id)}" checked />
          <span class="tag">GONE</span> ${Utils.escapeHtml(n.label)} (${Utils.escapeHtml(n.kind)}) — no longer reported by source</label>`),
    ].join("");

    document.getElementById("topo-reconcile-modal-overlay").classList.remove("hidden");
  }

  function closeReconcileModal() {
    document.getElementById("topo-reconcile-modal-overlay").classList.add("hidden");
    pendingReconcile = null;
  }

  function applyReconcile() {
    if (!pendingReconcile) { closeReconcileModal(); return; }
    const store = loadStore();
    const topo = getFocusedTopology(store);
    if (!topo) { closeReconcileModal(); return; }

    const acceptedAddLabels = new Set(
      Array.from(document.querySelectorAll(".reconcile-add:checked")).map(el => el.dataset.label)
    );
    const acceptedRemoveIds = new Set(
      Array.from(document.querySelectorAll(".reconcile-remove:checked")).map(el => el.dataset.id)
    );

    // Apply accepted removals: drop the node; if the connection can no
    // longer persist (either endpoint gone), drop the edge too.
    topo.nodes = topo.nodes.filter(n => !acceptedRemoveIds.has(n.id));
    const remainingIds = new Set(topo.nodes.map(n => n.id));
    topo.edges = topo.edges.filter(e => remainingIds.has(e.from) && remainingIds.has(e.to));

    // Apply accepted additions from the fresh fetch (nodes + the edges that
    // connect only newly-added nodes to each other/existing ones).
    const newNodes = pendingReconcile.fresh.nodes.filter(n => acceptedAddLabels.has(n.label));
    topo.nodes = topo.nodes.concat(newNodes);
    const nowIds = new Set(topo.nodes.map(n => n.id));
    const newEdges = pendingReconcile.fresh.edges.filter(e => nowIds.has(e.from) && nowIds.has(e.to));
    newEdges.forEach(e => {
      const dup = topo.edges.some(x => (x.from === e.from && x.to === e.to) || (x.from === e.to && x.to === e.from));
      if (!dup) topo.edges.push(e);
    });

    saveStore(store);
    closeReconcileModal();
    renderGraph();
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
    document.querySelectorAll("#topo-add-kind-segmented .seg-btn").forEach(btn =>
      btn.addEventListener("click", () => setAddTopoKind(btn.dataset.kind))
    );
    document.getElementById("topo-add-mcp-server-select").addEventListener("change", updateMcpRegistrySelect);

    document.getElementById("topo-connect-btn").addEventListener("click", () => openConnectModal({}));
    document.getElementById("topo-connect-modal-close-btn").addEventListener("click", closeConnectModal);
    document.getElementById("topo-connect-modal-cancel-btn").addEventListener("click", closeConnectModal);
    document.getElementById("topo-connect-modal-save-btn").addEventListener("click", saveConnectModal);
    document.getElementById("topo-connect-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "topo-connect-modal-overlay") closeConnectModal();
    });
    document.getElementById("topo-connect-from-app-select").addEventListener("change", () =>
      refreshConnectNodeSelect("topo-connect-from-app-select", "topo-connect-from-select", null)
    );
    document.getElementById("topo-connect-to-app-select").addEventListener("change", () =>
      refreshConnectNodeSelect("topo-connect-to-app-select", "topo-connect-to-select", null)
    );
    document.getElementById("topo-connect-type-select").addEventListener("change", (e) => {
      document.getElementById("topo-connect-custom-type-row").classList.toggle("hidden", e.target.value !== "custom");
    });

    document.getElementById("topo-add-app-modal-close-btn").addEventListener("click", closeAddAppModal);
    document.getElementById("topo-add-app-modal-cancel-btn").addEventListener("click", closeAddAppModal);
    document.getElementById("topo-add-app-modal-save-btn").addEventListener("click", saveAddAppModal);

    document.getElementById("topo-delete-app-modal-close-btn").addEventListener("click", closeDeleteAppModal);
    document.getElementById("topo-delete-app-modal-cancel-btn").addEventListener("click", closeDeleteAppModal);
    document.getElementById("topo-delete-app-modal-confirm-btn").addEventListener("click", confirmDeleteApp);

    document.getElementById("topo-delete-topo-modal-close-btn").addEventListener("click", closeDeleteTopoModal);
    document.getElementById("topo-delete-topo-modal-cancel-btn").addEventListener("click", closeDeleteTopoModal);
    document.getElementById("topo-delete-topo-modal-confirm-btn").addEventListener("click", confirmDeleteTopo);

    document.getElementById("topo-add-node-modal-close-btn").addEventListener("click", closeAddNodeModal);
    document.getElementById("topo-add-node-modal-cancel-btn").addEventListener("click", closeAddNodeModal);
    document.getElementById("topo-add-node-modal-save-btn").addEventListener("click", saveAddNodeModal);

    document.getElementById("topo-reconcile-modal-close-btn").addEventListener("click", closeReconcileModal);
    document.getElementById("topo-reconcile-modal-cancel-btn").addEventListener("click", closeReconcileModal);
    document.getElementById("topo-reconcile-modal-apply-btn").addEventListener("click", applyReconcile);
  }

  /* ─── Bootstrap ───────────────────────────────────────────────────────── */
  async function initPage() {
    await loadMcpServers();
    const store = loadStore();
    state.apps = Object.keys(store);
    state.currentApp = state.apps[0] || null;
    if (state.currentApp) {
      const topos = topologyList(store, state.currentApp);
      state.currentTopoId = topos[0] ? topos[0].id : null;
    }
    renderAppSelect();
    applyViewVisibility();
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