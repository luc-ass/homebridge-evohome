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

/** Answers requests from the fixtures, routed by URL. */
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
    if (url.includes("/domesticHotWater/") && url.includes("/schedule")) {
      return Promise.resolve(jsonResponse(fixture("scheduleDhw.json")));
    }
    if (url.includes("/schedule")) {
      return Promise.resolve(jsonResponse(fixture("scheduleZone.json")));
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
    throw new Error("Service is missing");
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
    // Startup runs asynchronously inside the event handler.
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
    vi.useRealTimers();
  });

  describe("discovery", () => {
    it("creates a thermostat for every heating zone", async () => {
      await startPlatform();

      const names = test.registered.map(nameOf);
      expect(names).toContain("Wohnzimmer Thermostat");
      expect(names).toContain("Bad Thermostat");
      expect(names).toContain("Flur Thermostat");
    });

    it("skips zones with an unknown model", async () => {
      // Fixture zone 3004 has modelType "NeuesVentilModell2027".
      await startPlatform();

      expect(test.registered.map(nameOf)).not.toContain(
        "Wintergarten Thermostat",
      );
      expect(log.warnings.join()).toContain("Wintergarten");
    });

    it("creates a hot water accessory", async () => {
      await startPlatform();
      expect(test.registered.map(nameOf)).toContain("Evohome Hot Water");
    });

    it("only creates switches for supported system modes", async () => {
      await startPlatform();

      const names = test.registered.map(nameOf);
      expect(names).toContain("Evohome Away Mode");
      expect(names).toContain("Evohome Eco Mode");
      expect(names).toContain("Evohome Custom Mode");
    });

    it("omits disabled switches", async () => {
      await startPlatform({ ...baseConfig, switchAway: false });

      expect(test.registered.map(nameOf)).not.toContain("Evohome Away Mode");
      expect(test.registered.map(nameOf)).toContain("Evohome Eco Mode");
    });

    it("fetches zones, mode and hot water with a single status call", async () => {
      await startPlatform();

      const statusCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("/status"),
      );
      expect(statusCalls).toHaveLength(1);
    });
  });

  describe("stable identity (#61)", () => {
    it("derives the UUID from the zoneId, not from the position", async () => {
      await startPlatform();

      const wohnzimmer = test.registered.find(
        (a) => nameOf(a) === "Wohnzimmer Thermostat",
      );
      expect(wohnzimmer?.UUID).toBe(hap.uuid.generate("evohome:zone:3001"));
    });

    it("reuses a cached accessory", async () => {
      const uuid = hap.uuid.generate("evohome:zone:3001");
      const cached = new test.api.platformAccessory(
        "Wohnzimmer Thermostat",
        uuid,
      );

      const platform = await startPlatform(baseConfig, [cached]);

      expect(platform.cachedAccessoryCount).toBeGreaterThan(0);
      // The cached accessory must not be registered again.
      expect(test.registered.map((a) => a.UUID)).not.toContain(uuid);
    });

    it("removes accessories that no longer exist", async () => {
      const stale = new test.api.platformAccessory(
        "Abgerissene Zone",
        hap.uuid.generate("evohome:zone:9999"),
      );

      await startPlatform(baseConfig, [stale]);

      expect(test.unregistered.map(nameOf)).toEqual(["Abgerissene Zone"]);
    });
  });

  describe("thermostat characteristics", () => {
    const thermostatFor = async (name: string): Promise<Service> => {
      await startPlatform();
      const accessory = test.registered.find((a) => nameOf(a) === name);
      if (accessory === undefined) {
        throw new Error(`Accessory ${name} is missing`);
      }
      return serviceOf(accessory, hap.Service.Thermostat);
    };

    it("reports the current temperature", async () => {
      const service = await thermostatFor("Wohnzimmer Thermostat");

      await expect(
        service
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).resolves.toBe(21.5);
    });

    it("clamps the setpoint to the zone minimum (#94)", async () => {
      // The "Flur" zone reports targetHeatTemperature 5 with minHeatSetpoint 5;
      // the "Bad" zone has minimum 10 and a target of 22.
      const service = await thermostatFor("Bad Thermostat");

      await expect(
        service
          .getCharacteristic(hap.Characteristic.TargetTemperature)
          .handleGetRequest(),
      ).resolves.toBe(22);
    });

    it("reports an error rather than NaN when the zone has no reading", async () => {
      // The "Flur" zone has isAvailable: false, which in 0.11.2 produced the
      // warning "expected valid finite number and received NaN" (#94).
      const service = await thermostatFor("Flur Thermostat");

      await expect(
        service
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).rejects.toBeDefined();
    });

    it("offers the Eve valve position without a HAP warning", async () => {
      const service = await thermostatFor("Wohnzimmer Thermostat");
      const valve = service.characteristics.find(
        (c) => c.UUID === "E863F12E-079E-48FF-8F27-9C2605A29F52",
      );

      expect(valve).toBeDefined();
      // Wohnzimmer: 21.5 °C is above the 20 °C target, so the valve is closed.
      await expect(valve?.handleGetRequest()).resolves.toBe(0);
    });

    it("writes a clamped setpoint to the API", async () => {
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

    it("keeps the end time of a running override (#149)", async () => {
      // The "Bad" zone in the fixture: TemporaryOverride until 2026-09-03T18:30Z.
      // 0.11.2 would have replaced that end time with the next switchpoint.
      const service = await thermostatFor("Bad Thermostat");
      vi.setSystemTime(new Date("2026-09-03T16:01:00Z"));

      await service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(21);

      const write = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/heatSetpoint"),
      );
      expect(
        JSON.parse((write?.[1] as { body: string }).body) as unknown,
      ).toEqual({
        HeatSetpointValue: 21,
        SetpointMode: "TemporaryOverride",
        TimeUntil: "2026-09-03T18:30:00Z",
      });
    });

    it("uses the next switchpoint when no override is running (#149)", async () => {
      // The "Wohnzimmer" zone follows the schedule. Monday, 07:00 local time
      // (CEST); the next switchpoint in the fixture is 08:30.
      const service = await thermostatFor("Wohnzimmer Thermostat");
      vi.setSystemTime(new Date("2026-08-03T05:00:00Z"));

      await service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(21);

      const write = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/heatSetpoint"),
      );
      const body = JSON.parse((write?.[1] as { body: string }).body) as Record<
        string,
        unknown
      >;
      expect(body["SetpointMode"]).toBe("TemporaryOverride");
      expect(body["TimeUntil"]).toBe("2026-08-03T06:30:00Z");
    });

    it("fetches the schedule only once per zone", async () => {
      const service = await thermostatFor("Wohnzimmer Thermostat");

      await service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(21);
      await service
        .getCharacteristic(hap.Characteristic.TargetTemperature)
        .handleSetRequest(22);

      const scheduleCalls = fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("/schedule"),
      );
      expect(scheduleCalls).toHaveLength(1);
    });

    it("cancels the override when AUTO is selected", async () => {
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

  describe("hot water (#180)", () => {
    it("answers a switch-on instead of running into a timeout", async () => {
      // 0.11.2 called its callback only on failure, so HomeKit ran into
      // "Error Action Set Failed" after about 15 seconds.
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

    it("reports the hot water temperature", async () => {
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

  describe("faults and battery", () => {
    /** The fixture with a replaced fault list on the "Wohnzimmer" zone. */
    const statusWithZoneFault = (faultType: string): Response => {
      const status = fixture("locationStatus.json") as {
        gateways: {
          temperatureControlSystems: {
            zones: { activeFaults: unknown[] }[];
          }[];
        }[];
      };
      status.gateways[0]!.temperatureControlSystems[0]!.zones[0]!.activeFaults =
        [{ faultType, since: "2026-09-01T07:12:00Z" }];
      return jsonResponse(status);
    };

    const accessoryNamed = (name: string): PlatformAccessory => {
      const accessory = test.registered.find((a) => nameOf(a) === name);
      if (accessory === undefined) {
        throw new Error(`Accessory ${name} is missing`);
      }
      return accessory;
    };

    it("reports a low battery on the zone that has one", async () => {
      // The "Flur" zone reports TempZoneActuatorLowBattery in the fixture.
      await startPlatform();
      const flur = serviceOf(
        accessoryNamed("Flur Thermostat"),
        hap.Service.Battery,
      );
      const wohnzimmer = serviceOf(
        accessoryNamed("Wohnzimmer Thermostat"),
        hap.Service.Battery,
      );

      await expect(
        flur
          .getCharacteristic(hap.Characteristic.StatusLowBattery)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
      await expect(
        wohnzimmer
          .getCharacteristic(hap.Characteristic.StatusLowBattery)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    });

    it("does not declare a zone faulty just because its battery is low", async () => {
      await startPlatform();
      const service = serviceOf(
        accessoryNamed("Flur Thermostat"),
        hap.Service.Thermostat,
      );

      await expect(
        service
          .getCharacteristic(hap.Characteristic.StatusFault)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusFault.NO_FAULT);
    });

    it("reports a lost radio link as a fault", async () => {
      fetchMock = routedFetch({
        "/status": () =>
          statusWithZoneFault("TempZoneActuatorCommunicationLost"),
      });
      vi.stubGlobal("fetch", fetchMock);
      await startPlatform();
      const accessory = accessoryNamed("Wohnzimmer Thermostat");

      await expect(
        serviceOf(accessory, hap.Service.Thermostat)
          .getCharacteristic(hap.Characteristic.StatusFault)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
      // …and the battery stays normal.
      await expect(
        serviceOf(accessory, hap.Service.Battery)
          .getCharacteristic(hap.Characteristic.StatusLowBattery)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    });

    it("registers StatusFault as optional to avoid a HAP warning", async () => {
      // HAP does not list StatusFault among the thermostat service's optional
      // characteristics. Without addOptionalCharacteristic() it is still added,
      // but with a "Adding anyway" characteristic warning per zone and start.
      await startPlatform();
      const service = serviceOf(
        accessoryNamed("Wohnzimmer Thermostat"),
        hap.Service.Thermostat,
      );

      expect(
        service.optionalCharacteristics.map(
          (characteristic) => characteristic.UUID,
        ),
      ).toContain(hap.Characteristic.StatusFault.UUID);
    });

    it("warns about a fault that was already present at startup", async () => {
      // The earlier condition compared against `previous?.activeFaults.length`,
      // which is undefined on the first update: a flat battery at start was
      // never logged at all.
      await startPlatform();

      expect(log.warnings.join("\n")).toContain(
        "Flur: TempZoneActuatorLowBattery.",
      );
    });

    it("reports faults for the hot water too", async () => {
      const status = fixture("locationStatus.json") as {
        gateways: {
          temperatureControlSystems: { dhw: { activeFaults: unknown[] } }[];
        }[];
      };
      status.gateways[0]!.temperatureControlSystems[0]!.dhw.activeFaults = [
        { faultType: "DHWSensorLowBattery", since: "2026-09-01T07:12:00Z" },
      ];
      fetchMock = routedFetch({ "/status": () => jsonResponse(status) });
      vi.stubGlobal("fetch", fetchMock);
      await startPlatform();
      const accessory = accessoryNamed("Evohome Hot Water");

      await expect(
        serviceOf(accessory, hap.Service.Battery)
          .getCharacteristic(hap.Characteristic.StatusLowBattery)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
      expect(log.warnings.join("\n")).toContain(
        "Hot water: DHWSensorLowBattery.",
      );
    });
  });

  describe("system mode switches", () => {
    it("mirrors the active mode from the status", async () => {
      // The fixture reports AutoWithEco as the active mode.
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

    it("resets to Auto when switched off", async () => {
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

  describe("failure cases", () => {
    it("aborts with a clear message when credentials are missing", async () => {
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

    it("keeps known accessories when startup fails", async () => {
      // In this case 0.11.2 called callback([]) and HomeKit lost every accessory.
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
      expect(log.infos.join()).toContain("Known accessories are kept");
    });

    it("warns about an unknown locationId and falls back", async () => {
      await startPlatform({ ...baseConfig, locationId: "nicht-vorhanden" });

      expect(log.warnings.join()).toContain("nicht-vorhanden");
      expect(test.registered.map(nameOf)).toContain("Wohnzimmer Thermostat");
    });

    it("uses a matching locationId without warning", async () => {
      await startPlatform({ ...baseConfig, locationId: "9876543" });

      expect(log.warnings.join()).not.toContain("9876543");
      expect(test.registered.map(nameOf)).toContain("Wohnzimmer Thermostat");
    });
  });

  it("stops the poller on shutdown", async () => {
    await startPlatform();
    const before = fetchMock.mock.calls.length;

    test.emit("shutdown");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
