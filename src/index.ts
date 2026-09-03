import type { API } from "homebridge";

import { EvohomePlatform } from "./platform.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

/**
 * Plugin entry point.
 *
 * Homebridge loads this file with a dynamic `import()` and calls the default
 * export with the API instance (homebridge/dist/plugin.js:164).
 */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EvohomePlatform);
};
