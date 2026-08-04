package com.dashboardnew.middleware;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * LauncherMain
 * ─────────────────────────────────────────────────────────────────────────
 * Starts all 6 middleware services from a single JVM / single command.
 *
 * Each middleware's main() calls HttpServer.start() (non-blocking) and then
 * returns; the JVM stays alive afterwards because of the non-daemon
 * thread-pool executors each middleware creates. So calling each
 * middleware's main(String[]) in sequence, right here, is enough to get
 * all 6 HTTP servers listening concurrently in one process.
 *
 * BUILD:
 *   mvn package
 *
 * RUN (from the repo root — the directory that contains backend/data AND
 * config/middleware.properties):
 *   java -jar target/dashboard-middleware-1.0.0.jar
 *
 * To run a single middleware standalone instead (e.g. for debugging one
 * service), nothing about the individual classes changed:
 *   java -cp target/dashboard-middleware-1.0.0.jar com.dashboardnew.middleware.AdminMiddleware
 */
public class LauncherMain {

    public static void main(String[] args) throws Exception {
        Map<String, ThrowingRunnable> services = new LinkedHashMap<>();
        services.put("ObservabilityMiddleware", () -> ObservabilityMiddleware.main(new String[0]));
        services.put("SettingsMiddleware",      () -> SettingsMiddleware.main(new String[0]));
        services.put("ChatMiddleware",           () -> ChatMiddleware.main(new String[0]));
        services.put("CapacityMiddleware",       () -> CapacityMiddleware.main(new String[0]));
        services.put("TopologyMiddleware",       () -> TopologyMiddleware.main(new String[0]));
        services.put("AdminMiddleware",           () -> AdminMiddleware.main(new String[0]));

        System.out.println("=== Starting all middleware services ===");

        int started = 0;
        for (Map.Entry<String, ThrowingRunnable> entry : services.entrySet()) {
            String name = entry.getKey();
            try {
                entry.getValue().run();
                started++;
            } catch (Exception e) {
                System.err.println("[LauncherMain] FAILED to start " + name + ": " + e.getMessage());
                e.printStackTrace();
            }
        }

        System.out.println("=== " + started + "/" + services.size() + " middleware services started ===");
        System.out.println("Press Ctrl+C to stop all services.");

        Thread.currentThread().join();
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
