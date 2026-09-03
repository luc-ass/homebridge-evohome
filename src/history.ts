import type { API, Logging, PlatformAccessory } from "homebridge";

/**
 * Anbindung der Eve-App-Historie über `fakegato-history`.
 *
 * Das Paket wird **nur dann geladen**, wenn die Option `history` aktiv ist.
 * Der Grund ist Issue #166: `fakegato-storage.js` lädt in Zeile 11
 * unbedingt `./lib/googleDrive` und damit `googleapis` — auch bei
 * `storage: "fs"`, das dieses Plugin ausschließlich verwendet. Auf Hoobs
 * scheiterte der Start genau an diesem Import, ohne dass es etwas mit
 * Evohome zu tun hatte.
 *
 * Mit `"history": false` in der Konfiguration wird `fakegato-history` nie
 * importiert, `googleapis` folglich nie geladen — das ist der Ausweg für
 * betroffene Installationen. Wer die Abhängigkeit gar nicht erst installieren
 * will, nutzt `npm install --omit=optional`; das Plugin läuft dann ohne
 * Historie weiter, statt beim Start zu scheitern.
 */

/**
 * Ein Messpunkt im Verlauf, wie ihn der Eve-Typ `thermo` erwartet.
 *
 * Bewusst ein Type-Alias und kein Interface: nur Type-Aliase bekommen eine
 * implizite Index-Signatur und sind damit zu dem `Record<string, number>`
 * zuweisbar, das `fakegato-history` erwartet.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- siehe Kommentar oben
export type HistoryEntry = {
  /** Unix-Zeit in Sekunden. */
  readonly time: number;
  readonly currentTemp: number;
  readonly setTemp: number;
  /** 0 oder 100 — die API liefert keine echte Ventilstellung. */
  readonly valvePosition: number;
};

export interface HistoryService {
  addEntry(entry: HistoryEntry): void;
}

/** Legt für ein Accessory einen Verlaufsdienst an. */
export type HistoryFactory = (
  accessory: PlatformAccessory,
) => HistoryService | undefined;

/** Tut nichts — wird verwendet, wenn die Historie aus oder nicht verfügbar ist. */
const noHistory: HistoryFactory = () => undefined;

/**
 * Lädt `fakegato-history`, sofern gewünscht und installiert.
 *
 * Gibt immer eine benutzbare Fabrik zurück; fehlt das Paket, liefert sie
 * `undefined` je Accessory. Ein fehlendes optionales Paket darf den Start
 * nicht verhindern.
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
      // Ein kaputter Verlauf darf das Thermostat nicht mitreißen.
      log.warn(
        `Could not set up history for "${accessory.displayName}": ${String(error)}`,
      );
      return undefined;
    }
  };
};
