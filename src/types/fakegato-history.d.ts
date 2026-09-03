/**
 * Minimal type declaration for `fakegato-history`.
 *
 * The package ships no types. Only what this plugin actually uses is declared
 * here, not the full API.
 */
declare module "fakegato-history" {
  import type { API, Logging, PlatformAccessory } from "homebridge";

  interface FakeGatoOptions {
    /** `"fs"` writes to the Homebridge storage; `"googleDrive"` is never used. */
    storage?: "fs";
    path?: string;
    log?: Logging;
    disableTimer?: boolean;
  }

  interface FakeGatoHistory {
    // The actual fields depend on the accessory type; for "thermo" they are
    // time, currentTemp, setTemp and valvePosition.
    addEntry(entry: Readonly<Record<string, number>>): void;
  }

  type FakeGatoHistoryConstructor = new (
    accessoryType: string,
    accessory: PlatformAccessory,
    options?: FakeGatoOptions,
  ) => FakeGatoHistory;

  /** The module exports a factory that is called with the Homebridge API. */
  const factory: (api: API) => FakeGatoHistoryConstructor;
  export default factory;
}
