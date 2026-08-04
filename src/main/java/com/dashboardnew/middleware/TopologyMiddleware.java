package com.dashboardnew.middleware;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * TopologyMiddleware — Unified MCP Dashboard, service #3 of the 6-way split.
 *
 * Does NOT exist as a real backend today — frontend/js/topology.js gets its
 * node list entirely from API.getMcpServers(), which reads
 * backend/data/mcpconf.ini through SettingsMiddleware (:5200). This
 * service becomes a real, read-only proxy in front of that same file:
 * Topology never touches the settings store directly, and Settings stays the
 * only service that writes mcpconf.ini. Frontend is NOT wired to call
 * this yet — that's a separate change to topology.js, not included here.
 *
 * REST endpoints:
 *
 *   GET /api/topology/servers   → proxies GET {SETTINGS_URL}/api/config/mcpconf.ini,
 *                                  reshapes { servers: [...] } for the topology graph.
 *                                  Degrades to { "servers": [] } if Settings is unreachable
 *                                  or returns invalid/empty content — the graph should never
 *                                  hard-fail just because Settings is momentarily down.
 *   GET /api/topology            → backend/data/topology.json, the real saved graph
 *                                  (nodes/edges/topologies per application). This is the
 *                                  service's own data — Topology owns this file directly,
 *                                  same way Settings owns mcpconf.ini/mapping.json/etc.
 *   PUT /api/topology            → overwrites backend/data/topology.json (used by the
 *                                  "Update Topology" confirm flow in topology.js)
 *   GET /health                 → { "status": "ok", "service": "topology" }
 *
 * HOW TO RUN:
 *   javac TopologyMiddleware.java
 *   java  TopologyMiddleware
 *
 * Config:
 *   Reads config/middleware.properties first (keys "topology.port",
 *   "topology.settings_url", "mcp.root", "topology.connect_timeout_ms",
 *   "topology.read_timeout_ms", "data.dir", "data.file.topology"), then
 *   falls back to the environment variables below, then the hardcoded
 *   defaults. See MiddlewareConfig.
 *
 * Environment overrides:
 *   TOPOLOGY_PORT — port to listen on            (default: 8083)
 *   SETTINGS_URL  — base URL of SettingsMiddleware (default: http://localhost:5200)
 *   MCP_ROOT      — project root path (default: working directory)
 */
public class TopologyMiddleware {

    private static final int PORT =
            MiddlewareConfig.getInt("topology.port", "TOPOLOGY_PORT", 8083);

    private static final String SETTINGS_URL =
            MiddlewareConfig.getString("topology.settings_url", "SETTINGS_URL", "http://localhost:5200");

    private static final Path DATA_DIR       = MiddlewareConfig.dataDir();
    private static final Path TOPOLOGY_FILE  = MiddlewareConfig.dataFile("data.file.topology", "topology.json");

    private static final int CONNECT_TIMEOUT_MS =
            MiddlewareConfig.getInt("topology.connect_timeout_ms", "TOPOLOGY_CONNECT_TIMEOUT_MS", 5000);
    private static final int READ_TIMEOUT_MS =
            MiddlewareConfig.getInt("topology.read_timeout_ms", "TOPOLOGY_READ_TIMEOUT_MS", 10000);

    private static final Logger LOG = Logger.getLogger("TopologyMiddleware");

    static {
        LogManager.getLogManager().reset();
        ConsoleHandler ch = new ConsoleHandler();
        ch.setLevel(Level.ALL);
        ch.setFormatter(new SimpleFormatter() {
            @Override public String format(LogRecord r) {
                return String.format("[%s] %s: %s%n", r.getLevel(), r.getLoggerName(), r.getMessage());
            }
        });
        LOG.addHandler(ch);
        LOG.setLevel(Level.INFO);
    }

    public static void main(String[] args) throws IOException {
        Files.createDirectories(DATA_DIR);

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/api/topology/servers", new ServersHandler());
        server.createContext("/api/topology",          new TopologyDataHandler());
        server.createContext("/health",                new HealthHandler());
        server.createContext("/",                       new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("TopologyMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET /api/topology/servers  → proxies " + SETTINGS_URL + "/api/config/mcpconf.ini");
        LOG.info("  GET  /api/topology          → " + TOPOLOGY_FILE);
        LOG.info("  PUT  /api/topology          → overwrites " + TOPOLOGY_FILE);
        LOG.info("  GET /health");
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static void send(HttpExchange ex, int status, String contentType, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static void sendJson(HttpExchange ex, String json) throws IOException {
        send(ex, 200, "application/json; charset=utf-8", json);
    }

    private static void sendError(HttpExchange ex, int status, String message) throws IOException {
        send(ex, status, "application/json; charset=utf-8",
                "{\"error\":\"" + message.replace("\"", "'") + "\"}");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/topology/servers
    //
    // Calls SettingsMiddleware's GET /api/config/mcpconf.ini server-side
    // (same file api.js's getMcpServers() reads today), parses out the
    // top-level "servers" array with the same brace-counting approach used
    // elsewhere in this project (no JSON library dependency), and re-wraps
    // it as { "servers": [...] }. On any failure (Settings unreachable, bad
    // JSON, empty file) this degrades to an empty list rather than 500ing —
    // the graph should render an empty state, not break.
    // ─────────────────────────────────────────────────────────────────────────

    static class ServersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }

            String target = SETTINGS_URL + "/api/config/mcpconf.ini";
            String raw = fetchUpstream(target);

            if (raw == null) {
                LOG.warning("GET /api/topology/servers → Settings unreachable at " + target + ", returning empty");
                sendJson(ex, "{\"servers\":[]}");
                return;
            }

            String serversArray = extractServersArray(raw);
            if (serversArray == null) {
                LOG.warning("GET /api/topology/servers → mcpconf.ini missing/invalid 'servers' array, returning empty");
                sendJson(ex, "{\"servers\":[]}");
                return;
            }

            LOG.info("GET /api/topology/servers → " + serversArray.length() + " bytes from Settings");
            sendJson(ex, "{\"servers\":" + serversArray + "}");
        }

        /** GETs a URL and returns the body, or null on any network/HTTP error. */
        private static String fetchUpstream(String target) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(target);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);

                int status = conn.getResponseCode();
                InputStream is = status >= 200 && status < 300 ? conn.getInputStream() : null;
                if (is == null) return null;

                try (InputStream in = is) {
                    return new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
            } catch (IOException e) {
                LOG.warning("fetchUpstream(" + target + ") failed: " + e.getMessage());
                return null;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /**
         * Extracts the raw text of the top-level "servers": [ ... ] array from
         * a JSON object, respecting quoted strings. Returns null if the key or
         * a valid array is not found.
         */
        private static String extractServersArray(String json) {
            int keyIdx = json.indexOf("\"servers\"");
            if (keyIdx < 0) return null;
            int colon = json.indexOf(':', keyIdx);
            if (colon < 0) return null;
            int arrStart = json.indexOf('[', colon);
            if (arrStart < 0) return null;

            int depth = 0;
            boolean inString = false, escaped = false;
            for (int i = arrStart; i < json.length(); i++) {
                char c = json.charAt(i);
                if (inString) {
                    if (escaped) escaped = false;
                    else if (c == '\\') escaped = true;
                    else if (c == '"') inString = false;
                    continue;
                }
                if (c == '"') { inString = true; continue; }
                if (c == '[') depth++;
                else if (c == ']') {
                    depth--;
                    if (depth == 0) return json.substring(arrStart, i + 1);
                }
            }
            return null; // unbalanced — malformed
        }
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void atomicWrite(Path file, String content) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(tmp, content, StandardCharsets.UTF_8);
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET|PUT /api/topology — the real saved topology graph.
    //
    // GET  returns backend/data/topology.json as-is (or {"topology":{}} if
    //      the file doesn't exist yet — e.g. brand-new install).
    // PUT  overwrites it atomically. Used by topology.js's "Update Topology"
    //      button after the user confirms the diff shown in the popup.
    // ─────────────────────────────────────────────────────────────────────────

    static class TopologyDataHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            String method = ex.getRequestMethod().toUpperCase();
            if (method.equals("GET")) {
                String json = Files.exists(TOPOLOGY_FILE)
                        ? Files.readString(TOPOLOGY_FILE, StandardCharsets.UTF_8)
                        : "{\"topology\":{}}";
                LOG.info("GET /api/topology → " + json.length() + " bytes");
                sendJson(ex, json);
            } else if (method.equals("PUT")) {
                String body = readBody(ex);
                if (body.isBlank()) { sendError(ex, 400, "Empty body"); return; }
                atomicWrite(TOPOLOGY_FILE, body);
                LOG.info("PUT /api/topology → wrote " + body.length() + " bytes");
                sendJson(ex, "{\"ok\":true}");
            } else {
                sendError(ex, 405, "Method not allowed");
            }
        }
    }

    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            sendJson(ex, "{\"status\":\"ok\",\"service\":\"topology\",\"port\":" + PORT + "}");
        }
    }

    static class CatchAllHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            LOG.warning("Unmatched route: " + ex.getRequestMethod() + " " + ex.getRequestURI());
            sendError(ex, 404, "No such route on TopologyMiddleware: " + ex.getRequestURI().getPath());
        }
    }
}
