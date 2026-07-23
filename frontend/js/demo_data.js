/**
 * demo_data.js — Static demo/fallback data for Infrastructure, Services,
 * Network Devices, and Processes.
 *
 * Purpose: lets the dashboard be demoed with populated tables even when
 * DashboardMiddleware isn't running (no backend to hit). api.js uses these
 * as its *fallback* value (same slot that currently holds `{ ... : [] }`) —
 * so if a real backend responds, its data wins; DEMO_DATA is only shown
 * when the real endpoint is unreachable or returns nothing usable.
 *
 * Must load BEFORE api.js.
 */

"use strict";

window.DEMO_DATA = {
  infrastructure: [
    { source: "dynatrace",   application: "Payments Gateway",   hostName: "web-prod-01",     osType: "Linux (Ubuntu 22.04)",   status: "Online",   entityId: "HOST-7A61C3F0" },
    { source: "dynatrace",   application: "Payments Gateway",   hostName: "web-prod-02",     osType: "Linux (Ubuntu 22.04)",   status: "Online",   entityId: "HOST-7A61C3F1" },
    { source: "dynatrace",   application: "Payments Gateway",   hostName: "db-primary-01",   osType: "Linux (RHEL 9)",         status: "Online",   entityId: "HOST-3E29B7D2" },
    { source: "dynatrace",   application: "Payments Gateway",   hostName: "db-replica-01",   osType: "Linux (RHEL 9)",         status: "Degraded", entityId: "HOST-3E29B7D3" },
    { source: "appdynamics", application: "Customer Portal",    hostName: "cache-redis-01",  osType: "Linux (Amazon Linux 2)", status: "Online",   entityId: "HOST-9C10F4A8" },
    { source: "appdynamics", application: "Customer Portal",    hostName: "app-worker-01",   osType: "Linux (Ubuntu 22.04)",   status: "Online",   entityId: "HOST-1D88E245" },
    { source: "appdynamics", application: "Customer Portal",    hostName: "app-worker-02",   osType: "Linux (Ubuntu 22.04)",   status: "Offline",  entityId: "HOST-1D88E246" },
    { source: "opmanager",   application: "Order Fulfillment",  hostName: "lb-edge-01",      osType: "Linux (Alpine 3.19)",    status: "Online",   entityId: "HOST-56F0A9BC" },
    { source: "opmanager",   application: "Order Fulfillment",  hostName: "win-app-01",      osType: "Windows Server 2022",    status: "Online",   entityId: "HOST-EE41C0A7" },
    { source: "heal",        application: "Internal Analytics", hostName: "batch-runner-01", osType: "Linux (Ubuntu 20.04)",   status: "Degraded", entityId: "HOST-2B7790D1" },
  ],

  services: [
    { source: "dynatrace",   application: "Payments Gateway",   serviceName: "checkout-api",       type: "REST API",       status: "Online",   tags: ["payments", "customer-facing"], entityId: "SVC-9A1D2E40" },
    { source: "dynatrace",   application: "Payments Gateway",   serviceName: "auth-service",       type: "gRPC",           status: "Online",   tags: ["identity", "internal"],        entityId: "SVC-9A1D2E41" },
    { source: "appdynamics", application: "Customer Portal",    serviceName: "inventory-worker",   type: "Background Job", status: "Degraded", tags: ["fulfillment", "batch"],        entityId: "SVC-4C77B310" },
    { source: "appdynamics", application: "Customer Portal",    serviceName: "notification-svc",   type: "Message Queue",  status: "Online",   tags: ["email", "sms", "internal"],    entityId: "SVC-4C77B311" },
    { source: "opmanager",   application: "Order Fulfillment",  serviceName: "search-indexer",     type: "Background Job", status: "Offline",  tags: ["search", "batch"],             entityId: "SVC-1F60D922" },
    { source: "heal",        application: "Internal Analytics", serviceName: "recommendation-api", type: "REST API",       status: "Online",   tags: ["ml", "customer-facing"],       entityId: "SVC-1F60D923" },
  ],

  networkDevices: [
    { source: "opmanager",   application: "Order Fulfillment",  deviceName: "core-switch-01",  deviceType: "Switch",             devicesConnected: 24, servicesConnected: 6, status: "Online",   id: "NET-3AB10F01" },
    { source: "opmanager",   application: "Order Fulfillment",  deviceName: "edge-router-01",  deviceType: "Router",             devicesConnected: 4,  servicesConnected: 3, status: "Online",   id: "NET-3AB10F02" },
    { source: "opmanager",   application: "Order Fulfillment",  deviceName: "fw-perimeter-01", deviceType: "Firewall",           devicesConnected: 12, servicesConnected: 8, status: "Online",   id: "NET-3AB10F03" },
    { source: "dynatrace",   application: "Payments Gateway",   deviceName: "lb-appliance-01", deviceType: "Load Balancer",      devicesConnected: 8,  servicesConnected: 5, status: "Degraded", id: "NET-6C21E907" },
    { source: "appdynamics", application: "Customer Portal",    deviceName: "wifi-ap-14",      deviceType: "Access Point",       devicesConnected: 32, servicesConnected: 1, status: "Online",   id: "NET-9F04C118" },
    { source: "heal",        application: "Internal Analytics", deviceName: "nas-storage-02",  deviceType: "Storage Appliance",  devicesConnected: 2,  servicesConnected: 2, status: "Offline",  id: "NET-1D77A230" },
  ],

  processes: [
    { source: "dynatrace",   application: "Payments Gateway",   processName: "checkout-api.jar",       processType: "Java Process",    hostingService: "checkout-api",       status: "Online",   id: "PROC-7710A1" },
    { source: "dynatrace",   application: "Payments Gateway",   processName: "auth-service.jar",       processType: "Java Process",    hostingService: "auth-service",       status: "Online",   id: "PROC-7710A2" },
    { source: "dynatrace",   application: "Payments Gateway",   processName: "postgres",               processType: "Database Engine", hostingService: "db-primary-01",      status: "Online",   id: "PROC-7710A3" },
    { source: "appdynamics", application: "Customer Portal",    processName: "inventory-worker.py",    processType: "Python Process",  hostingService: "inventory-worker",   status: "Degraded", id: "PROC-4C22B1" },
    { source: "appdynamics", application: "Customer Portal",    processName: "notification-svc.node",  processType: "Node.js Process", hostingService: "notification-svc",   status: "Online",   id: "PROC-4C22B2" },
    { source: "opmanager",   application: "Order Fulfillment",  processName: "search-indexer.py",      processType: "Python Process",  hostingService: "search-indexer",     status: "Offline",  id: "PROC-1F33C1" },
    { source: "opmanager",   application: "Order Fulfillment",  processName: "nginx",                  processType: "Web Server",      hostingService: "lb-edge-01",         status: "Online",   id: "PROC-1F33C2" },
    { source: "heal",        application: "Internal Analytics", processName: "recommendation-api.jar", processType: "Java Process",    hostingService: "recommendation-api", status: "Online",   id: "PROC-2B44D1" },
    { source: "heal",        application: "Internal Analytics", processName: "batch-runner.sh",        processType: "Shell Process",   hostingService: "batch-runner-01",    status: "Degraded", id: "PROC-2B44D2" },
  ],

  // ── Topology demo data ──────────────────────────────────────────────────
  // New data model: one entry per application; each application holds a
  // dict of *topologies* (one per source you've added — MCP / API / Blank),
  // each with its own nodes/edges. This is what topology.js seeds its
  // localStorage store from on first load (see seedStore() in topology.js).
  topology: {
    "Payments Gateway": {
      topologies: {
        "topo-pg-dt": {
          id: "topo-pg-dt", label: "DynaTrace", kind: "mcp", sourceLabel: "DynaTrace", mcpServerId: "dynatrace",
          nodes: [
            { id: "pg-host-1", label: "web-prod-01",   kind: "host",     origin: "discovered", status: "problem",  source: "DynaTrace", entityId: "HOST-7A61C3F0" },
            { id: "pg-host-2", label: "web-prod-02",   kind: "host",     origin: "discovered", status: "healthy",  source: "DynaTrace", entityId: "HOST-7A61C3F1" },
            { id: "pg-host-3", label: "db-primary-01", kind: "host",     origin: "discovered", status: "healthy",  source: "DynaTrace", entityId: "HOST-3E29B7D2" },
            { id: "pg-pg-1",   label: "proc-group-1",  kind: "procgroup",origin: "discovered", status: "problem",  source: "DynaTrace", entityId: "PG-1001" },
            { id: "pg-pg-2",   label: "proc-group-2",  kind: "procgroup",origin: "discovered", status: "healthy",  source: "DynaTrace", entityId: "PG-1002" },
            { id: "pg-svc-1",  label: "checkout-api",  kind: "service",  origin: "discovered", status: "problem",  source: "DynaTrace", entityId: "SVC-9A1D2E40" },
            { id: "pg-svc-2",  label: "auth-service",  kind: "service",  origin: "discovered", status: "healthy",  source: "DynaTrace", entityId: "SVC-9A1D2E41" },
          ],
          edges: [
            { from: "pg-host-1", to: "pg-pg-1",  origin: "discovered", problem: true,  type: "hosts" },
            { from: "pg-host-2", to: "pg-pg-2",  origin: "discovered", problem: false, type: "hosts" },
            { from: "pg-pg-1",   to: "pg-svc-1", origin: "discovered", problem: true,  type: "runs" },
            { from: "pg-pg-2",   to: "pg-svc-2", origin: "discovered", problem: false, type: "runs" },
            { from: "pg-svc-2",  to: "pg-svc-1", origin: "manual",     problem: false, type: "depends-on" },
          ],
        },
      },
    },
    "Customer Portal": {
      topologies: {
        "topo-cp-apd": {
          id: "topo-cp-apd", label: "AppDynamics", kind: "mcp", sourceLabel: "AppDynamics", mcpServerId: "appdynamics",
          nodes: [
            { id: "cp-host-1", label: "app-worker-01",     kind: "host",    origin: "discovered", status: "healthy",  source: "AppDynamics", entityId: "HOST-1D88E245" },
            { id: "cp-host-2", label: "app-worker-02",     kind: "host",    origin: "discovered", status: "disconnected", source: "AppDynamics", entityId: "HOST-1D88E246" },
            { id: "cp-svc-1",  label: "inventory-worker",  kind: "service", origin: "discovered", status: "problem",  source: "AppDynamics", entityId: "SVC-4C77B310" },
            { id: "cp-svc-2",  label: "notification-svc",  kind: "service", origin: "discovered", status: "healthy",  source: "AppDynamics", entityId: "SVC-4C77B311" },
          ],
          edges: [
            { from: "cp-host-1", to: "cp-svc-2", origin: "discovered", problem: false, type: "hosts" },
            { from: "cp-host-2", to: "cp-svc-1", origin: "discovered", problem: true,  type: "hosts" },
          ],
        },
      },
    },
    "Order Fulfillment": {
      // Intentionally has an empty/blank topology — demonstrates the
      // "Blank" add-topology option and the empty-state UI.
      topologies: {
        "topo-of-blank": {
          id: "topo-of-blank", label: "Blank", kind: "blank", sourceLabel: "Manual", mcpServerId: null,
          nodes: [],
          edges: [],
        },
      },
    },
  },

  // Populated-entity pools the Add Node modal reads from (mirroring
  // Infrastructure / Services / Network Devices / Processes demo data
  // above, reshaped as topology-node candidates keyed by kind).
  topologyNodePool: {
    host:      [ { label: "cache-redis-01", entityId: "HOST-9C10F4A8", source: "AppDynamics" }, { label: "lb-edge-01", entityId: "HOST-56F0A9BC", source: "OPManager" }, { label: "win-app-01", entityId: "HOST-EE41C0A7", source: "OPManager" }, { label: "batch-runner-01", entityId: "HOST-2B7790D1", source: "HEAL" } ],
    service:   [ { label: "search-indexer", entityId: "SVC-1F60D922", source: "OPManager" }, { label: "recommendation-api", entityId: "SVC-1F60D923", source: "HEAL" } ],
    device:    [ { label: "core-switch-01", entityId: "NET-3AB10F01", source: "OPManager" }, { label: "edge-router-01", entityId: "NET-3AB10F02", source: "OPManager" }, { label: "fw-perimeter-01", entityId: "NET-3AB10F03", source: "OPManager" }, { label: "lb-appliance-01", entityId: "NET-6C21E907", source: "DynaTrace" } ],
    process:   [ { label: "postgres", entityId: "PROC-7710A3", source: "DynaTrace" }, { label: "search-indexer.py", entityId: "PROC-1F33C1", source: "OPManager" }, { label: "nginx", entityId: "PROC-1F33C2", source: "OPManager" }, { label: "batch-runner.sh", entityId: "PROC-2B44D2", source: "HEAL" } ],
    procgroup: [ { label: "proc-group-3", entityId: "PG-2001", source: "AppDynamics" }, { label: "proc-group-4", entityId: "PG-2002", source: "OPManager" } ],
  },
};

