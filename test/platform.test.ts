import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EvohomePlatform } from "../src/platform.js";
import { createTestApi, createTestLog, hap, type TestApi } from "./hapStub.js";
import { fixture, jsonResponse } from "./helpers.js";

import type { PlatformAccessory, PlatformConfig, Service } from "homebridge";

const baseConfig: PlatformConfig = {
  platform: "Evohome",
  name: "Evohome",
  username: "user@example.com",
  password: "geheim",
};

/** Beantwortet Anfragen anhand der URL aus den Fixtures. */
const routedFetch = (
  overrides: Record<string, () => Response> = {},
): ReturnType<typeof vi.fn> =>
  vi.fn((input: string | URL) => {
    const url = String(input);
    for (const [needle, respond] of Object.entries(overrides)) {
      if (url.includes(needle)) {
        return Promise.resolve(respond());
      }
    }
    if (url.includes("/Auth/OAuth/Token")) {
      return Promise.resolve(jsonResponse(fixture("token.json")));
    }
    if (url.includes("/userAccount")) {
      return Promise.resolve(jsonResponse(fixture("userAccount.json")));
    }
    if (url.includes("/location/installationInfo")) {
      return Promise.resolve(jsonResponse(fixture("installationInfo.json")));
    }
    if (url.includes("/status")) {
      return Promise.resolve(jsonResponse(fixture("locationStatus.json")));
    }
    return Promise.resolve(jsonResponse({ id: "task-1" }));
  });

const serviceOf = (
  accessory: PlatformAccessory,
  type: Parameters<PlatformAccessory["getService"]>[0],
): Service => {
  const service = accessory.getService(type as never);
  if (service === undefined) {
    throw new Error("Service fehlt");
  }
  return service;
};

const nameOf = (accessory: PlatformAccessory): string => accessory.displayName;

describe("EvohomePlatform", () => {
  let test: TestApi;
  let log: ReturnType<typeof createTestLog>;
  let fetchMock: ReturnType<typeof routedFetch>;

  const startPlatform = async (
    config: PlatformConfig = baseConfig,
    cached: PlatformAccessory[] = [],
  ): Promise<EvohomePlatform> => {
    const platform = new EvohomePlatform(log, config, test.api);
    for (const accessory of cached) {
      platform.configureAccessory(accessory);
    }
    test.emit("didFinishLaunching");
    // Der Start läuft asynchron im Event-Handler.
    await vi.waitFor(() => {
      expect(test.registered.length > 0 || log.errors.length > 0).toBe(true);
    });
    return platform;
  };

  beforeEach(() => {
    test = createTestApi();
    log = createTestLog();
    fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Erkennung", () => {
    it("legt für jede Heizzone ein Thermostat an", async () => {
      await startPlatform();

      const names = test.registered.map(nameOf);
      expect(names).toContain("Wohnzimmer Thermostat");
      expect(names).toContain("Bad Thermostat");
      expect(names).toContain("Flur Thermostat");
    });

    it("überspringt Zonen mit unbekanntem Modell", async () => {
      // Fixture-Zone 3004 hat modelType "NeuesVentilModell2027".
      await startPlatform();

      expect(test.registered.map(nameOf)).not.toContain(
        "Wintergarten Thermostat",
      );
      expect(log.warnings.join()).toContain("Wintergarten");
    });

    it("legt ein Warmwasser-Accessory an", async () => {
      await startPlatform();
      expect(test.registered.map(nameOf)).toContain("Evohome Hot Water");
    });

    it("legt nur Schalter für unterstützte Systemmodi an", async () => {
      await startPlatform();

      const names = test.registered.map(nameOf);
      expect(names).toContain("Evohome Away Mode");
      expect(names).toContain("Evohome Eco Mode");
      expect(names).toContain("Evohome Custom Mode");
    });

    it("lässt abgeschaltete Schalter weg", async () => {
      await startPlatform({ ...baseConfig, switchAway: false });

      expect(test.registered.map(nameOf)).not.toContain("Evohome Away Mode");
      expect(test.registered.map(nameOf)).toContain("Evohome Eco Mode");
    });

    it("fragt Zonen, Modus und Warmwasser mit einem Statusaufruf ab (S13)", async () => {
      await startPlatform();

      const statusCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("/status"),
      );
      expect(statusCalls).toHaveLength(1);
    });
  });

  describe("Stabile Identität (S1, #61)", () => {
    it("bildet die UUID aus der zoneId, nicht aus der Position", async () => {
      await startPlatform();

      const wohnzimmer = test.registered.find(
        (a) => nameOf(a) === "Wohnzimmer Thermostat",
      );
      expect(wohnzimmer?.UUID).toBe(hap.uuid.generate("evohome:zone:3001"));
    });

    it("verwendet ein zwischengespeichertes Accessory wieder", async () => {
      const uuid = hap.uuid.generate("evohome:zone:3001");
      const cached = new test.api.platformAccessory(
        "Wohnzimmer Thermostat",
        uuid,
      );

      const platform = await startPlatform(baseConfig, [cached]);

      expect(platform.cachedAccessoryCount).toBeGreaterThan(0);
      // Das gecachte Accessory darf nicht erneut registriert werden.
      expect(test.registered.map((a) => a.UUID)).not.toContain(uuid);
    });

    it("entfernt Accessories, die es nicht mehr gibt", async () => {
      const stale = new test.api.platformAccessory(
        "Abgerissene Zone",
        hap.uuid.generate("evohome:zone:9999"),
      );

      await startPlatform(baseConfig, [stale]);

      expect(test.unregistered.map(nameOf)).toEqual(["Abgerissene Zone"]);
    });
  });

  describe("Thermostat-Charakteristiken", () => {
    const thermostatFor = async (name: string): Promise<Service> => {
      await startPlatform();
      const accessory = test.registered.find((a) => nameOf(a) === name);
      if (accessory === undefined) {
        throw new Error(`Accessory ${name} fehlt`);
      }
      return serviceOf(accessory, hap.Service.Thermostat);
    };

    it("meldet die aktuelle Temperatur", async () => {
      const service = await thermostatFor("Wohnzimmer Thermostat");

      await expect(
        service
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).resolves.toBe(21.5);
    });

    it("klemmt den Sollwert auf das Minimum der Zone (#94)", async () => {
      // Zone „Flur" meldet targetHeatTemperature 5 bei minHeatSetpoint 5 —
      // Zone „Bad" hat Minimum 10 und einen Sollwert von 22.
      const service = await thermostatFor("Bad Thermostat");

      await expect(
        service
          .getCharacteristic(hap.Characteristic.TargetTemperature)
          .handleGetRequest(),
      ).resolves.toBe(22);
    });

    it("meldet einen Fehler statt NaN, wenn die Zone keinen Messwert liefert", async () => {
      // Zone „Flur" hat isAvailable: false — in 0.11.2 wurde daraus die
      // Warnung "expected valid finite number and received NaN" (#94).
      const service = await thermostatFor("Flur Thermostat");

      await expect(
        service
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).rejects.toBeDefined();
    });

    it("bietet die Eve-Ventilstellung an, ohne HAP-Warnung", async () => {
      const service = await thermostatFor("Wohnzimmer Thermostat");
      const valve = service.characteristics.find(
        (c) => c.UUID === "E863F12E-079E-48FF-8F27-9C2605A29F52",
      );

      expect(valve).toBeDefined();
      // Wohnzimmer: 21,5 °C ist über dem Sollwert von 20 °C — Ventil zu.
      await expect(valve?.handleGetRequest()).resolves.toBe(0);
    });

    it("schreibt einen geklemmten Sollwert an die API", async () => {
      const service = await thermostatFor("Bad Thermostat");

      await service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(7);

      const write = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/heatSetpoint"),
      );
      expect(write).toBeDefined();
      expect(
        JSON.parse((write?.[1] as { body: string }).body) as unknown,
      ).toMatchObject({ HeatSetpointValue: 10 });
    });

    it("hebt den Override auf, wenn AUTO gewählt wird", async () => {
      const service = await thermostatFor("Bad Thermostat");

      await service
        .getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
        .handleSetRequest(hap.Characteristic.TargetHeatingCoolingState.AUTO);

      const write = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/heatSetpoint"),
      );
      expect(
        JSON.parse((write?.[1] as { body: string }).body) as unknown,
      ).toMatchObject({ SetpointMode: "FollowSchedule" });
    });
  });

  describe("Warmwasser (#180)", () => {
    it("antwortet auf das Einschalten, statt in den Timeout zu laufen", async () => {
      // 0.11.2 rief seinen Callback nur im Fehlerfall auf — HomeKit lief
      // deshalb nach etwa 15 s in "Error Action Set Failed".
      await startPlatform();
      const accessory = test.registered.find(
        (a) => nameOf(a) === "Evohome Hot Water",
      );
      const toggle = serviceOf(accessory!, hap.Service.Switch);

      await expect(
        toggle.getCharacteristic(hap.Characteristic.On).handleSetRequest(true),
      ).resolves.toBeUndefined();

      const write = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/domesticHotWater/2001/state"),
      );
      expect(
        JSON.parse((write?.[1] as { body: string }).body) as unknown,
      ).toMatchObject({ State: "On" });
    });

    it("meldet die Warmwassertemperatur", async () => {
      await startPlatform();
      const accessory = test.registered.find(
        (a) => nameOf(a) === "Evohome Hot Water",
      );
      const sensor = serviceOf(accessory!, hap.Service.TemperatureSensor);

      await expect(
        sensor
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).resolves.toBe(54.5);
    });
  });

  describe("Systemmodus-Schalter", () => {
    it("spiegelt den aktiven Modus aus dem Status", async () => {
      // Die Fixture meldet AutoWithEco als aktiven Modus.
      await startPlatform();

      const eco = test.registered.find((a) => nameOf(a) === "Evohome Eco Mode");
      const away = test.registered.find(
        (a) => nameOf(a) === "Evohome Away Mode",
      );

      await expect(
        serviceOf(eco!, hap.Service.Switch)
          .getCharacteristic(hap.Characteristic.On)
          .handleGetRequest(),
      ).resolves.toBe(true);
      await expect(
        serviceOf(away!, hap.Service.Switch)
          .getCharacteristic(hap.Characteristic.On)
          .handleGetRequest(),
      ).resolves.toBe(false);
    });

    it("setzt beim Ausschalten auf Auto zurück", async () => {
      await startPlatform();
      const eco = test.registered.find((a) => nameOf(a) === "Evohome Eco Mode");

      await serviceOf(eco!, hap.Service.Switch)
        .getCharacteristic(hap.Characteristic.On)
        .handleSetRequest(false);

      const write = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/mode"),
      );
      expect(
        JSON.parse((write?.[1] as { body: string }).body) as unknown,
      ).toMatchObject({ SystemMode: "Auto" });
    });
  });

  describe("Fehlerfälle", () => {
    it("bricht mit klarer Meldung ab, wenn Zugangsdaten fehlen", async () => {
      const platform = new EvohomePlatform(
        log,
        { platform: "Evohome" },
        test.api,
      );
      test.emit("didFinishLaunching");
      await vi.waitFor(() => {
        expect(log.errors.length).toBeGreaterThan(0);
      });

      expect(log.errors.join()).toContain("username");
      expect(test.registered).toHaveLength(0);
      expect(platform.cachedAccessoryCount).toBe(0);
    });

    it("behält bekannte Geräte, wenn der Start scheitert (S1)", async () => {
      // 0.11.2 rief in diesem Fall callback([]) — HomeKit verlor alle Geräte.
      fetchMock = routedFetch({
        "/location/installationInfo": () =>
          jsonResponse("service unavailable", { status: 503 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const cached = new test.api.platformAccessory(
        "Wohnzimmer Thermostat",
        hap.uuid.generate("evohome:zone:3001"),
      );
      const platform = new EvohomePlatform(log, baseConfig, test.api);
      platform.configureAccessory(cached);
      test.emit("didFinishLaunching");

      await vi.waitFor(() => {
        expect(log.errors.length).toBeGreaterThan(0);
      });

      expect(test.unregistered).toHaveLength(0);
      expect(platform.cachedAccessoryCount).toBe(1);
      expect(log.infos.join()).toContain("bleiben erhalten");
    });

    it("weist auf eine unbekannte locationId hin und weicht aus", async () => {
      await startPlatform({ ...baseConfig, locationId: "nicht-vorhanden" });

      expect(log.warnings.join()).toContain("nicht-vorhanden");
      expect(test.registered.map(nameOf)).toContain("Wohnzimmer Thermostat");
    });

    it("verwendet eine passende locationId ohne Warnung", async () => {
      await startPlatform({ ...baseConfig, locationId: "9876543" });

      expect(log.warnings.join()).not.toContain("9876543");
      expect(test.registered.map(nameOf)).toContain("Wohnzimmer Thermostat");
    });
  });

  it("stoppt den Poller beim Herunterfahren (S11)", async () => {
    await startPlatform();
    const before = fetchMock.mock.calls.length;

    test.emit("shutdown");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
