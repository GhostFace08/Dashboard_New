/**
 * config.js
 * Static configuration constants for the entire frontend.
 * No API URLs here — those live in api.js.
 * No logic — pure data.
 */

"use strict";

/* ─── Views ──────────────────────────────────────────────────────────────── */

const VIEWS = [
  "dashboard", "ai-monitoring", "infrastructure", "services", "capacity",
  "topology", "ai-chat", "user-management", "auto-escalation", "about-faq",
  "settings",
];

/* ─── Sidebar Navigation Registry ────────────────────────────────────────── *
 * Single source of truth for the shell's sidebar AND its iframe registry.
 * common.js reads this to render the sidebar; index.html reads it to build
 * the TAB_TO_FRAME map and the <iframe> elements themselves — so adding a
 * page later (Phases 6-12) means editing this one array, nothing else.
 *
 * Each item:
 *   id     — tab id, matches data-tab / TAB_TO_FRAME key
 *   label  — nav label text
 *   icon   — lucide icon name
 *   href   — shell-relative path to the page (pages/xxx.html)
 *   ready  — true once the real page exists. false = page not yet built
 *            (Phases 6-12); the shell shows a lightweight "coming soon"
 *            placeholder in that tab's iframe instead of `href`, and the
 *            nav item gets a small "Soon" badge. Flip to true the same
 *            turn the real pages/xxx.html file is delivered.
 *
 * Groups are rendered in array order. A null `label` renders no section
 * heading (used for standalone items like Chat/Settings that sit between
 * labelled groups, per the agreed IA).
 */
const SIDEBAR_NAV = [
  {
    label: "Dashboard",
    items: [
      { id: "dashboard",       label: "Observability",   icon: "layout-dashboard", href: "pages/dashboard.html",       ready: true  },
      { id: "ai-monitoring",   label: "AI Monitoring",   icon: "bot",              href: "pages/ai_monitoring.html",   ready: true  },
      { id: "infrastructure",  label: "Infrastructure",  icon: "server",           href: "pages/infrastructure.html",  ready: true },
      { id: "services",        label: "Services",        icon: "boxes",            href: "pages/services.html",        ready: true },
      { id: "network-devices", label: "Network Devices", icon: "router",           href: "pages/network_devices.html", ready: true },
      { id: "capacity",        label: "Capacity",        icon: "trending-up",      href: "pages/capacity.html",        ready: true },
      { id: "topology",        label: "Topology",        icon: "share-2",          href: "pages/topology.html",        ready: true },
    ],
  },
  {
    label: null,
    items: [
      { id: "ai-chat",         label: "Chat",             icon: "message-square",  href: "pages/ai_chat.html",         ready: true  },
    ],
  },
  {
    label: "Admin",
    items: [
      { id: "user-management", label: "User Management", icon: "users",            href: "pages/user_management.html", ready: true },
      { id: "auto-escalation", label: "Auto-Escalation",  icon: "alert-triangle",   href: "pages/auto_escalation.html", ready: true },
      { id: "about-faq",       label: "About & FAQ",      icon: "help-circle",      href: "pages/about_faq.html",       ready: true },
    ],
  },
  {
    label: null,
    items: [
      { id: "settings",        label: "Settings",         icon: "settings",        href: "pages/settings.html",        ready: true  },
    ],
  },
];

/* ─── APM Tools ──────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    id:          "dynatrace",
    name:        "DynaTrace",
    shortName:   "DT",
    color:       "#6366f1",
    status:      "online",
    latency:     "14ms",
    description: "APM & Infrastructure",
    url:         "https://www.dynatrace.com",
  },
  {
    id:          "opmanager",
    name:        "OPManager",
    shortName:   "OPM",
    color:       "#f59e0b",
    status:      "online",
    latency:     "31ms",
    description: "Network & Server",
    url:         "https://www.manageengine.com/network-monitoring",
  },
  {
    id:          "appdynamics",
    name:        "AppDynamics",
    shortName:   "APD",
    color:       "#10b981",
    status:      "degraded",
    latency:     "412ms",
    description: "Application Performance",
    url:         "https://www.appdynamics.com",
  },
  {
    id:          "heal",
    name:        "HEAL",
    shortName:   "HL",
    color:       "#00e5c3",
    status:      "online",
    latency:     "9ms",
    description: "AI Remediation",
    url:         "https://heal.com",
  },
];

/** Fast O(1) lookup: TOOL_MAP["dynatrace"] → tool object */
const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.id, t]));

/* ─── Issue Categories ───────────────────────────────────────────────────── */

const CATEGORIES = [
  "Availability",
  "Performance",
  "Infrastructure",
  "Application Error",
  "Security",
];

/* ─── Severity ───────────────────────────────────────────────────────────── */

const SEVERITIES = ["Critical", "High", "Medium", "Low"];

const SEVERITY_COLOR = {
  Critical: { bg: "rgba(229,83,75,0.15)",  text: "#e5534b", border: "rgba(229,83,75,0.30)"  },
  High:     { bg: "rgba(229,160,48,0.15)", text: "#e5a030", border: "rgba(229,160,48,0.30)" },
  Medium:   { bg: "rgba(91,138,240,0.15)", text: "#5b8af0", border: "rgba(91,138,240,0.30)" },
  Low:      { bg: "rgba(127,127,127,0.15)",text: "#888",    border: "rgba(127,127,127,0.3)" },
};

/* ─── Status ─────────────────────────────────────────────────────────────── */

const STATUSES = ["Active", "Resolved"];

const STATUS_COLOR = {
  Active:   { bg: "rgba(229,83,75,0.15)",  text: "#e5534b", border: "rgba(229,83,75,0.30)"  },
  Resolved: { bg: "rgba(99,102,241,0.10)", text: "var(--primary)", border: "rgba(99,102,241,0.20)" },
};

/* ─── Time Range Options ─────────────────────────────────────────────────── */

const TIME_RANGE_OPTIONS = [
  "5 min",
  "10 min",
  "15 min",
  "30 min",
  "1 hr",
  "6 hr",
  "24 hr",
  "7 days",
  "Custom",
];

/** Millisecond values for each preset — Custom resolved separately */
const TIME_RANGE_MS = {
  "5 min":   5   * 60 * 1000,
  "10 min":  10  * 60 * 1000,
  "15 min":  15  * 60 * 1000,
  "30 min":  30  * 60 * 1000,
  "1 hr":    1   * 60 * 60 * 1000,
  "6 hr":    6   * 60 * 60 * 1000,
  "24 hr":   24  * 60 * 60 * 1000,
  "7 days":  7   * 24 * 60 * 60 * 1000,
};

const DEFAULT_RANGE_MS = TIME_RANGE_MS["15 min"];
const MAX_RANGE_MS     = TIME_RANGE_MS["7 days"];

/* ─── Dashboard Table ────────────────────────────────────────────────────── */

const TABLE_PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 10;

/**
 * Column definitions for the issues table.
 * key   — field name on the normalised issue object (set by mapping.json at runtime).
 * label — header text shown in the UI.
 * sortable — whether the column header is clickable for sort.
 * width — optional CSS min-width hint.
 */
const TABLE_COLUMNS = [
  { key: "srNo",            label: "Sr. No.",          sortable: true  },
  { key: "source",          label: "Source",           sortable: true  },
  { key: "issueId",         label: "Issue ID",         sortable: true  },
  { key: "application",     label: "Application",      sortable: true  },
  { key: "title",           label: "Title",            sortable: true  },
  { key: "affectedEntities",label: "Affected Entities",sortable: false },
  { key: "severity",        label: "Severity",         sortable: true  },
  { key: "category",        label: "Category",         sortable: true  },
  { key: "description",     label: "Description",      sortable: false },
  { key: "status",          label: "Status",           sortable: true  },
  { key: "startTime",       label: "Start Time",       sortable: true  },
  { key: "endTime",         label: "End Time",         sortable: true  },
  { key: "duration",        label: "Duration",         sortable: true  },
];

/* ─── Default Mapping Schema ─────────────────────────────────────────────── */
/**
 * Fallback mapping used when mapping.json cannot be loaded.
 * Each tool maps its raw JSON field names to the canonical dashboard fields.
 * This mirrors the hardcoded logic that was in DashboardView.tsx.
 *
 * Structure:
 *   DEFAULT_MAPPING[toolId][canonicalField] = "rawFieldNameInAPMJson"
 *
 * Special value "__detect__" means the normaliser auto-detects (e.g. source).
 */
const DEFAULT_MAPPING = {
  dynatrace: {
    issueId:          "display_id",
    title:            "event.name",
    application:      "affected_entity_names[0]",
    affectedEntities: "affected_entity_names",
    severity:         "event.severity",       // numeric 1-5
    category:         "event.category",
    status:           "event.status",         // ACTIVE → Active
    startTime:        "event.start",
    endTime:          "event.end",
    description:      "event.description",
  },
  opmanager: {
    issueId:          "alarmId",
    title:            "message",
    application:      "displayName",
    affectedEntities: "displayName",
    severity:         "severity",             // text: Critical/Major/…
    category:         "category",
    status:           "status",               // non-CLEAR → Active
    startTime:        "modTime",
    endTime:          null,                   // OPManager has no end time
    description:      "message",
  },
  appdynamics: {
    issueId:          "id",
    title:            "name",
    application:      "application",
    affectedEntities: "affectedEntities",
    severity:         "severity",
    category:         "category",
    status:           "status",
    startTime:        "startTime",
    endTime:          "endTime",
    description:      "description",
  },
  heal: {
    issueId:          "id",
    title:            "title",
    application:      "application",
    affectedEntities: "affectedEntities",
    severity:         "severity",
    category:         "category",
    status:           "status",
    startTime:        "startTime",
    endTime:          "endTime",
    description:      "description",
  },
};

/* ─── Default Category Rules ─────────────────────────────────────────────── */
/**
 * Fallback used when category.json cannot be loaded.
 * Array of { keyword, category } objects — first match wins.
 */
const DEFAULT_CATEGORY_RULES = [
  { keyword: "down",        category: "Availability"     },
  { keyword: "outage",      category: "Availability"     },
  { keyword: "unreachable", category: "Availability"     },
  { keyword: "timeout",     category: "Availability"     },
  { keyword: "latency",     category: "Performance"      },
  { keyword: "slow",        category: "Performance"      },
  { keyword: "response",    category: "Performance"      },
  { keyword: "cpu",         category: "Infrastructure"   },
  { keyword: "memory",      category: "Infrastructure"   },
  { keyword: "disk",        category: "Infrastructure"   },
  { keyword: "network",     category: "Infrastructure"   },
  { keyword: "error",       category: "Application Error"},
  { keyword: "exception",   category: "Application Error"},
  { keyword: "5xx",         category: "Application Error"},
  { keyword: "fault",       category: "Application Error"},
  { keyword: "ssl",         category: "Security"         },
  { keyword: "auth",        category: "Security"         },
  { keyword: "unauthorized",category: "Security"         },
  { keyword: "intrusion",   category: "Security"         },
];

/* ─── KPI Definitions ────────────────────────────────────────────────────── */
/**
 * Static KPI card definitions. Values are always computed from filteredIssues
 * at runtime — never hardcoded here.
 */
const KPI_DEFINITIONS = CATEGORIES.map(cat => ({ category: cat }));

/* ─── Settings Defaults ──────────────────────────────────────────────────── */

const SETTINGS_DEFAULTS = {
  /* General */
  logLevel:    "INFO",
  logFile:     "logs/agent.log",
  logSize:     10485760,
  logBackups:  5,

  /* Dashboard */
  periodicFetchTime:  "15 min",
  uiRefreshInterval:  1,
  landingView:        "dashboard",
  periodicCheckTime:  300,   // 5 min — how often the middleware checks the file
  defaultSort:        "startTime-desc",
  showAcknowledged:   false,
  showResolved:       true,
  compactMode:        false,
  density:            "comfortable",
  theme:              "dark",
  notifDesktop:       true,
  notifSound:         false,
  notifCriticalOnly:  true,

  /* AI & Models */
  llmUrl:       "http://localhost:11434",
  llmModel:     "qwen2.5",
  temperature:  0.2,
  maxTokens:    2048,
  intentMode:   "hybrid",
  confidence:   0.7,
  llmTimeout:   15,
  keywords:     ["SOP","incident","runbook","playbook","guide","documentation","report","policy","procedure","postmortem"],

  /* RAG */
  ragBaseUrl:          "http://localhost:8000",
  ragDataEndpoint:     "/data",
  ragAskEndpoint:      "/ask",
  ragMetadataFile:     "metadata.json",
  ragTimeout:          30,
  uploadFolder:        "storage/uploads",
  vectorStore:         "storage/vectors",
  bm25Store:           "storage/bm25",
  instructionsFile:    "config/instructions.md",
  faqFile:             "config/faq.json",
  metadataFile2:       "config/metadata.json",
  settingsFile:        "config/settings.yaml",

  /* Search & Ranking */
  embedModel:      "bge-small-en-v1.5",
  chunkSize:       512,
  chunkOverlap:    64,
  topK:            8,
  bm25Weight:      0.4,
  semWeight:       0.6,
  rerankEnabled:   true,
  rerankModel:     "bge-reranker-base",
  topN:            3,
  cacheEnabled:    true,
  simThreshold:    0.92,
  cacheSize:       1024,
  ttl:             3600,

  /* Performance */
  gpuThreshold: 85,
};

/* ─── Monitoring Services Defaults ──────────────────────────────────────── */

const SERVICE_DEFAULTS = {
  dynatrace:   { baseUrl: "https://abc12345.live.dynatrace.com", endpoint: "/api/v2/problems",             lastSync: "2 min ago"  },
  opmanager:   { baseUrl: "https://opm.corp.local:8080",         endpoint: "/api/json/alarm",              lastSync: "5 min ago"  },
  heal:        { baseUrl: "https://heal.corp.local",             endpoint: "/api/v1/incidents",            lastSync: "1 min ago"  },
  appdynamics: { baseUrl: "https://corp.saas.appdynamics.com",   endpoint: "/controller/rest/applications",lastSync: "12 min ago" },
};

/* ─── AI Monitoring Defaults ─────────────────────────────────────────────── */
/** Used as fallback when chatstats.json cannot be loaded */
const AI_MONITORING_DEFAULTS = {
  updatedAt: new Date(0).toISOString(),
  usage: {
    totalTokens:       0,
    questionsToday:    0,
    requestsProcessed: 0,
    totalConversations:0,
    promptTokens:      0,
    completionTokens:  0,
    avgResponseMs:     0,
    p95Ms:             0,
    cacheHitRatePct:   0,
  },
  resources: {
    cachePct:  0,
    memoryPct: 0,
    gpuPct:    0,
    cpuPct:    0,
  },
  model: {
    name:     "—",
    endpoint: "—",
    device:   "—",
    status:   "Offline",
  },
  bottom: {
    vectorStoreDocs:      0,
    storageUsedGb:        0,
    storageTotalGb:       0,
    throughputTokPerSec:  0,
    errorRatePct:         0,
  },
};

/* ─── Chat ───────────────────────────────────────────────────────────────── */

const CHAT_FALLBACK_REPLY  = "Backend unavailable — chat service is not yet connected.";
const CHAT_REQUEST_TIMEOUT = 20000; // ms

/* ─── Seed Chat Sessions ─────────────────────────────────────────────────── */
/** Pre-populated demo sessions shown before any real backend is connected */
const SEED_CHAT_SESSIONS = [
  {
    id:        "g-1",
    createdAt: Date.now() - 1000 * 60 * 60 * 2,
    title:     "Incident analysis — DB pool",
    preview:   "Root cause confirmed: DB connection pool exhaustion…",
    pinned:    true,
    pinnedAt:  Date.now() - 1000 * 60 * 30,
    messages: [
      { id: "1", role: "assistant", timestamp: "14:30", content: "Hello! I'm your MCP Observability AI. I have full context across all connected sources.\n\nWhat would you like to explore?" },
      { id: "2", role: "user",      timestamp: "14:31", content: "Summarise the active critical alerts right now." },
      { id: "3", role: "assistant", timestamp: "14:31", content: "**Active Critical Alerts**\n\nI see **4 critical** issues. Top priority is the JDBC pool exhaustion on easyTravel — it appears to be the root cause cascading into the checkout BT health alerts." },
    ],
  },
  {
    id:        "g-2",
    createdAt: Date.now() - 1000 * 60 * 60 * 24,
    title:     "Weekly error summary",
    preview:   "Last 7 days: 1,426 total events…",
    pinned:    false,
    pinnedAt:  null,
    messages: [
      { id: "1", role: "assistant", timestamp: "09:00", content: "Loaded weekly summary. 1,426 events across all sources this week, down 12% vs prior week." },
    ],
  },
];

/* ─── Expose globally ────────────────────────────────────────────────────── */
window.CFG = {
  VIEWS,
  SIDEBAR_NAV,
  TOOLS,
  TOOL_MAP,
  CATEGORIES,
  SEVERITIES,
  SEVERITY_COLOR,
  STATUSES,
  STATUS_COLOR,
  TIME_RANGE_OPTIONS,
  TIME_RANGE_MS,
  DEFAULT_RANGE_MS,
  MAX_RANGE_MS,
  TABLE_PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  TABLE_COLUMNS,
  DEFAULT_MAPPING,
  DEFAULT_CATEGORY_RULES,
  KPI_DEFINITIONS,
  SETTINGS_DEFAULTS,
  SERVICE_DEFAULTS,
  AI_MONITORING_DEFAULTS,
  CHAT_FALLBACK_REPLY,
  CHAT_REQUEST_TIMEOUT,
  SEED_CHAT_SESSIONS,
};