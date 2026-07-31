package com.dashboardnew.middleware;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.logging.*;

/**
 * CapacityMiddleware — Unified MCP Dashboard, service #2 of the 6-way split.
 *
 * Real forecast computation, ported 1:1 from frontend/js/capacity.js so
 * results match exactly what the client used to compute (same seeded PRNG,
 * same series generator, same four forecast algorithms). capacity.js's own
 * doc comment described this exact swap-in path: "replace getCapacityData's
 * body with API.getCapacityForecast(params), same shape" — this endpoint
 * returns that shape.
 *
 * REST endpoints:
 *
 *   GET /api/capacity/forecast?sourceId=&sourceLabel=&historyDays=&horizonDays=&algorithm=
 *       → { cpu: {...}, memory: {...}, comparison: [...], recommendations: [...] }
 *   GET /health → { "status": "ok", "service": "capacity" }
 *
 * HOW TO RUN:
 *   javac CapacityMiddleware.java
 *   java  CapacityMiddleware
 *
 * Config:
 *   Reads backend/data/middleware.properties first (key "capacity.port"),
 *   then falls back to the environment variable below, then the hardcoded
 *   default. See MiddlewareConfig.
 *
 * Environment overrides:
 *   CAPACITY_PORT — port to listen on (default: 8082)
 */
public class CapacityMiddleware {

    private static final int PORT =
            MiddlewareConfig.getInt("capacity.port", "CAPACITY_PORT", 8082);

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
        server.createContext("/health",                 new HealthHandler());
        server.createContext("/",                        new CatchAllHandler());

        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();

        LOG.info("CapacityMiddleware listening on http://localhost:" + PORT);
        LOG.info("  GET /api/capacity/forecast?sourceId=&historyDays=&horizonDays=&algorithm=");
        LOG.info("  GET /health");
    }

    // ── Shared HTTP helpers ───────────────────────────────────────────────────

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

    private static Map<String, String> parseQuery(String rawQuery) {
        Map<String, String> out = new LinkedHashMap<>();
        if (rawQuery == null || rawQuery.isBlank()) return out;
        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) {
                    out.put(URLDecoder.decode(pair, "UTF-8"), "");
                } else {
                    out.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                            URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
                }
            } catch (UnsupportedEncodingException ignored) { /* UTF-8 always supported */ }
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Forecast math — ported line-for-line from capacity.js so the numbers
    // this endpoint returns are identical to what the client used to compute.
    // ─────────────────────────────────────────────────────────────────────────

    /** mulberry32-style seeded PRNG — same algorithm as capacity.js's seededRandom(). */
    static final class Rand {
        private int s;
        Rand(int seed) { this.s = seed; }
        double next() {
            s = (s + 0x6D2B79F5);
            int t = s;
            t = imul(t ^ (t >>> 15), t | 1);
            t = t ^ (t + imul(t ^ (t >>> 7), t | 61));
            return ((t ^ (t >>> 14)) & 0xFFFFFFFFL) / 4294967296.0;
        }
        private static int imul(int a, int b) { return a * b; }
    }

    private static int hashSeed(String str) {
        int h = 0;
        for (int i = 0; i < str.length(); i++) {
            h = (31 * h + str.charAt(i));
        }
        return h;
    }

    private static double clamp(double v) { return Math.max(0, Math.min(100, v)); }

    /** Same shape as capacity.js's generateSeries(sourceId, metric, days). */
    private static double[] generateSeries(String sourceId, String metric, int days) {
        Rand rand = new Rand(hashSeed(sourceId + ":" + metric));
        double base = metric.equals("cpu") ? 38 + rand.next() * 12 : 48 + rand.next() * 15;
        double trendPerDay = 0.15 + rand.next() * 0.35;
        double[] points = new double[days];
        int idx = 0;
        for (int i = days - 1; i >= 0; i--) {
            int dayIndex = days - 1 - i;
            double seasonal = Math.sin((dayIndex / 7.0) * Math.PI * 2) * 4;
            double noise = (rand.next() - 0.5) * 8;
            double value = base + trendPerDay * dayIndex + seasonal + noise;
            points[idx++] = Math.max(2, Math.min(98, value));
        }
        return points;
    }

    static final class ForecastResult {
        double[] forecast;
        double confidence;
        ForecastResult(double[] f, double c) { forecast = f; confidence = c; }
    }

    private static ForecastResult linearRegressionForecast(double[] series, int horizon) {
        int n = series.length;
        double meanX = (n - 1) / 2.0;
        double meanY = Arrays.stream(series).average().orElse(0);
        double num = 0, den = 0;
        for (int i = 0; i < n; i++) {
            num += (i - meanX) * (series[i] - meanY);
            den += (i - meanX) * (i - meanX);
        }
        double slope = den == 0 ? 0 : num / den;
        double intercept = meanY - slope * meanX;
        double[] forecast = new double[horizon];
        for (int i = 0; i < horizon; i++) {
            forecast[i] = clamp(intercept + slope * (n + i));
        }
        return new ForecastResult(forecast, 0.78);
    }

    private static ForecastResult movingAverageForecast(double[] series, int horizon) {
        int window = Math.min(5, series.length);
        double sum = 0;
        for (int i = series.length - window; i < series.length; i++) sum += series[i];
        double avg = sum / window;
        double[] forecast = new double[horizon];
        Arrays.fill(forecast, clamp(avg));
        return new ForecastResult(forecast, 0.62);
    }

    private static ForecastResult exponentialSmoothingForecast(double[] series, int horizon) {
        double alpha = 0.35;
        double level = series[0];
        for (int i = 1; i < series.length; i++) {
            level = alpha * series[i] + (1 - alpha) * level;
        }
        double[] forecast = new double[horizon];
        Arrays.fill(forecast, clamp(level));
        return new ForecastResult(forecast, 0.7);
    }

    private static ForecastResult seasonalForecast(double[] series, int horizon) {
        int period = 7;
        double[] forecast = new double[horizon];
        for (int i = 0; i < horizon; i++) {
            int idx = series.length - period + (i % period);
            int wrapped = ((idx % series.length) + series.length) % series.length;
            forecast[i] = clamp(series[wrapped]);
        }
        return new ForecastResult(forecast, 0.66);
    }

    private static ForecastResult runForecast(String algorithm, double[] series, int horizon) {
        switch (algorithm) {
            case "moving_avg":    return movingAverageForecast(series, horizon);
            case "exp_smoothing": return exponentialSmoothingForecast(series, horizon);
            case "seasonal":      return seasonalForecast(series, horizon);
            case "linear":
            default:              return linearRegressionForecast(series, horizon);
        }
    }

    private static double avg(double[] arr) {
        return Arrays.stream(arr).average().orElse(0);
    }

    private static final String[] ALGO_KEYS = { "linear", "moving_avg", "exp_smoothing", "seasonal" };
    private static final Map<String, String[]> ALGO_META = new LinkedHashMap<>();
    static {
        ALGO_META.put("linear",        new String[]{ "Linear Regression",    "Steady, trending growth" });
        ALGO_META.put("moving_avg",    new String[]{ "Moving Average",       "Stable, low-variance workloads" });
        ALGO_META.put("exp_smoothing", new String[]{ "Exponential Smoothing","Recent-weighted, noisy signals" });
        ALGO_META.put("seasonal",      new String[]{ "Seasonal (7-day)",     "Workloads with weekly cycles" });
    }

    private static List<String> buildRecommendations(String sourceId, String sourceLabel,
            double cpuCurrentAvg, double memCurrentAvg, double cpuForecastAvg, double memForecastAvg,
            int horizonDays) {
        String label = sourceId.equals("all") ? "across all sources"
                : (sourceLabel != null && !sourceLabel.isBlank() ? "on " + sourceLabel : "on " + sourceId);
        List<String> recs = new ArrayList<>();
        if (cpuForecastAvg - cpuCurrentAvg > 8) {
            recs.add(String.format("CPU usage %s is trending up — projected to reach <strong>%.1f%%</strong> average within %d days. Consider scaling compute headroom ahead of that window.",
                    label, cpuForecastAvg, horizonDays));
        }
        if (memForecastAvg - memCurrentAvg > 8) {
            recs.add(String.format("Memory usage %s is climbing — forecast average of <strong>%.1f%%</strong> over the next %d days. Review memory limits or plan for additional capacity.",
                    label, memForecastAvg, horizonDays));
        }
        if (cpuForecastAvg > 80 || memForecastAvg > 80) {
            recs.add(String.format("Forecast crosses <strong>80%%</strong> utilization %s — this is close enough to saturation that it's worth flagging for proactive capacity planning, not just monitoring.",
                    label));
        }
        if (recs.isEmpty()) {
            recs.add(String.format("No significant growth trend detected %s over the selected history/horizon — current capacity looks sufficient for now.", label));
        }
        return recs;
    }

    private static String jsonArr(double[] arr) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < arr.length; i++) {
            if (i > 0) sb.append(",");
            sb.append(String.format(Locale.ROOT, "%.3f", arr[i]));
        }
        return sb.append("]").toString();
    }

    private static String jsonStrArr(List<String> arr) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < arr.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("\"").append(arr.get(i).replace("\\", "\\\\").replace("\"", "\\\"")).append("\"");
        }
        return sb.append("]").toString();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Handler: GET /api/capacity/forecast
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

            Map<String, String> q = parseQuery(ex.getRequestURI().getRawQuery());
            String sourceId    = q.getOrDefault("sourceId", "all");
            String sourceLabel = q.get("sourceLabel");
            int historyDays    = parseIntOr(q.get("historyDays"), 14);
            int horizonDays    = parseIntOr(q.get("horizonDays"), 7);
            String algorithm   = q.getOrDefault("algorithm", "linear");

            double[] cpuHistory = generateSeries(sourceId, "cpu", historyDays);
            double[] memHistory = generateSeries(sourceId, "mem", historyDays);

            ForecastResult cpuFc = runForecast(algorithm, cpuHistory, horizonDays);
            ForecastResult memFc = runForecast(algorithm, memHistory, horizonDays);

            StringBuilder comparison = new StringBuilder("[");
            for (int i = 0; i < ALGO_KEYS.length; i++) {
                String key = ALGO_KEYS[i];
                ForecastResult cFc = runForecast(key, cpuHistory, horizonDays);
                ForecastResult mFc = runForecast(key, memHistory, horizonDays);
                String[] meta = ALGO_META.get(key);
                if (i > 0) comparison.append(",");
                comparison.append(String.format(Locale.ROOT,
                        "{\"algo\":\"%s\",\"label\":\"%s\",\"bestFor\":\"%s\",\"cpuForecastAvg\":%.3f,\"memForecastAvg\":%.3f,\"confidence\":%.2f}",
                        key, meta[0], meta[1], avg(cFc.forecast), avg(mFc.forecast), cFc.confidence));
            }
            comparison.append("]");

            int cpuTailN = Math.min(3, cpuHistory.length);
            int memTailN = Math.min(3, memHistory.length);
            double cpuCurrentAvg = avg(Arrays.copyOfRange(cpuHistory, cpuHistory.length - cpuTailN, cpuHistory.length));
            double memCurrentAvg = avg(Arrays.copyOfRange(memHistory, memHistory.length - memTailN, memHistory.length));
            double cpuForecastAvg = avg(cpuFc.forecast);
            double memForecastAvg = avg(memFc.forecast);

            List<String> recs = buildRecommendations(sourceId, sourceLabel, cpuCurrentAvg, memCurrentAvg,
                    cpuForecastAvg, memForecastAvg, horizonDays);

            String json = String.format(Locale.ROOT,
                    "{\"cpu\":{\"history\":%s,\"forecast\":%s,\"currentAvg\":%.3f,\"forecastAvg\":%.3f}," +
                    "\"memory\":{\"history\":%s,\"forecast\":%s,\"currentAvg\":%.3f,\"forecastAvg\":%.3f}," +
                    "\"comparison\":%s,\"recommendations\":%s}",
                    jsonArr(cpuHistory), jsonArr(cpuFc.forecast), cpuCurrentAvg, cpuForecastAvg,
                    jsonArr(memHistory), jsonArr(memFc.forecast), memCurrentAvg, memForecastAvg,
                    comparison, jsonStrArr(recs));

            LOG.info("GET /api/capacity/forecast?sourceId=" + sourceId + "&algorithm=" + algorithm
                    + " → " + json.length() + " bytes");
            sendJson(ex, json);
        }

        private static int parseIntOr(String s, int fallback) {
            if (s == null || s.isBlank()) return fallback;
            try { return Integer.parseInt(s.trim()); } catch (NumberFormatException e) { return fallback; }
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
