import { describe, expect, it, vi } from "vitest";

import { loadHistoryFactory } from "../src/history.js";
import { createTestApi, createTestLog, hap } from "./hapStub.js";

/**
 * The core of issue #166: `fakegato-storage.js` unconditionally requires
 * `./lib/googleDrive` on line 11, and with it `googleapis` — even for
 * `storage: "fs"`. On Hoobs, startup failed on exactly that import.
 *
 * With `history: false` the package must therefore never be touched.
 */
describe("loadHistoryFactory", () => {
  const accessoryFor = (name: string): ReturnType<typeof makeAccessory> =>
    makeAccessory(name);

  const makeAccessory = (name: string) => {
    const { api } = createTestApi();
    return new api.platformAccessory(name, hap.uuid.generate(name));
  };

  it("does not load fakegato-history when history is disabled (#166)", async () => {
    const { api } = createTestApi();
    const log = createTestLog();

    const factory = await loadHistoryFactory(api, log, false);

    expect(factory(accessoryFor("Wohnzimmer"))).toBeUndefined();
    // No warning: this is an intended state, not a problem.
    expect(log.warnings).toEqual([]);
  });

  it("creates a history service when history is enabled", async () => {
    const { api } = createTestApi();
    const log = createTestLog();

    const factory = await loadHistoryFactory(api, log, true);
    const history = factory(accessoryFor("Wohnzimmer Thermostat"));

    expect(history).toBeDefined();
    expect(typeof history?.addEntry).toBe("function");
    expect(log.warnings).toEqual([]);
  });

  it("accepts samples", async () => {
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

  it("keeps running without history when the package is missing", async () => {
    // A missing optional package must not prevent startup.
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
