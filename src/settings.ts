/**
 * Zentrale Konstanten des Plugins.
 *
 * PLATFORM_NAME muss mit `pluginAlias` in config.schema.json übereinstimmen,
 * PLUGIN_NAME mit `name` in package.json. Beides darf sich nicht ändern, ohne
 * dass Bestandsnutzer ihre config.json anpassen müssen.
 */

/** Alias, unter dem die Platform in der config.json referenziert wird. */
export const PLATFORM_NAME = "Evohome";

/** npm-Paketname, unter dem Homebridge das Plugin lädt. */
export const PLUGIN_NAME = "homebridge-evohome";

/** Basis-URL der Resideo/Honeywell TCC-Umgebung (EMEA). */
export const DEFAULT_BASE_URL = "https://tccna.resideo.com";

/** Pfad der EMEA-API unterhalb der Basis-URL. */
export const API_PATH = "/WebAPI/emea/api/v1";

/**
 * Standard-Pollingintervall in Sekunden.
 *
 * Der Altcode pollte alle 300 s. Der Wert bleibt als Default erhalten; das
 * Minimum schützt den Rate-Limiter der Honeywell-Server (siehe Risiko-Tabelle
 * in docs/MIGRATION-HB2.md).
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;

/** Kleinstes zulässiges Pollingintervall in Sekunden. */
export const MIN_POLL_INTERVAL_SECONDS = 60;

/** Timeout für einzelne HTTP-Requests in Millisekunden. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Wartezeit vor der Nachkontrolle eines Schreibvorgangs, in Millisekunden.
 *
 * Die Honeywell-Server übernehmen eine Änderung nicht sofort in den Status.
 * 0.11.2 wartete an dieser Stelle ebenfalls drei Sekunden.
 */
export const REFRESH_DELAY_MS = 3000;
