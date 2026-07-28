import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * SettingsMiddleware — Unified MCP Dashboard
 *
 * Standalone settings service. Owns all config file I/O so that
 * DashboardMiddleware (port 8080) handles only dashboard/issues data.
 *
 * REST endpoints:
 *
 *   GET  /api/config/:filename   → reads  backend/data/<filename> as text
 *   PUT  /api/config/:filename   → writes backend/data/<filename> from body
 *   POST /api/settings/save      → atomic multi-file save (all files in one request)
 *   GET  /api/issues             → read-only proxy to all_issues.json (for settings
 *                                   page category/mapping previews)
 *   POST /api/registry/fetch     → server-side proxy that fetches a tool registry.
 *                                   Body: {"baseUrl":"https://host","path":"/api/tools",
 *                                   "token":"...","payload":"..."}. The backend combines
 *                                   baseUrl + path into the final URL (path may also be
 *                                   given as a full absolute URL, kept as-is for back-compat),
 *                                   performs the request itself (avoids browser CORS), and
 *                                   returns {"ok":true,"status":200,"url":"...","body":"<raw>"}.
 *
 * HOW TO RUN:
 *   javac SettingsMiddleware.java
 *   java  SettingsMiddleware
 *
 * Environment overrides:
 *   SETTINGS_PORT — port to listen on  (default: 5200)
 *   MCP_ROOT — project root path  (default: working directory)
 */
public class SettingsMiddleware {

    // ── Configuration ─────────────────────────────────────────────────────────

    private static final int PORT = Integer.parseInt(
            System.getenv().getOrDefault("SETTINGS_PORT", "5200"));

    private static final Path PROJECT_ROOT = Paths.get(
            System.getenv().getOrDefault("MCP_ROOT", ".")).toAbsolutePath();

    private static final Path DATA_DIR    = PROJECT_ROOT.resolve("backend/data");
    private static final Path ISSUES_FILE = DATA_DIR.resolve("all_issues.json");

    /**
     * Files the settings UI is allowed to read or write.
     * Any key not in this set is rejected with HTTP 403.
     *
     * Rewritten to the new one-file-per-settings-page layout:
     *   conf.properties      — General section + non-per-server MCP-servers-section data
     *   mcpconf.ini          — the "Details" tab per MCP server (id/name/baseUrl/timeout/
     *                          registry/etc.) — JSON content despite the .ini name (a flat
     *                          properties format can't cleanly express nested arrays like
     *                          registry.paths, so this file keeps JSON content; only the
     *                          extension changed to match the new naming convention)
     *   capacity.ini         — Capacity & Forecasting section (left blank/unwired per spec)
     *   llm.ini              — AI & Models section + per-server "Keywords" tab (merged;
     *                          replaces the old standalone keywords.json)
     *   rag.ini              — Retrieval (RAG) section
     *   performance.ini      — Performance section
     *   chat.ini             — Advanced section
     *   categorization.json  — per-server "Categorization" tab (unchanged from before)
     *   mapping.json         — per-server "Mapping", "Dashboards", and "Time Mapping" tabs,
     *                          keyed by server id (previously these lived embedded inside
     *                          mcpservers.json and this file was an orphaned, unwritten
     *                          legacy duplicate — now it's the real, live source)
     */
    private static final Set<String> ALLOWED_FILES = Set.of(
            "conf.properties",
            "mcpconf.ini",
            "capacity.ini",
            "llm.ini",
            "rag.ini",
            "performance.ini",
            "chat.ini",
            "categorization.json",
            "mapping.json"
    );

    /**
     * Files whose content must be valid JSON.
     * Validated before any disk write occurs. The *.ini/*.properties files
     * are plain text (properties/ini format) and are intentionally excluded.
     */
    private static final Set<String> JSON_FILES = Set.of(
            "mcpconf.ini",
            "categorization.json",
            "mapping.json"
    );

    // ── Logging ───────────────────────────────────────────────────────────────

    private static final Logger LOG = Logger.getLogger("SettingsMiddleware");

    static {
        LogManager.getLogManager().reset();
        ConsoleHandler ch = new ConsoleHandler();
        ch.setLevel(Level.ALL);
        ch.setFormatter(new SimpleFormatter() {
            @Override
            public String format(LogRecord r) {
                return String.format("[%s] %s: %s%n",
                        r.getLevel(), r.getLoggerName(), r.getMessage());
            }
        });
        LOG.addHandler(ch);
        LOG.setLevel(Level.INFO);
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    public static void main(String[] args) throws IOException {
        LOG.info("Project root : " + PROJECT_ROOT);
        LOG.info("Data dir     : " + DATA_DIR);

        // Ensure data directory exists
        Files.createDirectories(DATA_DIR);

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        // GET /api/issues
        server.createContext("/api/issues",          new IssuesHandler());

        // GET|PUT /api/config/:filename  (individual file access)
        server.createContext("/api/config",          new ConfigHandler());

        // POST /api/settings/save  (atomic multi-file save — NEW)
        server.createContext("/api/settings/save",   new SaveHandler());

        // POST /api/registry/fetch  (server-side Tool Registry fetch proxy — NEW)
        server.createContext("/api/registry/fetch",  new RegistryFetchHandler());

        server.createContext("/health",              new HealthHandler());
        server.createContext("/",                    new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("SettingsMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET  /api/issues");
        LOG.info("  GET  /api/config/<filename>");
        LOG.info("  PUT  /api/config/<filename>");
        LOG.info("  POST /api/settings/save         ← atomic multi-file save");
        LOG.info("  POST /api/registry/fetch        ← Tool Registry fetch proxy (combines baseUrl + path)");
        LOG.info("  GET  /health");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /health
    // ─────────────────────────────────────────────────────────────────────────

    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            sendJson(ex, "{\"status\":\"ok\",\"service\":\"settings\",\"port\":" + PORT + "}");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: catch-all — see ObservabilityMiddleware for rationale.
    // ─────────────────────────────────────────────────────────────────────────

    static class CatchAllHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            LOG.warning("Unmatched route: " + ex.getRequestMethod() + " " + ex.getRequestURI());
            sendError(ex, 404, "No such route on SettingsMiddleware: " + ex.getRequestURI().getPath());
        }
    }

    // ── Shared HTTP helpers ───────────────────────────────────────────────────

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
        String safe = message.replace("\\", "\\\\").replace("\"", "'");
        send(ex, status, "application/json; charset=utf-8",
                "{\"error\":\"" + safe + "\"}");
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/issues
    // ─────────────────────────────────────────────────────────────────────────

    static class IssuesHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }
            if (Files.exists(ISSUES_FILE)) {
                String json = Files.readString(ISSUES_FILE, StandardCharsets.UTF_8);
                LOG.info("GET /api/issues → " + json.length() + " bytes");
                sendJson(ex, json);
            } else {
                LOG.warning("GET /api/issues → file not found: " + ISSUES_FILE);
                sendJson(ex, "{\"allIssues\":[]}");
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: POST /api/registry/fetch
    //
    // Fetches a Tool Registry document on the server's behalf, so the browser
    // never has to call the target server directly (no CORS problems) and so
    // the admin only has to type the *path* portion of the registry endpoint —
    // the server's own Base URL supplies the rest.
    // ─────────────────────────────────────────────────────────────────────────

    static class RegistryFetchHandler implements HttpHandler {

        private static final HttpClient CLIENT = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .build();

        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed"); return;
            }

            String body = readBody(ex);
            String jsonErr = validateJson(body);
            if (jsonErr != null) {
                sendError(ex, 400, "Invalid JSON body: " + jsonErr); return;
            }

            String baseUrl = jsonStringField(body, "baseUrl");
            String path    = jsonStringField(body, "path");
            String token   = jsonStringField(body, "token");
            String payload = jsonStringField(body, "payload");

            String targetUrl;
            try {
                targetUrl = combineRegistryUrl(baseUrl, path);
            } catch (IllegalArgumentException iae) {
                sendError(ex, 400, iae.getMessage()); return;
            }

            try {
                HttpRequest.Builder reqBuilder = HttpRequest.newBuilder(URI.create(targetUrl))
                        .timeout(Duration.ofSeconds(20));
                if (token != null && !token.isBlank()) {
                    reqBuilder.header("Authorization", "Bearer " + token);
                }
                if (payload != null && !payload.isBlank()) {
                    reqBuilder.header("Content-Type", "text/plain; charset=utf-8")
                              .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8));
                } else {
                    reqBuilder.GET();
                }

                HttpResponse<String> resp = CLIENT.send(reqBuilder.build(),
                        HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));

                LOG.info("POST /api/registry/fetch → " + targetUrl + " → HTTP " + resp.statusCode());

                String envelope = "{\"ok\":true,\"status\":" + resp.statusCode()
                        + ",\"url\":\"" + escapeJson(targetUrl) + "\""
                        + ",\"body\":\"" + escapeJson(resp.body()) + "\"}";
                sendJson(ex, envelope);
            } catch (Exception e) {
                LOG.warning("POST /api/registry/fetch → " + targetUrl + " failed: " + e);
                sendError(ex, 502, "Fetch failed for " + targetUrl + ": " + e.getMessage());
            }
        }
    }

    /**
     * Combines a server's Base URL with the (short) registry endpoint path the
     * admin typed in, e.g. baseUrl="https://abc12345.live.dynatrace.com" +
     * path="/api/tools" → "https://abc12345.live.dynatrace.com/api/tools".
     *
     * Back-compat: if path is already an absolute http(s) URL (older records
     * saved before this change stored the full URL), it's used as-is and
     * baseUrl is ignored.
     */
    static String combineRegistryUrl(String baseUrl, String path) {
        String p = path == null ? "" : path.trim();
        if (p.isEmpty()) {
            throw new IllegalArgumentException("Registry path is required");
        }
        if (p.matches("(?i)^https?://.+")) {
            return p; // already absolute — back-compat with pre-existing records
        }
        String b = baseUrl == null ? "" : baseUrl.trim();
        if (b.isEmpty()) {
            throw new IllegalArgumentException(
                    "Registry path is relative (\"" + p + "\") but this server has no Base URL set");
        }
        b = b.replaceAll("/+$", "");
        p = p.startsWith("/") ? p : "/" + p;
        return b + p;
    }

    /**
     * Pulls a single top-level string field out of a small, flat JSON object
     * without needing a full JSON library — sufficient for this endpoint's
     * fixed {baseUrl, path, token, payload} request shape.
     */
    static String jsonStringField(String json, String key) {
        if (json == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + java.util.regex.Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"")
                .matcher(json);
        if (!m.find()) return null;
        return m.group(1)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .replace("\\n", "\n")
                .replace("\\r", "\r")
                .replace("\\t", "\t");
    }

    /** Escapes a string for safe embedding as a JSON string value. */
    static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"'  -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET|PUT /api/config/:filename
    // ─────────────────────────────────────────────────────────────────────────

    static class ConfigHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1); return;
            }

            String path   = ex.getRequestURI().getPath();
            String prefix = "/api/config/";
            if (!path.startsWith(prefix) || path.length() <= prefix.length()) {
                sendError(ex, 400, "Missing filename. Use /api/config/<filename>"); return;
            }

            String filename = path.substring(prefix.length());
            if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
                sendError(ex, 400, "Invalid filename"); return;
            }
            if (!ALLOWED_FILES.contains(filename)) {
                sendError(ex, 403, "Filename not allowed: " + filename); return;
            }

            Path file   = DATA_DIR.resolve(filename);
            String method = ex.getRequestMethod().toUpperCase();

            switch (method) {
                case "GET" -> {
                    if (!Files.exists(file)) {
                        sendError(ex, 404, "File not found: " + filename); return;
                    }
                    String content = Files.readString(file, StandardCharsets.UTF_8);
                    LOG.info("GET /api/config/" + filename + " → " + content.length() + " bytes");
                    sendText(ex, content);
                }
                case "PUT" -> {
                    String body = readBody(ex);
                    if (body.isBlank()) {
                        sendError(ex, 400, "Empty body — nothing written"); return;
                    }
                    // Validate JSON files before writing
                    if (JSON_FILES.contains(filename)) {
                        String jsonErr = validateJson(body);
                        if (jsonErr != null) {
                            sendError(ex, 422, "Invalid JSON in " + filename + ": " + jsonErr);
                            return;
                        }
                    }
                    atomicWrite(file, filename, body);
                    LOG.info("PUT /api/config/" + filename + " → wrote " + body.length() + " bytes");
                    send(ex, 200, "application/json; charset=utf-8",
                            "{\"ok\":true,\"file\":\"" + filename + "\"}");
                }
                default -> sendError(ex, 405, "Method not allowed: " + method);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: POST /api/settings/save  — ATOMIC MULTI-FILE SAVE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Accepts a JSON object where each key is a config filename and each value
     * is the raw file content (string).
     *
     * Request body example:
     * {
     *   "conf.properties":   "# conf.properties...",
     *   "llm.ini":           "# llm.ini...",
     *   "rag.ini":           "# rag.ini...",
     *   "performance.ini":   "# performance.ini...",
     *   "chat.ini":          "# chat.ini...",
     *   "capacity.ini":      "# capacity.ini..."
     * }
     *
     * Response (success):
     *   200  { "ok": true, "written": ["conf.properties", "llm.ini", ...] }
     *
     * Response (validation error):
     *   422  { "error": "Invalid JSON in mcpconf.ini: ..." }
     *
     * Response (write error):
     *   500  { "error": "Write failed for conf.properties: ..." }
     *
     * All files are validated BEFORE any writes. If validation passes, all
     * writes are performed; a write failure returns 500 but already-written
     * files in this batch may have succeeded (the .tmp rename is atomic per
     * file, but the batch is not a database transaction).
     */
    static class SaveHandler implements HttpHandler {

        @Override
        public void handle(HttpExchange ex) throws IOException {
            addCors(ex);

            // CORS pre-flight
            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }

            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendError(ex, 405, "Method not allowed. Use POST.");
                return;
            }

            // ── 1. Read body ──────────────────────────────────────────────────
            String body = readBody(ex);
            if (body == null || body.isBlank()) {
                sendError(ex, 400, "Empty request body");
                return;
            }

            // ── 2. Parse outer JSON envelope ─────────────────────────────────
            // We parse manually to avoid pulling in a JSON library dependency.
            // The envelope is a flat object: { "filename": "content", ... }
            Map<String, String> files;
            try {
                files = parseStringMap(body);
            } catch (IllegalArgumentException e) {
                sendError(ex, 400, "Request body must be a JSON object: " + e.getMessage());
                return;
            }

            if (files.isEmpty()) {
                sendError(ex, 400, "No files in request body");
                return;
            }

            // ── 3. Validate all filenames and content BEFORE writing ──────────
            List<String> validationErrors = new ArrayList<>();

            for (Map.Entry<String, String> entry : files.entrySet()) {
                String filename = entry.getKey();
                String content  = entry.getValue();

                // Filename allow-list
                if (!ALLOWED_FILES.contains(filename)) {
                    validationErrors.add("Disallowed filename: " + filename
                            + ". Allowed: " + ALLOWED_FILES);
                    continue;
                }

                // Path traversal guard
                if (filename.contains("..") || filename.contains("/") || filename.contains("\\")) {
                    validationErrors.add("Invalid filename: " + filename);
                    continue;
                }

                // Empty content guard
                if (content == null || content.isBlank()) {
                    validationErrors.add("Empty content for: " + filename);
                    continue;
                }

                // JSON validity for .json files
                if (JSON_FILES.contains(filename)) {
                    String jsonErr = validateJson(content);
                    if (jsonErr != null) {
                        validationErrors.add("Invalid JSON in " + filename + ": " + jsonErr);
                    }
                }
            }

            if (!validationErrors.isEmpty()) {
                sendError(ex, 422, String.join("; ", validationErrors));
                return;
            }

            // ── 4. Write all files atomically ─────────────────────────────────
            List<String> written = new ArrayList<>();
            try {
                for (Map.Entry<String, String> entry : files.entrySet()) {
                    String filename = entry.getKey();
                    String content  = entry.getValue();
                    Path   file     = DATA_DIR.resolve(filename);
                    atomicWrite(file, filename, content);
                    written.add(filename);
                    LOG.info("POST /api/settings/save → wrote " + filename
                            + " (" + content.length() + " bytes)");
                }
            } catch (IOException ioEx) {
                String msg = "Write failed after writing " + written + ": " + ioEx.getMessage();
                LOG.severe(msg);
                sendError(ex, 500, msg);
                return;
            }

            // ── 5. Success response ───────────────────────────────────────────
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"written\":[");
            for (int i = 0; i < written.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("\"").append(written.get(i)).append("\"");
            }
            sb.append("]}");
            sendJson(ex, sb.toString());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared utilities
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Writes content to file atomically: writes to a .tmp sibling first,
     * then renames so readers never see a half-written file.
     */
    private static void atomicWrite(Path file, String filename, String content)
            throws IOException {
        Path tmp = file.resolveSibling(filename + ".tmp");
        Files.writeString(tmp, content, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        Files.move(tmp, file,
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
    }

    /**
     * Validates that a string is parseable as JSON (object or array).
     * Returns null on success, or an error message on failure.
     *
     * Uses a lightweight bracket/quote scanner — no external library needed.
     */
    static String validateJson(String content) {
        if (content == null) return "null input";
        String trimmed = content.strip();
        if (trimmed.isEmpty()) return "empty string";

        // Must start with { or [
        char first = trimmed.charAt(0);
        if (first != '{' && first != '[') {
            return "must start with '{' or '[', got '" + first + "'";
        }

        // Walk through to verify brackets balance and strings are closed
        Deque<Character> stack = new ArrayDeque<>();
        boolean inString      = false;
        boolean escaped        = false;

        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);

            if (escaped) { escaped = false; continue; }
            if (c == '\\' && inString) { escaped = true; continue; }

            if (c == '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;

            if (c == '{' || c == '[') {
                stack.push(c);
            } else if (c == '}') {
                if (stack.isEmpty() || stack.peek() != '{') {
                    return "unexpected '}' at position " + i;
                }
                stack.pop();
            } else if (c == ']') {
                if (stack.isEmpty() || stack.peek() != '[') {
                    return "unexpected ']' at position " + i;
                }
                stack.pop();
            }
        }

        if (inString)       return "unclosed string literal";
        if (!stack.isEmpty()) return "unclosed bracket: " + stack.peek();

        return null; // valid
    }

    /**
     * Minimal JSON object parser: { "key": "value", ... }
     * Only handles string values (file contents are always strings).
     * Does not support nested objects, arrays, numbers, or null as values —
     * the outer envelope is always a flat string map.
     *
     * @throws IllegalArgumentException on parse error
     */
    static Map<String, String> parseStringMap(String json) {
        Map<String, String> result = new LinkedHashMap<>();
        String s = json.strip();

        if (!s.startsWith("{") || !s.endsWith("}")) {
            throw new IllegalArgumentException("Not a JSON object");
        }

        // Remove outer braces
        s = s.substring(1, s.length() - 1).strip();
        if (s.isEmpty()) return result;

        int i = 0;
        while (i < s.length()) {
            // Skip whitespace
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
            if (i >= s.length()) break;

            // Expect opening quote for key
            if (s.charAt(i) != '"') throw new IllegalArgumentException(
                    "Expected '\"' for key at position " + i + ", got '" + s.charAt(i) + "'");

            // Read key
            int[] keyEnd = new int[1];
            String key = readJsonString(s, i, keyEnd);
            i = keyEnd[0];

            // Skip whitespace + colon
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
            if (i >= s.length() || s.charAt(i) != ':') throw new IllegalArgumentException(
                    "Expected ':' after key \"" + key + "\" at position " + i);
            i++; // consume ':'

            // Skip whitespace
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
            if (i >= s.length()) throw new IllegalArgumentException(
                    "Expected value for key \"" + key + "\"");

            // Read value (must be a string for our use-case)
            if (s.charAt(i) != '"') throw new IllegalArgumentException(
                    "Expected string value for key \"" + key + "\", got '" + s.charAt(i) + "'");

            int[] valEnd = new int[1];
            String value = readJsonString(s, i, valEnd);
            i = valEnd[0];

            result.put(key, value);

            // Skip whitespace + optional comma
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
            if (i < s.length() && s.charAt(i) == ',') i++;
        }

        return result;
    }

    /**
     * Reads a JSON-encoded string starting at position start (pointing at the
     * opening '"'). Updates end[0] to the position after the closing '"'.
     * Handles \" and \\ escape sequences.
     */
    private static String readJsonString(String s, int start, int[] end) {
        if (s.charAt(start) != '"') throw new IllegalArgumentException(
                "Expected '\"' at position " + start);
        StringBuilder sb = new StringBuilder();
        int i = start + 1;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '\\') {
                i++;
                if (i >= s.length()) throw new IllegalArgumentException("Unexpected end after '\\'");
                char esc = s.charAt(i);
                switch (esc) {
                    case '"'  -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/'  -> sb.append('/');
                    case 'n'  -> sb.append('\n');
                    case 'r'  -> sb.append('\r');
                    case 't'  -> sb.append('\t');
                    case 'b'  -> sb.append('\b');
                    case 'f'  -> sb.append('\f');
                    case 'u'  -> {
                        if (i + 4 >= s.length()) throw new IllegalArgumentException("Incomplete \\u at " + i);
                        int codePoint = Integer.parseInt(s.substring(i + 1, i + 5), 16);
                        sb.append((char) codePoint);
                        i += 4;
                    }
                    default   -> throw new IllegalArgumentException("Unknown escape: \\" + esc);
                }
            } else if (c == '"') {
                end[0] = i + 1;
                return sb.toString();
            } else {
                sb.append(c);
            }
            i++;
        }
        throw new IllegalArgumentException("Unclosed string starting at position " + start);
    }
}