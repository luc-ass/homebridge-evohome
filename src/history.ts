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
      'Verlauf für die Eve-App ist abgeschaltet ("history": false), fakegato-history wird nicht geladen.',
    );
    return noHistory;
  }

  let createHistory;
  try {
    const module = await import("fakegato-history");
    createHistory = module.default(api);
  } catch (error) {
    log.warn(
      `Verlauf für die Eve-App nicht verfügbar: fakegato-history konnte nicht geladen werden (${String(error)}). ` +
        'Mit "npm install fakegato-history" nachinstallieren oder "history": false setzen, um diese Meldung abzustellen.',
    );
    return noHistory;
  }

  log.debug("Verlauf für die Eve-App aktiv (fakegato-history).");

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
        `Verlauf für "${accessory.displayName}" konnte nicht angelegt werden: ${String(error)}`,
      );
      return undefined;
    }
  };
};
