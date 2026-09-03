import { describe, expect, it, vi } from "vitest";

import { loadHistoryFactory } from "../src/history.js";
import { createTestApi, createTestLog, hap } from "./hapStub.js";

/**
 * Der Kern von Issue #166: `fakegato-storage.js` lädt in Zeile 11 unbedingt
 * `./lib/googleDrive` und damit `googleapis` — auch bei `storage: "fs"`.
 * Auf Hoobs scheiterte der Start an genau diesem Import.
 *
 * Mit `history: false` darf das Paket deshalb gar nicht erst angefasst werden.
 */
describe("loadHistoryFactory", () => {
  const accessoryFor = (name: string): ReturnType<typeof makeAccessory> =>
    makeAccessory(name);

  const makeAccessory = (name: string) => {
    const { api } = createTestApi();
    return new api.platformAccessory(name, hap.uuid.generate(name));
  };

  it("lädt fakegato-history nicht, wenn die Historie abgeschaltet ist (#166)", async () => {
    const { api } = createTestApi();
    const log = createTestLog();

    const factory = await loadHistoryFactory(api, log, false);

    expect(factory(accessoryFor("Wohnzimmer"))).toBeUndefined();
    // Kein Warnhinweis — das ist ein gewollter Zustand, kein Problem.
    expect(log.warnings).toEqual([]);
  });

  it("legt bei aktiver Historie einen Verlaufsdienst an", async () => {
    const { api } = createTestApi();
    const log = createTestLog();

    const factory = await loadHistoryFactory(api, log, true);
    const history = factory(accessoryFor("Wohnzimmer Thermostat"));

    expect(history).toBeDefined();
    expect(typeof history?.addEntry).toBe("function");
    expect(log.warnings).toEqual([]);
  });

  it("nimmt Messpunkte entgegen", async () => {
    const { api } = createTestApi();
    const factory = await loadHistoryFactory(api, createTestLog(), true);
    const history = factory(accessoryFor("Bad Thermostat"));

    expect(() => {
      history?.addEntry({
        time: Math.floor(Date.now() / 1000),
        currentTemp: 21.5,
        setTemp: 20,
        valvePosition: 0,
      });
    }).not.toThrow();
  });

  it("läuft ohne Historie weiter, wenn das Paket fehlt", async () => {
    // Ein fehlendes optionales Paket darf den Start nicht verhindern.
    vi.doMock("fakegato-history", () => {
      throw new Error("Cannot find module 'fakegato-history'");
    });
    vi.resetModules();

    const { loadHistoryFactory: load } = await import("../src/history.js");
    const { api } = createTestApi();
    const log = createTestLog();

    const factory = await load(api, log, true);

    expect(factory(accessoryFor("Wohnzimmer"))).toBeUndefined();
    expect(log.warnings.join()).toContain("fakegato-history");
    expect(log.warnings.join()).toContain('"history": false');

    vi.doUnmock("fakegato-history");
    vi.resetModules();
  });
});
