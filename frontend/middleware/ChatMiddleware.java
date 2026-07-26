import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.logging.*;
import java.util.regex.Pattern;

/**
 * ChatMiddleware — Unified MCP Dashboard
 *
 * Sits between the chat frontend and the backend services.
 * The frontend NEVER calls the Intent Agent or RAG backend directly.
 * All chat traffic goes through here.
 *
 * REST endpoints:
 *
 *   POST /api/chat         → forwards to Intent Agent (:7000/query),
 *                            returns full JSON response (non-streaming)
 *
 *   POST /api/chat/stream  → forwards to RAG backend (:5000/stream),
 *                            pipes SSE stream straight to the browser
 *
 * HOW TO RUN:
 *   javac ChatMiddleware.java
 *   java  ChatMiddleware
 *
 * Environment overrides:
 *   CHAT_PORT          — port this middleware listens on   (default: 5100)
 *   INTENT_AGENT_URL   — Intent Agent base URL             (default: http://localhost:7000)
 *   RAG_BACKEND_URL    — RAG backend base URL              (default: http://localhost:5000)
 *   CONNECT_TIMEOUT_MS — outbound connection timeout ms    (default: 5000)
 *   READ_TIMEOUT_MS    — outbound read timeout ms          (default: 120000)
 */
public class ChatMiddleware {

    // ── Configuration ─────────────────────────────────────────────────────────

    private static final int PORT = Integer.parseInt(
            System.getenv().getOrDefault("CHAT_PORT", "5100"));

    private static final String INTENT_AGENT_URL = System.getenv()
            .getOrDefault("INTENT_AGENT_URL", "http://localhost:7000");

    private static final String RAG_BACKEND_URL = System.getenv()
            .getOrDefault("RAG_BACKEND_URL", "http://localhost:5000");

    /** Timeout waiting for the upstream connection to be established (ms) */
    private static final int CONNECT_TIMEOUT_MS = Integer.parseInt(
            System.getenv().getOrDefault("CONNECT_TIMEOUT_MS", "5000"));

    /**
     * Read timeout for upstream responses (ms).
     * Must be large enough for the LLM to finish a full response.
     * Default 120 s matches Ollama's typical worst-case latency on CPU.
     */
    private static final int READ_TIMEOUT_MS = Integer.parseInt(
            System.getenv().getOrDefault("READ_TIMEOUT_MS", "600000"));

    // ── Logging ───────────────────────────────────────────────────────────────

    private static final Logger LOG = Logger.getLogger("ChatMiddleware");

    /**
     * Runs the (blocking) Intent Agent HTTP call off the request-handling
     * thread so StreamHandler is free to emit task-progress SSE events
     * while it waits. Separate from the HttpServer's own executor.
     */
    private static final ExecutorService AGENT_POOL = Executors.newCachedThreadPool();

    /**
     * Fixed, human-readable task labels shown in the chat UI while the
     * (non-streaming) Intent Agent does its work. The Intent Agent has no
     * real progress callback, so these are emitted on a timer and simply
     * describe the pipeline stages in order — see Phase 5.
     */
    private static final String[] TASK_STEPS = {
            "Querying connected MCP servers for live data",
            "Indexing fetched data into RAG",
            "Sending retrieval request to RAG",
            "Analyzing intent and building context",
            "Generating response",
    };

    /** Delay between emitting each fixed task step while upstream is still running (ms). */
    private static final long TASK_STEP_INTERVAL_MS = 1200;

    static {
        LogManager.getLogManager().reset();
        ConsoleHandler ch = new ConsoleHandler();
        ch.setLevel(Level.ALL);
        ch.setFormatter(new SimpleFormatter() {
            @Override public String format(LogRecord r) {
                return String.format("[%s] %s: %s%n",
                        r.getLevel(), r.getLoggerName(), r.getMessage());
            }
        });
        LOG.addHandler(ch);
        LOG.setLevel(Level.INFO);
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    public static void main(String[] args) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        // /api/chat        → non-streaming, goes to Intent Agent
        // /api/chat/stream → SSE stream,    goes to RAG backend
        //
        // Note: com.sun.net.httpserver matches on longest prefix, so
        // /api/chat/stream must be registered BEFORE /api/chat.
        server.createContext("/api/chat/stream", new StreamHandler());
        server.createContext("/api/chat",        new ChatHandler());
        server.createContext("/health",          new HealthHandler());
        server.createContext("/",                new CatchAllHandler());

        // Use a thread pool so a slow LLM response on one connection
        // does not block the server from accepting other requests.
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();

        LOG.info("ChatMiddleware listening on http://localhost:" + PORT);
        LOG.info("  POST /api/chat         → " + INTENT_AGENT_URL + "/query");
        LOG.info("  POST /api/chat/stream  → " + RAG_BACKEND_URL  + "/stream");
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
            sendJson(ex, "{\"status\":\"ok\",\"service\":\"chat\",\"port\":" + PORT + "}");
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
            sendError(ex, 404, "No such route on ChatMiddleware: " + ex.getRequestURI().getPath());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: POST /api/chat
    //
    // Frontend sends:  { "message": "what is the count of errors in dynatrace" }
    // We forward:      { "query": "<message>" }   to Intent Agent /query
    // We return:       { "reply": "<answer>", "meta": { "intent": ..., "elapsed": ... } }
    // ─────────────────────────────────────────────────────────────────────────

    static class ChatHandler implements HttpHandler {

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

            // 1. Read the body the frontend sent us
            String frontendBody = readBody(ex);
            if (frontendBody.isBlank()) {
                sendError(ex, 400, "Empty request body");
                return;
            }

            // 2. Extract "message" field and repackage as { "query": "..." }
            //    We do this with a minimal string operation to avoid pulling in
            //    a JSON library — the field is always a simple string value.
            String message = extractJsonString(frontendBody, "message");
            if (message == null || message.isBlank()) {
                sendError(ex, 400, "Missing 'message' field in request body");
                return;
            }

            String agentBody = "{\"query\":" + jsonEscape(message) + "}";

            LOG.info("POST /api/chat → forwarding to Intent Agent: "
                    + message.substring(0, Math.min(80, message.length())));

            // 3. Forward to Intent Agent
            String agentTarget = INTENT_AGENT_URL + "/query";
            HttpURLConnection conn = null;
            try {
                conn = openConnection(agentTarget, "POST", false);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(agentBody.getBytes(StandardCharsets.UTF_8));
                }

                int status = conn.getResponseCode();

                // Read whichever stream is available (error stream on non-2xx)
                InputStream upstream = status >= 200 && status < 300
                        ? conn.getInputStream()
                        : conn.getErrorStream();

                String agentResponse = upstream == null ? "{}"
                        : new String(upstream.readAllBytes(), StandardCharsets.UTF_8);

                if (status < 200 || status >= 300) {
                    LOG.warning("Intent Agent returned HTTP " + status + ": " + agentResponse);
                    sendError(ex, 502, "Intent Agent error: HTTP " + status);
                    return;
                }

                // 4. Extract the answer from the agent's response and repackage
                //    AgentResponse shape (from server.py / agent.py):
                //    { "rag_response": { "answer": "..." }, "intent": "...",
                //      "confidence": 0.9, "elapsed_ms": 1234, "error": null }
                String answer  = extractNestedJsonString(agentResponse, "rag_response", "answer");
                if (answer == null) {
                    // Fallback: try top-level "response" key some agent versions use
                    answer = extractJsonString(agentResponse, "response");
                }
                if (answer == null) {
                    answer = "I was unable to retrieve an answer. Please try again.";
                }

                // NOTE: unlike the RAG backend's /stream endpoint (app.py), the
                // Intent Agent (server.py/agent.py) does not strip <think>...</think>
                // reasoning blocks from its answer. We intentionally do NOT strip
                // them here anymore — the frontend (ai_chat.js) now parses
                // <think>...</think> out client-side and renders it as a
                // collapsible "Thinking" panel, so the raw block needs to reach
                // the browser intact.

                String intent    = extractJsonString(agentResponse, "intent");
                String elapsedRaw = extractJsonValue(agentResponse, "elapsed_ms");

                String reply = "{"
                        + "\"reply\":"   + jsonEscape(answer)  + ","
                        + "\"meta\":{"
                        +   "\"intent\":"  + jsonEscape(intent == null ? "" : intent) + ","
                        +   "\"elapsed\":" + (elapsedRaw != null ? elapsedRaw : "0")
                        + "}}";

                LOG.info("POST /api/chat → replied (" + reply.length() + " bytes)");
                sendJson(ex, reply);

            } catch (IOException e) {
                LOG.warning("POST /api/chat → Intent Agent unreachable: " + e.getMessage());
                sendError(ex, 503, "Intent Agent unreachable: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: POST /api/chat/stream
    //
    // Frontend sends:  { "message": "...", "file_ids": [] }
    // We forward:      { "question": "...", "file_ids": [] }  to RAG /stream
    // We pipe back the SSE stream as-is (text/event-stream).
    //
    // The RAG backend emits:
    //   data: <token>\n\n   (repeated)
    //   data: [DONE]\n\n    (terminal sentinel)
    // ─────────────────────────────────────────────────────────────────────────

    static class StreamHandler implements HttpHandler {

        /** Result of the background call to the Intent Agent. */
        private static class UpstreamResult {
            final int status;
            final String body;
            UpstreamResult(int status, String body) { this.status = status; this.body = body; }
        }

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

            String frontendBody = readBody(ex);
            if (frontendBody.isBlank()) {
                sendError(ex, 400, "Empty request body");
                return;
            }

            String message = extractJsonString(frontendBody, "message");
            if (message == null || message.isBlank()) {
                sendError(ex, 400, "Missing 'message' field in request body");
                return;
            }

            // Same shape as ChatHandler — Intent Agent only accepts {"query": "..."}
            String agentBody = "{\"query\":" + jsonEscape(message) + "}";
            String agentTarget = INTENT_AGENT_URL + "/query";

            LOG.info("POST /api/chat/stream → forwarding to Intent Agent: "
                    + message.substring(0, Math.min(80, message.length())));

            // Set SSE response headers BEFORE we know the upstream result — we need
            // the connection open so we can stream [TASK] progress events while the
            // (blocking, non-streaming) Intent Agent call is still in flight. Any
            // upstream failure from here on is reported as an SSE "[ERROR] ..." event
            // rather than an HTTP status, since headers are already committed.
            ex.getResponseHeaders().set("Content-Type",  "text/event-stream; charset=utf-8");
            ex.getResponseHeaders().set("Cache-Control", "no-cache");
            ex.getResponseHeaders().set("X-Accel-Buffering", "no");
            ex.sendResponseHeaders(200, 0);  // 0 = chunked transfer

            // Run the actual (blocking) upstream call on a background thread so this
            // thread is free to emit task-progress events on a timer while waiting.
            final HttpURLConnection[] connHolder = new HttpURLConnection[1];
            Future<UpstreamResult> future = AGENT_POOL.submit(() ->
                    callIntentAgent(agentTarget, agentBody, connHolder));

            try {
                int stepIdx = 0;
                UpstreamResult result = null;

                // Emit fixed task steps, one at a time, until either the upstream
                // call finishes or we run out of steps.
                while (stepIdx < TASK_STEPS.length) {
                    writeSse(ex, "[TASK] " + TASK_STEPS[stepIdx]);
                    stepIdx++;
                    try {
                        result = future.get(TASK_STEP_INTERVAL_MS, TimeUnit.MILLISECONDS);
                        break; // finished early
                    } catch (TimeoutException stillWorking) {
                        // not done yet — loop around and emit the next step
                    }
                }

                // All fixed steps have been shown but the upstream call may still be
                // running (Intent Agent round trips can take 30s–3min+). Block until
                // it finishes — no further [TASK] events are needed at this point.
                if (result == null) {
                    result = future.get();
                }

                if (result.status < 200 || result.status >= 300) {
                    LOG.warning("Intent Agent returned HTTP " + result.status + ": " + result.body);
                    writeSse(ex, "[ERROR] Intent Agent error: HTTP " + result.status);
                    return;
                }

                // Same extraction logic as ChatHandler — AgentResponse shape:
                // { "rag_response": { "answer": "..." }, "intent": "...", ... }
                String answer = extractNestedJsonString(result.body, "rag_response", "answer");
                if (answer == null) {
                    answer = extractJsonString(result.body, "response");
                }
                if (answer == null) {
                    answer = "I was unable to retrieve an answer. Please try again.";
                }
                // Intentionally NOT stripping <think> — the frontend renders it
                // as a collapsible reasoning panel.

                // Intent Agent has no native streaming — the full answer only
                // arrives after its whole round trip. We replay it as simulated
                // word-by-word SSE chunks so the existing streaming UI still
                // animates the text in, even though nothing is truly incremental.
                pseudoStreamText(ex, answer);

                LOG.info("POST /api/chat/stream → Intent Agent round trip complete ("
                        + answer.length() + " chars)");

            } catch (IOException clientGone) {
                // The browser aborted the fetch (Phase 6 stop button, navigation,
                // etc.) — writing to the response body threw because the connection
                // is closed. Best-effort: cancel the still-running upstream call.
                LOG.info("POST /api/chat/stream → client disconnected, cancelling upstream call");
                future.cancel(true);
                if (connHolder[0] != null) connHolder[0].disconnect();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (ExecutionException e) {
                String causeMsg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
                LOG.warning("POST /api/chat/stream → Intent Agent unreachable: " + causeMsg);
                try {
                    writeSse(ex, "[ERROR] Intent Agent unreachable: " + causeMsg);
                } catch (IOException ignored) {
                    // client already gone — nothing more to do
                }
            }
        }

        /** Performs the blocking outbound call to the Intent Agent. Runs on AGENT_POOL. */
        private static UpstreamResult callIntentAgent(String target, String body,
                                                        HttpURLConnection[] connHolder) throws IOException {
            HttpURLConnection conn = null;
            try {
                conn = openConnection(target, "POST", false);
                connHolder[0] = conn;
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }

                int status = conn.getResponseCode();
                InputStream upstream = status >= 200 && status < 300
                        ? conn.getInputStream()
                        : conn.getErrorStream();

                String responseBody = upstream == null ? "{}"
                        : new String(upstream.readAllBytes(), StandardCharsets.UTF_8);

                return new UpstreamResult(status, responseBody);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /** Writes one SSE event. Throws IOException if the client has disconnected. */
        private static void writeSse(HttpExchange ex, String data) throws IOException {
            OutputStream out = ex.getResponseBody();
            String escaped = data.replace("\n", "\\n");
            out.write(("data: " + escaped + "\n\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        /**
         * Writes a complete answer to the client as a sequence of SSE events,
         * one word (plus trailing whitespace) at a time, with a small delay
         * between each so the existing streaming UI animates it in rather
         * than dumping the whole answer at once.
         */
        private static void pseudoStreamText(HttpExchange ex, String text) throws IOException {
            // Split keeping each run of trailing whitespace attached to its word
            String[] tokens = text.split("(?<=\\s)");
            for (String token : tokens) {
                if (token.isEmpty()) continue;
                writeSse(ex, token);
                try {
                    Thread.sleep(20);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
            writeSse(ex, "[DONE]");
        }
    }

    // ── Shared helpers ────────────────────────────────────────────────────────

    /**
     * Strips any <think>...</think> reasoning block(s) from a complete
     * (non-streamed) piece of text. Case-insensitive, tolerant of
     * surrounding whitespace, DOTALL so it matches across newlines.
     *
     * This mirrors app.py's _strip_think_from_chunk() for the streaming
     * path, but operates on a whole string at once since /api/chat
     * receives the full answer in one shot rather than as tokens.
     */
    private static final Pattern THINK_BLOCK =
            Pattern.compile("(?is)<think>.*?</think>");

    static String stripThink(String text) {
        if (text == null) return null;
        return THINK_BLOCK.matcher(text).replaceAll("").trim();
    }

    /** Open an outbound HTTP connection to a target URL. */
    private static HttpURLConnection openConnection(String target, String method,
                                                     boolean streaming) throws IOException {
        URL url = new URL(target);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setDoOutput(true);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        // For streaming, use the full read timeout; for regular calls same value.
        conn.setReadTimeout(READ_TIMEOUT_MS);
        // Disable automatic redirect following (we want to surface errors clearly)
        conn.setInstanceFollowRedirects(false);
        return conn;
    }

    private static void addCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin",  "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

    // ── Minimal JSON helpers ──────────────────────────────────────────────────
    //
    // These avoid pulling in a JSON library for what are simple, well-known
    // shapes.  If the upstream response format ever changes substantially,
    // swap these out for org.json or Jackson.

    /**
     * Extracts a string value for a top-level key from a flat JSON object.
     * Returns null if the key is absent or the value is JSON null.
     *
     * Example: extractJsonString("{\"intent\":\"rag\"}", "intent") → "rag"
     */
    static String extractJsonString(String json, String key) {
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return null;

        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return null;

        int valueStart = colon + 1;
        while (valueStart < json.length() && json.charAt(valueStart) == ' ') valueStart++;
        if (valueStart >= json.length()) return null;

        if (json.charAt(valueStart) == '"') {
            // Quoted string — find the matching close quote (skip escaped quotes)
            int start = valueStart + 1;
            StringBuilder sb = new StringBuilder();
            for (int i = start; i < json.length(); i++) {
                char c = json.charAt(i);
                if (c == '\\' && i + 1 < json.length()) {
                    char next = json.charAt(i + 1);
                    switch (next) {
                        case '"'  -> { sb.append('"');  i++; }
                        case '\\'-> { sb.append('\\'); i++; }
                        case 'n'  -> { sb.append('\n'); i++; }
                        case 'r'  -> { sb.append('\r'); i++; }
                        case 't'  -> { sb.append('\t'); i++; }
                        default   -> sb.append(c);
                    }
                } else if (c == '"') {
                    return sb.toString();
                } else {
                    sb.append(c);
                }
            }
        } else if (json.startsWith("null", valueStart)) {
            return null;
        }
        return null;
    }

    /**
     * Extracts a raw (non-string) JSON value for a top-level key.
     * Returns the value as its raw JSON text (number, boolean, array, object).
     * Returns null if the key is absent.
     *
     * Example: extractJsonValue("{\"elapsed_ms\":1234}", "elapsed_ms") → "1234"
     */
    static String extractJsonValue(String json, String key) {
        String search = "\"" + key + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return null;

        int colon = json.indexOf(':', ki + search.length());
        if (colon < 0) return null;

        int start = colon + 1;
        while (start < json.length() && json.charAt(start) == ' ') start++;
        if (start >= json.length()) return null;

        char first = json.charAt(start);
        if (first == '"') {
            // It's actually a string — return it quoted
            String s = extractJsonString(json, key);
            return s == null ? null : "\"" + s + "\"";
        }

        // Number, boolean, null, array or object — find end by scanning
        int depth = 0;
        int end = start;
        for (; end < json.length(); end++) {
            char c = json.charAt(end);
            if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') {
                if (depth == 0) break;
                depth--;
            } else if ((c == ',' || c == '\n') && depth == 0) {
                break;
            }
        }
        String raw = json.substring(start, end).trim();
        return raw.isEmpty() ? null : raw;
    }

    /**
     * Extracts a string value from a nested object.
     * Only one level of nesting is supported (sufficient for AgentResponse).
     *
     * Example: extractNestedJsonString(json, "rag_response", "answer")
     *   finds the value of "rag_response": { "answer": "..." }
     */
    static String extractNestedJsonString(String json, String outerKey, String innerKey) {
        String search = "\"" + outerKey + "\"";
        int ki = json.indexOf(search);
        if (ki < 0) return null;

        int braceOpen = json.indexOf('{', ki + search.length());
        if (braceOpen < 0) return null;

        // Find the matching closing brace
        int depth = 1;
        int i = braceOpen + 1;
        for (; i < json.length() && depth > 0; i++) {
            char c = json.charAt(i);
            if (c == '{') depth++;
            else if (c == '}') depth--;
        }
        if (depth != 0) return null;

        String nested = json.substring(braceOpen, i);
        return extractJsonString(nested, innerKey);
    }

    /**
     * Wraps a plain Java string as a JSON string literal,
     * escaping special characters.
     */
    static String jsonEscape(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"'  -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default   -> sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }
}