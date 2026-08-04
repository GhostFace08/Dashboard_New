package com.dashboardnew.middleware;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.logging.*;

/**
 * ObservabilityMiddleware — Unified MCP Dashboard backend.
 *
 * Renamed from DashboardMiddleware as part of the 6-way service split.
 * Owns Dashboard + Infrastructure + Services + the mapping-wizard sample
 * fetch — i.e. everything DashboardMiddleware used to own, unchanged.
 * Capacity, Topology, Admin/User-Management now live in their own
 * services (CapacityMiddleware :8082, TopologyMiddleware :8083,
 * AdminMiddleware :8086) — see api.js for the full port map.
 *
 * REST endpoints:
 *
 *   GET  /api/issues              → serves backend/data/all_issues.json (raw)
 *   GET  /api/status              → returns file-watch metadata + hasNewData flag
 *   POST /api/refresh             → schedules a deferred file check (~60 s)
 *   GET  /api/infrastructure      → serves backend/data/infrastructure.json (raw) (Phase 6)
 *   GET  /api/services            → serves backend/data/services.json (raw) (Phase 7)
 *   GET  /api/mcp-sample?source=X → mocked orchestrator single-issue fetch (Phase 15)
 *   GET  /health                  → { "status": "ok", "service": "observability" }
 *   *    (unmatched)              → catch-all, 404 JSON instead of a raw connection reset
 *
 * Config/settings endpoints (GET|PUT /api/config, POST /api/settings/save)
 * live in SettingsMiddleware on port 5200.
 *
 * Change 3 additions:
 *   - In-memory metadata store (lastFileTimestamp, lastDataUpdatedAt, lastCheckedAt)
 *   - Background ScheduledExecutorService that polls for a new all_issues.json
 *   - GET /api/status endpoint
 *   - POST /api/refresh endpoint (schedules a one-shot check after 60 s)
 *   - GET /api/issues now adds X-File-Modified-At and X-Server-Time response headers
 *     and injects _fileModifiedAt / _serverTime into the JSON payload
 *
 * HOW TO RUN:
 *   javac ObservabilityMiddleware.java
 *   java  ObservabilityMiddleware
 *
 * The server starts on http://localhost:8081 by default (was :8080 as
 * DashboardMiddleware — bumped so all 6 split services can run at once).
 * Set OBSERVABILITY_PORT env var to override.
 * Set MCP_ROOT env var to point to the project root (default: working dir).
 * Set PERIODIC_CHECK_SECONDS env var to override poll interval (default: 300).
 *
 * All three of the above can also be set via config/middleware.properties
 * ("observability.port", "mcp.root", "observability.periodic_check_seconds"),
 * which takes precedence over the env vars — see MiddlewareConfig. Data file
 * names/location are configurable too ("data.dir", "data.file.all_issues",
 * "data.file.infrastructure", "data.file.services", "data.file.chatstats").
 */
public class ObservabilityMiddleware {

    // ── Configuration ─────────────────────────────────────────────────────────

    private static final int PORT =
            MiddlewareConfig.getInt("observability.port", "OBSERVABILITY_PORT", 8081);

    private static final Path PROJECT_ROOT = MiddlewareConfig.projectRoot();

    private static final Path DATA_DIR   = MiddlewareConfig.dataDir();
    private static final Path ISSUES_FILE = MiddlewareConfig.dataFile("data.file.all_issues", "all_issues.json");

    /** Phase 6 — Infrastructure page data file */
    private static final Path INFRASTRUCTURE_FILE = MiddlewareConfig.dataFile("data.file.infrastructure", "infrastructure.json");

    /** Phase 7 — Services page data file */
    private static final Path SERVICES_FILE = MiddlewareConfig.dataFile("data.file.services", "services.json");
    private static final Path CHATSTATS_FILE = MiddlewareConfig.dataFile("data.file.chatstats", "chatstats.json");

    /**
     * Phase 15 — used only to serve a mocked "sample issue" for a given
     * source in the MCP Servers Mapping wizard. Real per-server live fetch
     * (via a real MCP orchestrator hitting each server's baseUrl/authToken)
     * is out of scope for this phase — see McpSampleHandler's own comment.
     */
    private static final Path ALL_ISSUES_FOR_SAMPLE = ISSUES_FILE;

    /** How often the background thread checks for a new issues file (seconds) */
    private static final long PERIODIC_CHECK_SECONDS = MiddlewareConfig.getLong(
            "observability.periodic_check_seconds", "PERIODIC_CHECK_SECONDS", 300);

    /** Delay for a one-shot check triggered by POST /api/refresh (seconds) */
    private static final long REFRESH_CHECK_DELAY_SECONDS = 60L;

    // ── ISO-8601 formatter ────────────────────────────────────────────────────

    private static final DateTimeFormatter ISO = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
            .withZone(ZoneOffset.UTC);

    private static String toIso(Instant i) { return i == null ? null : ISO.format(i); }

    // ── Logging ───────────────────────────────────────────────────────────────

    private static final Logger LOG = Logger.getLogger("ObservabilityMiddleware");

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

    // ── Change 3 — In-memory metadata store ──────────────────────────────────

    /** File modification time at the moment data was last loaded onto the dashboard */
    private static volatile Instant lastFileTimestamp = null;

    /** Server wall-clock time when /api/issues last served data to the frontend */
    private static volatile Instant lastDataUpdatedAt = null;

    /** Server wall-clock time of the most recent periodic/one-shot file check */
    private static volatile Instant lastCheckedAt = null;

    /**
     * Set to true by the background thread when it finds a newer file.
     * Cleared to false when /api/issues is served (i.e. the frontend consumed it).
     */
    private static final AtomicBoolean hasNewData = new AtomicBoolean(false);

    /** Executor shared by the periodic check thread and one-shot refresh tasks */
    private static final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "file-watcher");
                t.setDaemon(true);
                return t;
            });

    /**
     * Compares the file's last-modified time to the stored lastFileTimestamp.
     * If newer, sets hasNewData = true and updates lastFileTimestamp.
     * Always updates lastCheckedAt.
     */
    private static void checkFile() {
        try {
            if (!Files.exists(ISSUES_FILE)) {
                lastCheckedAt = Instant.now();
                return;
            }
            FileTime ft = Files.getLastModifiedTime(ISSUES_FILE);
            Instant fileInstant = ft.toInstant();
            lastCheckedAt = Instant.now();

            if (lastFileTimestamp == null || fileInstant.isAfter(lastFileTimestamp)) {
                // Do NOT update lastFileTimestamp here.
                // Only IssuesHandler advances it after the frontend actually consumes
                // the file via GET /api/issues.  If we update it now, a second
                // checkFile() between this moment and the serve would see
                // fileInstant == lastFileTimestamp and silently drop the signal.
                hasNewData.set(true);
                LOG.info("checkFile → new data detected (file ts: " + toIso(fileInstant) + ")");
            }
        } catch (IOException e) {
            LOG.warning("checkFile error: " + e.getMessage());
        }
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    public static void main(String[] args) throws IOException {
        LOG.info("Project root : " + PROJECT_ROOT);
        LOG.info("Data dir     : " + DATA_DIR);
        LOG.info("Issues file  : " + ISSUES_FILE);
        LOG.info("Check interval: " + PERIODIC_CHECK_SECONDS + " s");

        // Seed lastFileTimestamp silently at startup so the first periodic checkFile()
        // does not falsely detect the existing file as "new data".
        // We read the mod-time here WITHOUT setting hasNewData — the frontend will
        // load the file via its own boot GET /api/issues, which will set lastFileTimestamp.
        try {
            if (Files.exists(ISSUES_FILE)) {
                lastFileTimestamp = Files.getLastModifiedTime(ISSUES_FILE).toInstant();
                LOG.info("Startup seed: lastFileTimestamp = " + toIso(lastFileTimestamp));
            }
        } catch (IOException e) {
            LOG.warning("Startup seed failed: " + e.getMessage());
        }

        // Start the background periodic file-check (Change 3).
        // initialDelay = PERIODIC_CHECK_SECONDS (NOT 0) — first check fires after
        // one full interval, not immediately.  Prevents a race where checkFile()
        // runs before the frontend's initial GET /api/issues and spuriously sets
        // hasNewData=true on the file that was just seeded above.
        scheduler.scheduleAtFixedRate(
                ObservabilityMiddleware::checkFile,
                PERIODIC_CHECK_SECONDS,   // first check after one full interval
                PERIODIC_CHECK_SECONDS,
                TimeUnit.SECONDS
        );

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/api/issues",         new IssuesHandler());
        server.createContext("/api/status",         new StatusHandler());
        server.createContext("/api/refresh",        new RefreshHandler());
        server.createContext("/api/infrastructure", new InfrastructureHandler());
        server.createContext("/api/services",       new ServicesHandler());
        server.createContext("/api/chat-stats",     new ChatStatsHandler());
        server.createContext("/api/mcp-sample",     new McpSampleHandler());
        server.createContext("/health",             new HealthHandler());
        server.createContext("/",                   new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("ObservabilityMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET  /api/issues");
        LOG.info("  GET  /api/status");
        LOG.info("  POST /api/refresh");
        LOG.info("  GET  /api/infrastructure");
        LOG.info("  GET  /api/services");
        LOG.info("  GET  /api/chat-stats");
        LOG.info("  GET  /api/mcp-sample?source=<id>   ← Phase 15 mapping-wizard mock fetch");
        LOG.info("  GET  /health");
        LOG.info("  Config/settings endpoints live in SettingsMiddleware (:5200)");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /health — liveness probe, no dependency on any data file
    // ─────────────────────────────────────────────────────────────────────────

    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            sendJson(ex, "{\"status\":\"ok\",\"service\":\"observability\",\"port\":" + PORT + "}");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: catch-all — any request that matched no other context.
    // Registered on "/" (lowest-priority prefix in com.sun.net.httpserver's
    // longest-prefix-match routing), so it only fires when nothing more
    // specific matched. Returns a clean 404 JSON body instead of the
    // connection just being reset, which is what a browser/fetch() call
    // sees today for an unregistered route — much harder to debug from the UI.
    // ─────────────────────────────────────────────────────────────────────────

    static class CatchAllHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            LOG.warning("Unmatched route: " + ex.getRequestMethod() + " " + ex.getRequestURI());
            sendError(ex, 404, "No such route on ObservabilityMiddleware: " + ex.getRequestURI().getPath());
        }
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
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

    private static void sendText(HttpExchange ex, String text) throws IOException {
        send(ex, 200, "text/plain; charset=utf-8", text);
    }

    private static void sendError(HttpExchange ex, int status, String message)
            throws IOException {
        String json = "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        send(ex, status, "application/json; charset=utf-8", json);
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/issues  (Change 3 — adds server timestamps to response)
    // ─────────────────────────────────────────────────────────────────────────

    static class IssuesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            Instant serverNow = Instant.now();

            if (Files.exists(ISSUES_FILE)) {
                String json = Files.readString(ISSUES_FILE, StandardCharsets.UTF_8);

                // Change 3 — update metadata.
                // lastCheckedAt is intentionally NOT updated here — only checkFile()
                // owns it.  Mixing it here caused the status bar to show the data-serve
                // time as the "last checked" time, which is semantically wrong.
                FileTime ft = Files.getLastModifiedTime(ISSUES_FILE);
                Instant fileInstant = ft.toInstant();
                lastFileTimestamp  = fileInstant;   // when the file was last written
                lastDataUpdatedAt  = serverNow;     // when the frontend loaded it
                hasNewData.set(false);              // frontend consumed the data

                // Add server-time response headers
                ex.getResponseHeaders().set("X-File-Modified-At", toIso(fileInstant));
                ex.getResponseHeaders().set("X-Server-Time",      toIso(serverNow));

                // Inject timestamps into the JSON payload so dashboard.js can
                // read them even when headers are stripped (e.g. by a proxy).
                // We append before the closing } of the top-level object.
                String stamped = injectTimestamps(json, fileInstant, serverNow);

                LOG.info("GET /api/issues → " + ISSUES_FILE.getFileName()
                        + " (" + stamped.length() + " bytes)");
                sendJson(ex, stamped);
            } else {
                LOG.warning("GET /api/issues → file not found: " + ISSUES_FILE);
                sendJson(ex, "{\"allIssues\":[]}");
            }
        }

        /**
         * Injects _fileModifiedAt and _serverTime into a top-level JSON object
         * string without a full parse.  Locates the last `}` and inserts before it.
         */
        private static String injectTimestamps(String json, Instant fileTs, Instant serverTs) {
            String fm = toIso(fileTs);
            String st = toIso(serverTs);
            String extra = ",\"_fileModifiedAt\":\"" + fm + "\",\"_serverTime\":\"" + st + "\"";
            int last = json.lastIndexOf('}');
            if (last < 0) return json + "{" + extra.substring(1) + "}";
            return json.substring(0, last) + extra + json.substring(last);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Change 3 — Handler: GET /api/status
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns current middleware metadata so the JS poller can decide whether
     * to pull fresh data.
     *
     * Response body:
     * {
     *   "lastFileModifiedAt": "2024-01-15T12:00:30Z",   // null if never loaded
     *   "lastDataUpdatedAt":  "2024-01-15T12:01:00Z",   // null if never served
     *   "lastCheckedAt":      "2024-01-15T12:06:00Z",   // null if never checked
     *   "hasNewData": false
     * }
     */
    static class StatusHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            String json = "{"
                    + "\"lastFileModifiedAt\":" + jsonStr(toIso(lastFileTimestamp)) + ","
                    + "\"lastDataUpdatedAt\":"  + jsonStr(toIso(lastDataUpdatedAt)) + ","
                    + "\"lastCheckedAt\":"      + jsonStr(toIso(lastCheckedAt))     + ","
                    + "\"hasNewData\":"         + hasNewData.get()
                    + "}";

            LOG.fine("GET /api/status → " + json);
            sendJson(ex, json);
        }

        private static String jsonStr(String s) {
            return s == null ? "null" : "\"" + s + "\"";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Change 3 — Handler: POST /api/refresh
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Tells the middleware that the Java fetch service has been triggered by
     * the user pressing the Refresh button.  Schedules a one-shot file check
     * after REFRESH_CHECK_DELAY_SECONDS (60 s) so the new file (if any) will
     * be detected by the next /api/status poll.
     *
     * Response: { "scheduled": true, "checkIn": 60 }
     */
    static class RefreshHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            scheduler.schedule(
                    ObservabilityMiddleware::checkFile,
                    REFRESH_CHECK_DELAY_SECONDS,
                    TimeUnit.SECONDS
            );

            LOG.info("POST /api/refresh → one-shot check scheduled in "
                    + REFRESH_CHECK_DELAY_SECONDS + " s");

            sendJson(ex, "{\"scheduled\":true,\"checkIn\":" + REFRESH_CHECK_DELAY_SECONDS + "}");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6 — Handler: GET /api/infrastructure
    //
    // Deliberately a lean mirror of IssuesHandler: same file-serve pattern
    // (read the JSON file, hand it back as-is, empty-array fallback if
    // missing), but WITHOUT the Change-3 lastFileTimestamp/hasNewData/
    // X-File-Modified-At machinery — the Infrastructure page has no
    // countdown timer or status bar to feed, so that bookkeeping would be
    // dead weight here. If a future phase adds polling/refresh to this page,
    // that tracking can be added the same way it was for IssuesHandler.
    // ─────────────────────────────────────────────────────────────────────────

    static class InfrastructureHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            if (Files.exists(INFRASTRUCTURE_FILE)) {
                String json = Files.readString(INFRASTRUCTURE_FILE, StandardCharsets.UTF_8);
                LOG.info("GET /api/infrastructure → " + INFRASTRUCTURE_FILE.getFileName()
                        + " (" + json.length() + " bytes)");
                sendJson(ex, json);
            } else {
                LOG.warning("GET /api/infrastructure → file not found: " + INFRASTRUCTURE_FILE);
                sendJson(ex, "{\"infrastructure\":[]}");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 7 — Handler: GET /api/services
    //
    // Identical pattern to InfrastructureHandler (Phase 6) — same lean
    // file-serve, no Change-3 timestamp tracking. If Infrastructure ever
    // grows that tracking back in, do the same here for consistency.
    // ─────────────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/chat-stats — backed by chatstats.json.
    // Previously fetched by the frontend directly via a raw relative
    // filesystem path (../../backend/data/chatstats.json), bypassing every
    // other service's CORS'd-middleware pattern. Moved here so AI Monitoring
    // uses a real HTTP endpoint like every other page.
    // ─────────────────────────────────────────────────────────────────────────

    static class ChatStatsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }
            if (Files.exists(CHATSTATS_FILE)) {
                String json = Files.readString(CHATSTATS_FILE, StandardCharsets.UTF_8);
                LOG.info("GET /api/chat-stats → " + CHATSTATS_FILE.getFileName()
                        + " (" + json.length() + " bytes)");
                sendJson(ex, json);
            } else {
                LOG.warning("GET /api/chat-stats → file not found: " + CHATSTATS_FILE);
                sendJson(ex, "{}");
            }
        }
    }

    static class ServicesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            if (Files.exists(SERVICES_FILE)) {
                String json = Files.readString(SERVICES_FILE, StandardCharsets.UTF_8);
                LOG.info("GET /api/services → " + SERVICES_FILE.getFileName()
                        + " (" + json.length() + " bytes)");
                sendJson(ex, json);
            } else {
                LOG.warning("GET /api/services → file not found: " + SERVICES_FILE);
                sendJson(ex, "{\"services\":[]}");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 15 — Handler: GET /api/mcp-sample?source=<id>
    //
    // Stands in for the real MCP orchestrator's "fetch one live sample issue
    // from this server" call used by the MCP Servers → Mapping wizard tab.
    // Per the agreed scope for this phase, the real orchestrator/live-HTTP
    // path is NOT built here — this handler mocks that single call by
    // pulling one already-collected record for the requested source out of
    // all_issues.json (grouped by source, same shape IssuesHandler serves)
    // and handing it back in the shape the wizard expects. Swapping in a
    // real orchestrator call later only means replacing this handler's body
    // — the frontend contract (GET .../mcp-sample?source=X →
    // {"source":X,"sample":{...}}) does not need to change.
    //
    // No JSON library is used anywhere in this project (see IssuesHandler's
    // injectTimestamps for the same convention) — this handler locates the
    // matching source group and its first data[] object with plain string
    // scanning + brace counting that respects quoted strings, rather than a
    // full parse.
    // ─────────────────────────────────────────────────────────────────────────

    static class McpSampleHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed");
                return;
            }

            String query = ex.getRequestURI().getRawQuery();
            String source = queryParam(query, "source");
            if (source == null || source.isBlank()) {
                sendError(ex, 400, "Missing required query param: source");
                return;
            }

            String sampleObj = null;
            if (Files.exists(ALL_ISSUES_FOR_SAMPLE)) {
                try {
                    String text = Files.readString(ALL_ISSUES_FOR_SAMPLE, StandardCharsets.UTF_8);
                    sampleObj = findFirstSampleForSource(text, source);
                } catch (IOException e) {
                    LOG.warning("mcp-sample read error: " + e.getMessage());
                }
            }

            if (sampleObj == null) {
                // Fallback stub — keeps the Mapping wizard usable even for a
                // brand-new source with no matching group in all_issues.json.
                sampleObj = "{\"id\":\"SAMPLE-0001\",\"title\":\"Sample issue — no live data found for source '"
                        + source.replace("\"", "'") + "'\",\"severity\":\"Medium\",\"status\":\"ACTIVE\"}";
                LOG.info("GET /api/mcp-sample?source=" + source + " → no match, returning fallback stub");
            } else {
                LOG.info("GET /api/mcp-sample?source=" + source + " → " + sampleObj.length() + " bytes");
            }

            sendJson(ex, "{\"source\":\"" + source.replace("\"", "'") + "\",\"sample\":" + sampleObj + "}");
        }

        /** Extracts the single value of a query param, or null if absent. */
        private static String queryParam(String query, String key) {
            if (query == null) return null;
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                String k = eq < 0 ? pair : pair.substring(0, eq);
                if (k.equals(key)) {
                    return eq < 0 ? "" : pair.substring(eq + 1);
                }
            }
            return null;
        }

        /**
         * Finds `{"source":"<source>", "data":[ {FIRST_OBJECT}, ... ]}` in the
         * all_issues.json text and returns FIRST_OBJECT's raw text, or null if
         * no group for that source exists or its data[] is empty.
         */
        private static String findFirstSampleForSource(String text, String source) {
            String needle = "\"source\"" ;
            int searchFrom = 0;
            while (true) {
                int sourceKeyIdx = text.indexOf(needle, searchFrom);
                if (sourceKeyIdx < 0) return null;

                int valStart = text.indexOf('"', text.indexOf(':', sourceKeyIdx) + 1);
                int valEnd   = valStart < 0 ? -1 : text.indexOf('"', valStart + 1);
                if (valStart < 0 || valEnd < 0) return null;
                String foundSource = text.substring(valStart + 1, valEnd);

                if (foundSource.equals(source)) {
                    int dataIdx = text.indexOf("\"data\"", valEnd);
                    if (dataIdx < 0) return null;
                    int arrStart = text.indexOf('[', dataIdx);
                    if (arrStart < 0) return null;
                    int objStart = text.indexOf('{', arrStart);
                    if (objStart < 0) return null; // empty data[] for this source
                    return extractBalancedObject(text, objStart);
                }
                searchFrom = valEnd + 1;
            }
        }

        /** Brace-counts from an opening '{' to its matching '}', skipping over quoted strings. */
        private static String extractBalancedObject(String text, int objStart) {
            int depth = 0;
            boolean inString = false;
            boolean escaped = false;
            for (int i = objStart; i < text.length(); i++) {
                char c = text.charAt(i);
                if (inString) {
                    if (escaped) { escaped = false; }
                    else if (c == '\\') { escaped = true; }
                    else if (c == '"') { inString = false; }
                    continue;
                }
                if (c == '"') { inString = true; continue; }
                if (c == '{') depth++;
                else if (c == '}') {
                    depth--;
                    if (depth == 0) return text.substring(objStart, i + 1);
                }
            }
            return null; // malformed — unbalanced braces
        }
    }

}