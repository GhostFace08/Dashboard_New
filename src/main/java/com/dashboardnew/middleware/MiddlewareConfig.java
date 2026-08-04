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
 * Reads one properties file, once per JVM, shared by every service. It is
 * the preferred source for anything a service needs to know about itself —
 * its listen port, timeouts, AND (as of this change) where its data files
 * live on disk, so no service has a data filename or directory baked into
 * its source:
 *
 *   config/middleware.properties  >  environment variable  >  hardcoded default
 *
 * FILE LOCATION
 *   <MCP_ROOT>/config/middleware.properties — i.e. a "config" folder at the
 *   project root, sitting next to "backend". MCP_ROOT is the same
 *   project-root env var the services already use for everything else
 *   (default: the JVM's working directory). Override the properties file's
 *   own path with MIDDLEWARE_CONFIG_FILE (absolute, or relative to the JVM's
 *   working directory) if it needs to live somewhere else entirely.
 *
 * MISSING FILE
 *   Not an error — every lookup just falls through to the env var / default,
 *   exactly like before this file existed.
 *
 * KEY NAMING
 *   Ports/timeouts/etc: "<service>.<setting>", e.g. "admin.port",
 *   "chat.read_timeout_ms".
 *   Data file locations: "data.dir" (the folder every service's data files
 *   live under, default "backend/data") and "data.file.<name>" for each
 *   individual file's name within that folder, e.g. "data.file.users" →
 *   "users.json". See config/middleware.properties for the full set this
 *   ships with.
 *
 * NOTE: ChatMiddleware and SettingsMiddleware also load their own
 * per-feature *.ini files (llm.ini, rag.ini, etc.) that are auto-saved by the
 * Settings UI — those still take precedence for the settings they own. This
 * class is the one place for the cross-cutting stuff (ports, roots,
 * timeouts, data file locations) that every service needs.
 */
final class MiddlewareConfig {

    private static final Logger LOG = Logger.getLogger("MiddlewareConfig");

    private static final Properties PROPS = load();

    /** The project root every relative path (config file, data dir, ...) is resolved against. */
    private static final Path PROJECT_ROOT =
            Paths.get(System.getenv().getOrDefault("MCP_ROOT", ".")).toAbsolutePath().normalize();

    private MiddlewareConfig() {
    }

    private static Properties load() {
        Properties props = new Properties();

        String root = System.getenv().getOrDefault("MCP_ROOT", ".");
        String explicit = System.getenv("MIDDLEWARE_CONFIG_FILE");
        Path path = (explicit != null && !explicit.isBlank())
                ? Paths.get(explicit)
                : Paths.get(root, "config", "middleware.properties");

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

    /**
     * String lookup with NO environment-variable fallback: config file >
     * default. Used for data file/dir names, which never had an env var of
     * their own (they were hardcoded constants before this change).
     */
    static String getString(String configKey, String defaultValue) {
        String fromFile = PROPS.getProperty(configKey);
        if (fromFile != null && !fromFile.isBlank()) {
            return fromFile.trim();
        }
        return defaultValue;
    }

    static int getInt(String configKey, String envVar, int defaultValue) {
        return Integer.parseInt(getString(configKey, envVar, String.valueOf(defaultValue)).trim());
    }

    static long getLong(String configKey, String envVar, long defaultValue) {
        return Long.parseLong(getString(configKey, envVar, String.valueOf(defaultValue)).trim());
    }

    /** The project root every service resolves its relative paths against (MCP_ROOT, default "."). */
    static Path projectRoot() {
        return PROJECT_ROOT;
    }

    /**
     * The directory all services' data files live under, resolved against
     * projectRoot(). Configurable via "data.dir" (default "backend/data").
     */
    static Path dataDir() {
        return projectRoot().resolve(getString("data.dir", "backend/data"));
    }

    /**
     * Resolves a single data file's path: dataDir() + this file's configured
     * name. `configKey` is looked up in middleware.properties (e.g.
     * "data.file.users"); `defaultName` is used if the key isn't set (e.g.
     * "users.json") — so an un-configured install behaves exactly as before.
     */
    static Path dataFile(String configKey, String defaultName) {
        return dataDir().resolve(getString(configKey, defaultName));
    }

    /**
     * Resolves a single settings/config file's path (llm.ini, rag.ini,
     * conf.properties, etc.): configDir() + this file's configured name.
     * Same shape as dataFile() but resolved against configDir() instead of
     * dataDir(), since these are UI-managed settings files, not data files —
     * they happen to share a default folder but are configurable separately.
     */
    static Path configFile(String configKey, String defaultName) {
        return configDir().resolve(getString(configKey, defaultName));
    }

    /**
     * The directory config-managed *.ini/*.properties/*.json "settings"
     * files live under. Defaults to "config" (the same root-level folder
     * middleware.properties itself lives in) — split out as its own key
     * ("config.dir") in case an install wants settings files kept somewhere
     * else, independent of data.dir.
     */
    static Path configDir() {
        return projectRoot().resolve(getString("config.dir", "config"));
    }
}
