package com.dashboardnew.middleware;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Properties;
import java.util.logging.Logger;

/**
 * MiddlewareConfig — shared config-file loader for all 6 middleware services
 * (Observability, Settings, Chat, Capacity, Topology, Admin).
 *
 * Previously each service read only environment variables (with a hardcoded
 * fallback) for things like its listen port. This adds one properties file,
 * read once per JVM and shared by every service, that sits above the
 * environment as the preferred source:
 *
 *   backend/data/middleware.properties  >  environment variable  >  hardcoded default
 *
 * FILE LOCATION
 *   backend/data/middleware.properties, resolved relative to MCP_ROOT (the
 *   same project-root env var the other middlewares already use for their
 *   data files). Override the path itself with MIDDLEWARE_CONFIG_FILE
 *   (absolute, or relative to the JVM's working directory).
 *
 * MISSING FILE
 *   Not an error — every lookup just falls through to the env var / default,
 *   exactly like before this file existed.
 *
 * KEY NAMING
 *   "<service>.<setting>", e.g. "admin.port", "chat.read_timeout_ms". See
 *   backend/data/middleware.properties for the full set this ships with.
 *
 * NOTE: ChatMiddleware and SettingsMiddleware already load their own
 * per-feature *.ini files (llm.ini, rag.ini, etc.) that are auto-saved by the
 * Settings UI — those still take precedence where they apply. This class is
 * the one place added for the cross-cutting stuff (ports, roots, timeouts)
 * that every service needs but none of those UI-managed files owned.
 */
final class MiddlewareConfig {

    private static final Logger LOG = Logger.getLogger("MiddlewareConfig");

    private static final Properties PROPS = load();

    private MiddlewareConfig() {
    }

    private static Properties load() {
        Properties props = new Properties();

        String root = System.getenv().getOrDefault("MCP_ROOT", ".");
        String explicit = System.getenv("MIDDLEWARE_CONFIG_FILE");
        Path path = (explicit != null && !explicit.isBlank())
                ? Paths.get(explicit)
                : Paths.get(root, "backend", "data", "middleware.properties");

        File file = path.toAbsolutePath().normalize().toFile();
        if (!file.exists()) {
            LOG.info("No middleware.properties found at " + file
                    + " — using env vars / defaults only.");
            return props;
        }
        try (Reader r = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
            props.load(r);
            LOG.info("Loaded middleware config from " + file);
        } catch (IOException e) {
            LOG.warning("Failed to read " + file + ": " + e.getMessage());
        }
        return props;
    }

    /** String lookup: config file > env var > default. */
    static String getString(String configKey, String envVar, String defaultValue) {
        String fromFile = PROPS.getProperty(configKey);
        if (fromFile != null && !fromFile.isBlank()) {
            return fromFile.trim();
        }
        String fromEnv = System.getenv(envVar);
        if (fromEnv != null && !fromEnv.isBlank()) {
            return fromEnv;
        }
        return defaultValue;
    }

    static int getInt(String configKey, String envVar, int defaultValue) {
        return Integer.parseInt(getString(configKey, envVar, String.valueOf(defaultValue)).trim());
    }

    static long getLong(String configKey, String envVar, long defaultValue) {
        return Long.parseLong(getString(configKey, envVar, String.valueOf(defaultValue)).trim());
    }
}
