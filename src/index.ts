import type { API } from "homebridge";

import { EvohomePlatform } from "./platform.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

/**
 * Einstiegspunkt des Plugins.
 *
 * Homebridge lädt diese Datei per dynamischem `import()` und ruft den
 * Default-Export mit der API-Instanz auf (homebridge/dist/plugin.js:164).
 */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EvohomePlatform);
};
