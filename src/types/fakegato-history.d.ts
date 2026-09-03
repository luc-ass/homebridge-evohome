/**
 * Minimale Typdeklaration für `fakegato-history`.
 *
 * Das Paket bringt keine Typen mit. Deklariert wird nur, was dieses Plugin
 * tatsächlich benutzt — nicht die vollständige API.
 */
declare module "fakegato-history" {
  import type { API, Logging, PlatformAccessory } from "homebridge";

  interface FakeGatoOptions {
    /** `"fs"` schreibt in den Homebridge-Storage, `"googleDrive"` wird nicht genutzt. */
    storage?: "fs";
    path?: string;
    log?: Logging;
    disableTimer?: boolean;
  }

  interface FakeGatoHistory {
    // Die tatsächlichen Felder hängen vom Accessory-Typ ab; für "thermo"
    // sind es time, currentTemp, setTemp und valvePosition.
    addEntry(entry: Readonly<Record<string, number>>): void;
  }

  type FakeGatoHistoryConstructor = new (
    accessoryType: string,
    accessory: PlatformAccessory,
    options?: FakeGatoOptions,
  ) => FakeGatoHistory;

  /** Das Modul exportiert eine Fabrik, die mit der Homebridge-API aufgerufen wird. */
  const factory: (api: API) => FakeGatoHistoryConstructor;
  export default factory;
}
