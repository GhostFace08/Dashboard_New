import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * CapacityMiddleware — Unified MCP Dashboard, service #2 of the 6-way split.
 *
 * Does NOT exist as a real backend today — frontend/js/capacity.js computes
 * its forecast/threshold numbers entirely in the browser from
 * API.getMcpServers() (which itself just reads mcpservers.json via
 * SettingsMiddleware). This service is a stub that mirrors that mock shape
 * server-side, so the frontend has a real endpoint to migrate to instead of
 * doing the math client-side. The frontend is NOT wired to call this yet —
 * that's a separate change to capacity.js, not included here.
 *
 * REST endpoints:
 *
 *   GET /api/capacity/forecast   → { "implemented": false, "servers": [] }
 *   GET /health                  → { "status": "ok", "service": "capacity" }
 *
 * HOW TO RUN:
 *   javac CapacityMiddleware.java
 *   java  CapacityMiddleware
 *
 * Environment overrides:
 *   PORT — port to listen on (default: 8082)
 */
public class CapacityMiddleware {

    private static final int PORT = Integer.parseInt(
            System.getenv().getOrDefault("PORT", "8082"));

    private static final Logger LOG = Logger.getLogger("CapacityMiddleware");

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

        server.createContext("/api/capacity/forecast", new ForecastHandler());
        server.createContext("/health",                new HealthHandler());
        server.createContext("/",                       new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("CapacityMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET /api/capacity/forecast   ← stub, not wired to frontend yet");
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

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/capacity/forecast
    //
    // Deliberately returns implemented:false rather than fabricating numbers
    // — capacity.js's own mock math is a better source of truth than a
    // second, independent mock here. Wire this up for real once there's an
    // actual metrics source to forecast from.
    // ─────────────────────────────────────────────────────────────────────────

    static class ForecastHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }
            LOG.info("GET /api/capacity/forecast → stub response (implemented:false)");
            sendJson(ex, "{\"implemented\":false,\"servers\":[]}");
        }
    }

    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            sendJson(ex, "{\"status\":\"ok\",\"service\":\"capacity\",\"port\":" + PORT + "}");
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
            sendError(ex, 404, "No such route on CapacityMiddleware: " + ex.getRequestURI().getPath());
        }
    }
}
