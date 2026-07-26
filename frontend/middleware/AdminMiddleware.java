import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * AdminMiddleware — Unified MCP Dashboard, service #6 of the 6-way split.
 *
 * "Everything else" service. Two things land here:
 *
 *  1. /api/users — User Management is pure localStorage today
 *     (frontend/js/user_management.js). This is a stub landing spot for
 *     whenever that data needs to leave the browser. Frontend NOT wired
 *     to call this yet.
 *
 *  2. /api/network-devices and /api/processes — api.js already defines
 *     getNetworkDevices()/getProcesses() pointing at DashboardMiddleware,
 *     but DashboardMiddleware (now ObservabilityMiddleware) never actually
 *     registered those contexts — those calls have been silently 404ing
 *     and falling back to demo data. Stubbed here rather than left
 *     dangling, since this service is the "everything else" bucket, but
 *     they still return empty-array stubs, not real device/process data
 *     — a real data source for them doesn't exist yet.
 *
 * REST endpoints:
 *
 *   GET  /api/users            → { "implemented": false, "users": [] }
 *   GET  /api/network-devices  → { "networkDevices": [] }  (stub — fills api.js gap)
 *   GET  /api/processes        → { "processes": [] }        (stub — fills api.js gap)
 *   GET  /health                → { "status": "ok", "service": "admin" }
 *
 * HOW TO RUN:
 *   javac AdminMiddleware.java
 *   java  AdminMiddleware
 *
 * Environment overrides:
 *   PORT — port to listen on (default: 8086)
 */
public class AdminMiddleware {

    private static final int PORT = Integer.parseInt(
            System.getenv().getOrDefault("PORT", "8086"));

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
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/api/users",           new UsersHandler());
        server.createContext("/api/network-devices", new NetworkDevicesHandler());
        server.createContext("/api/processes",       new ProcessesHandler());
        server.createContext("/health",              new HealthHandler());
        server.createContext("/",                    new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("AdminMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET /api/users            ← stub, User Management is localStorage-backed today");
        LOG.info("  GET /api/network-devices  ← stub, fills a gap left by ObservabilityMiddleware");
        LOG.info("  GET /api/processes        ← stub, fills a gap left by ObservabilityMiddleware");
        LOG.info("  GET /health");
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, OPTIONS");
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

    static class UsersHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }
            LOG.info("GET /api/users → stub response (implemented:false)");
            sendJson(ex, "{\"implemented\":false,\"users\":[]}");
        }
    }

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
            LOG.info("GET /api/network-devices → stub response (empty)");
            sendJson(ex, "{\"networkDevices\":[]}");
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
            LOG.info("GET /api/processes → stub response (empty)");
            sendJson(ex, "{\"processes\":[]}");
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
