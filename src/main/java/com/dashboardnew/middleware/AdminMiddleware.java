package com.dashboardnew.middleware;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * AdminMiddleware — Unified MCP Dashboard, service #6 of the 6-way split.
 *
 * "Everything else" service. Three real, file-backed data sets land here:
 *
 *  1. /api/users — GET + PUT, backed by backend/data/users.json. Replaces
 *     the old localStorage-only store in user_management.js.
 *
 *  2. /api/network-devices, /api/processes — GET only (read-only by
 *     design — see project notes). Backed by backend/data/network-devices.json
 *     and backend/data/processes.json. Previously these were hardcoded
 *     empty-array stubs even though real seeded data existed on disk the
 *     whole time — that silently suppressed the frontend's demo-data
 *     fallback (a 200-with-nothing response looks like success, so the
 *     fallback that only fires on failure never kicked in). Fixed by
 *     actually reading the files.
 *
 * REST endpoints:
 *
 *   GET  /api/users            → backend/data/users.json               (or {"users":[]} if missing)
 *   PUT  /api/users            → overwrites backend/data/users.json
 *   GET  /api/network-devices  → backend/data/network-devices.json     (or {"networkDevices":[]} if missing)
 *   GET  /api/processes        → backend/data/processes.json           (or {"processes":[]} if missing)
 *   GET  /health                → { "status": "ok", "service": "admin" }
 *
 * HOW TO RUN:
 *   javac AdminMiddleware.java
 *   java  AdminMiddleware
 *
 * Config:
 *   Reads config/middleware.properties first (keys "admin.port",
 *   "mcp.root", "data.dir", "data.file.users", "data.file.network_devices",
 *   "data.file.processes"), then falls back to the environment variables
 *   below, then the hardcoded default. See MiddlewareConfig.
 *
 * Environment overrides:
 *   ADMIN_PORT — port to listen on (default: 8086)
 *   MCP_ROOT   — project root path (default: working directory)
 */
public class AdminMiddleware {

    private static final int PORT =
            MiddlewareConfig.getInt("admin.port", "ADMIN_PORT", 8086);

    private static final Path DATA_DIR              = MiddlewareConfig.dataDir();
    private static final Path USERS_FILE            = MiddlewareConfig.dataFile("data.file.users", "users.json");
    private static final Path NETWORK_DEVICES_FILE  = MiddlewareConfig.dataFile("data.file.network_devices", "network-devices.json");
    private static final Path PROCESSES_FILE        = MiddlewareConfig.dataFile("data.file.processes", "processes.json");

    private static final Logger LOG = Logger.getLogger("AdminMiddleware");

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

        server.createContext("/api/users",           new UsersHandler());
        server.createContext("/api/network-devices", new NetworkDevicesHandler());
        server.createContext("/api/processes",       new ProcessesHandler());
        server.createContext("/health",              new HealthHandler());
        server.createContext("/",                    new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("AdminMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET  /api/users            → " + USERS_FILE);
        LOG.info("  PUT  /api/users            → overwrites " + USERS_FILE);
        LOG.info("  GET  /api/network-devices  → " + NETWORK_DEVICES_FILE + " (read-only)");
        LOG.info("  GET  /api/processes        → " + PROCESSES_FILE + " (read-only)");
        LOG.info("  GET  /health");
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

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** Reads a JSON file as-is, or returns fallbackJson if it doesn't exist. */
    private static String readFileOrFallback(Path file, String fallbackJson) throws IOException {
        if (Files.exists(file)) {
            return Files.readString(file, StandardCharsets.UTF_8);
        }
        return fallbackJson;
    }

    /** Atomic write: temp file + rename, so a crash mid-write never corrupts the real file. */
    private static void atomicWrite(Path file, String content) throws IOException {
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(tmp, content, StandardCharsets.UTF_8);
        Files.move(tmp, file, StandardCharsets.UTF_8.equals(StandardCharsets.UTF_8)
                ? new java.nio.file.CopyOption[]{ StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE }
                : new java.nio.file.CopyOption[]{ StandardCopyOption.REPLACE_EXISTING });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET|PUT /api/users — backed by users.json (real persistence,
    // replacing user_management.js's old localStorage-only store)
    // ─────────────────────────────────────────────────────────────────────────

    static class UsersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            String method = ex.getRequestMethod().toUpperCase();
            if (method.equals("GET")) {
                String json = readFileOrFallback(USERS_FILE, "{\"users\":[]}");
                LOG.info("GET /api/users → " + json.length() + " bytes");
                sendJson(ex, json);
            } else if (method.equals("PUT")) {
                String body = readBody(ex);
                if (body.isBlank()) { sendError(ex, 400, "Empty body"); return; }
                atomicWrite(USERS_FILE, body);
                LOG.info("PUT /api/users → wrote " + body.length() + " bytes");
                sendJson(ex, "{\"ok\":true}");
            } else {
                sendError(ex, 405, "Method not allowed");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/network-devices — read-only, backed by
    // network-devices.json. Empty-array fallback only fires if the file is
    // genuinely missing, so the frontend's own demo-data fallback still
    // works correctly on a fresh install with no seeded file.
    // ─────────────────────────────────────────────────────────────────────────

    static class NetworkDevicesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }
            String json = readFileOrFallback(NETWORK_DEVICES_FILE, "{\"networkDevices\":[]}");
            LOG.info("GET /api/network-devices → " + json.length() + " bytes");
            sendJson(ex, json);
        }
    }

    static class ProcessesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }
            String json = readFileOrFallback(PROCESSES_FILE, "{\"processes\":[]}");
            LOG.info("GET /api/processes → " + json.length() + " bytes");
            sendJson(ex, json);
        }
    }

    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            sendJson(ex, "{\"status\":\"ok\",\"service\":\"admin\",\"port\":" + PORT + "}");
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
            sendError(ex, 404, "No such route on AdminMiddleware: " + ex.getRequestURI().getPath());
        }
    }
}
