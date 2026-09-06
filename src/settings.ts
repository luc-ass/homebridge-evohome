/**
 * Central constants for the plugin.
 *
 * PLATFORM_NAME must match `pluginAlias` in config.schema.json, PLUGIN_NAME must
 * match `name` in package.json. Neither may change without forcing existing
 * users to edit their config.json.
 */

/** The alias the platform is referenced by in config.json. */
export const PLATFORM_NAME = "Evohome";

/** The npm package name Homebridge loads the plugin under. */
export const PLUGIN_NAME = "homebridge-evohome";

/** Base URL of the Resideo/Honeywell TCC environment (EMEA). */
export const DEFAULT_BASE_URL = "https://tccna.resideo.com";

/** Path of the EMEA API below the base URL. */
export const API_PATH = "/WebAPI/emea/api/v1";

/**
 * Default polling interval in seconds.
 *
 * 0.11.2 polled every 300s and that stays the default. The minimum below keeps
 * us clear of Honeywell's rate limit.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;

/** Smallest polling interval we accept, in seconds. */
export const MIN_POLL_INTERVAL_SECONDS = 60;

/** Timeout for a single HTTP request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Delay before re-reading the status after a write, in milliseconds.
 *
 * Honeywell's servers do not reflect a change in the status immediately.
 * 0.11.2 waited three seconds here as well.
 */
export const REFRESH_DELAY_MS = 3000;

/**
 * How often the location's UTC offset is re-read, in milliseconds.
 *
 * The status the poller fetches carries no timezone, so the offset comes from
 * the installation info. Once a day is one request against roughly 288 status
 * polls, and it catches a daylight saving change within a day of it happening
 * (issue #217).
 */
export const TIMEZONE_REFRESH_MS = 24 * 60 * 60 * 1000;
