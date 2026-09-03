import type { API, Logging, PlatformAccessory } from "homebridge";

/**
 * Eve app history, backed by `fakegato-history`.
 *
 * The package is loaded **only** when the `history` option is on. The reason is
 * issue #166: `fakegato-storage.js` unconditionally requires `./lib/googleDrive`
 * on line 11, and with it `googleapis` — even for `storage: "fs"`, which is all
 * this plugin ever uses. On Hoobs, startup failed on exactly that import,
 * without any involvement of Evohome.
 *
 * With `"history": false` in the configuration, `fakegato-history` is never
 * imported and `googleapis` therefore never loaded — the way out for affected
 * installations. To avoid installing the dependency at all, use
 * `npm install --omit=optional`; the plugin then runs without history rather
 * than failing at startup.
 */

/**
 * One sample in the history, in the shape the Eve `thermo` type expects.
 *
 * Deliberately a type alias rather than an interface: only type aliases get an
 * implicit index signature and are therefore assignable to the
 * `Record<string, number>` that `fakegato-history` expects.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see the comment above
export type HistoryEntry = {
  /** Unix time in seconds. */
  readonly time: number;
  readonly currentTemp: number;
  readonly setTemp: number;
  /** 0 or 100 — the API reports no real valve position. */
  readonly valvePosition: number;
};

export interface HistoryService {
  addEntry(entry: HistoryEntry): void;
}

/** Creates a history service for an accessory. */
export type HistoryFactory = (
  accessory: PlatformAccessory,
) => HistoryService | undefined;

/** Does nothing; used when history is off or unavailable. */
const noHistory: HistoryFactory = () => undefined;

/**
 * Loads `fakegato-history`, if wanted and installed.
 *
 * Always returns a usable factory; if the package is missing it yields
 * `undefined` per accessory. A missing optional package must not prevent
 * startup.
 */
export const loadHistoryFactory = async (
  api: API,
  log: Logging,
  enabled: boolean,
): Promise<HistoryFactory> => {
  if (!enabled) {
    log.debug(
      'Eve history is disabled ("history": false); fakegato-history will not be loaded.',
    );
    return noHistory;
  }

  let createHistory;
  try {
    const module = await import("fakegato-history");
    createHistory = module.default(api);
  } catch (error) {
    log.warn(
      `Eve history unavailable: fakegato-history could not be loaded (${String(error)}). ` +
        'Install it with "npm install fakegato-history", or set "history": false to silence this message.',
    );
    return noHistory;
  }

  log.debug("Eve history enabled (fakegato-history).");

  return (accessory) => {
    try {
      return new createHistory("thermo", accessory, {
        storage: "fs",
        path: api.user.storagePath(),
        log,
      });
    } catch (error) {
      // A broken history must not take the thermostat down with it.
      log.warn(
        `Could not set up history for "${accessory.displayName}": ${String(error)}`,
      );
      return undefined;
    }
  };
};
