import { describe, expect, it } from "vitest";

import { EvohomeResponseError } from "../../src/api/errors.js";
import {
  parseInstallationInfo,
  parseLocationStatus,
  parseSchedule,
  parseTokens,
  parseUserAccount,
} from "../../src/api/parse.js";
import { fixture } from "../helpers.js";

describe("parseUserAccount", () => {
  it("reads the account data", () => {
    expect(parseUserAccount(fixture("userAccount.json"))).toEqual({
      userId: "1234567",
      username: "user@example.com",
    });
  });

  it("accepts a numeric userId", () => {
    // Depending on the endpoint the API returns the ID as a number or a string.
    expect(
      parseUserAccount({ userId: 1234567, username: "a@b.c" }).userId,
    ).toBe("1234567");
  });
});

describe("parseTokens", () => {
  it("converts expires_in into an absolute point in time", () => {
    const tokens = parseTokens(fixture("token.json"), 1_000_000);

    expect(tokens.accessToken).toBe("access-token-aaa");
    expect(tokens.refreshToken).toBe("refresh-token-bbb");
    expect(tokens.expiresAt).toBe(1_000_000 + 1799 * 1000);
  });
});

describe("parseInstallationInfo", () => {
  const locations = parseInstallationInfo(fixture("installationInfo.json"));

  it("reads location, time zone and system", () => {
    expect(locations).toHaveLength(1);
    const location = locations[0]!;

    expect(location.locationId).toBe("9876543");
    expect(location.name).toBe("Zuhause");
    expect(location.timeZone.currentOffsetMinutes).toBe(120);
    expect(location.system.systemId).toBe("444001");
    expect(location.gatewayCount).toBe(1);
    expect(location.systemCount).toBe(1);
  });

  /** The fixture with `extra` appended to its list of gateways. */
  const withGateway = (extra: unknown): unknown => {
    const raw = fixture("installationInfo.json") as { gateways: unknown[] }[];
    raw[0]!.gateways.push(extra);
    return raw;
  };

  it("counts the gateways and controllers it does not read", () => {
    const location = parseInstallationInfo(
      withGateway({
        gatewayId: "555002",
        temperatureControlSystems: [
          { systemId: "444002" },
          { systemId: "444003" },
        ],
      }),
    )[0]!;

    expect(location.gatewayCount).toBe(2);
    expect(location.systemCount).toBe(3);
    // Reading still stops at the first controller of the first gateway.
    expect(location.system.systemId).toBe("444001");
  });

  it("counts a malformed extra gateway as empty instead of failing", () => {
    // Its contents are never read, so it must not be able to stop startup.
    const location = parseInstallationInfo(withGateway(null))[0]!;

    expect(location.gatewayCount).toBe(2);
    expect(location.systemCount).toBe(1);
  });

  it("reads the setpoint bounds of every zone", () => {
    // These bounds decide whether HomeKit accepts a value. Zone 3002 has
    // minHeatSetpoint 10, where the 5 °C off value of 0.11.2 produced the
    // warning from issue #94.
    const zones = locations[0]!.system.zones;
    expect(zones.map((zone) => zone.name)).toEqual([
      "Wohnzimmer",
      "Bad",
      "Flur",
      "Wintergarten",
    ]);
    expect(zones[1]!.setpointCapabilities).toEqual({
      minHeatSetpoint: 10,
      maxHeatSetpoint: 35,
      valueResolution: 0.5,
    });
  });

  it("maps unknown valve models to Unknown instead of failing", () => {
    // A new model at Resideo must not take down the whole plugin.
    expect(locations[0]!.system.zones[3]!.modelType).toBe("Unknown");
    expect(locations[0]!.system.zones[2]!.modelType).toBe("RoundWireless");
  });

  it("reads allowedSystemModes as a list of modes", () => {
    expect(locations[0]!.system.allowedSystemModes).toEqual([
      "Auto",
      "AutoWithEco",
      "Away",
      "DayOff",
      "HeatingOff",
      "Custom",
    ]);
  });

  it("reads the hot water ID", () => {
    expect(locations[0]!.system.dhw?.dhwId).toBe("2001");
  });

  it("copes without hot water", () => {
    const raw = fixture("installationInfo.json") as {
      gateways: { temperatureControlSystems: { dhw?: unknown }[] }[];
    }[];
    delete raw[0]!.gateways[0]!.temperatureControlSystems[0]!.dhw;

    expect(parseInstallationInfo(raw)[0]!.system.dhw).toBeUndefined();
  });
});

describe("parseLocationStatus", () => {
  const status = parseLocationStatus(fixture("locationStatus.json"));

  it("reads system mode and zones from a single response", () => {
    // 0.11.2 queried the same endpoint twice.
    expect(status.systemModeStatus.mode).toBe("AutoWithEco");
    expect(status.systemModeStatus.isPermanent).toBe(true);
    expect(status.zones).toHaveLength(4);
  });

  it("reads the end time of a running override", () => {
    // This is exactly the information 0.11.2 lacked, which is why every change
    // from HomeKit overwrote the running override (issue #149).
    const bad = status.zones[1]!;
    expect(bad.setpointStatus.setpointMode).toBe("TemporaryOverride");
    expect(bad.setpointStatus.until?.toISOString()).toBe(
      "2026-09-03T18:30:00.000Z",
    );
  });

  it("reports no temperature when the zone is unavailable", () => {
    // 0.11.2 passed undefined to HomeKit here, which became the warning
    // "expected valid finite number and received NaN" (issue #94).
    const flur = status.zones[2]!;
    expect(flur.temperatureStatus.isAvailable).toBe(false);
    expect(flur.temperatureStatus.temperature).toBeUndefined();
  });

  it("reads active faults as a list of fault types", () => {
    expect(status.zones[2]!.activeFaults).toEqual([
      "TempZoneActuatorLowBattery",
    ]);
    expect(status.zones[0]!.activeFaults).toEqual([]);
  });

  it("reads the hot water status", () => {
    expect(status.dhw).toEqual({
      dhwId: "2001",
      temperatureStatus: { isAvailable: true, temperature: 54.5 },
      state: "On",
      mode: "TemporaryOverride",
      until: new Date("2026-09-03T20:00:00Z"),
      activeFaults: [],
    });
  });
});

describe("error handling while parsing", () => {
  it("names the path of the missing field", () => {
    // The case from issue #205: the API answers with an error body and 0.11.2
    // ran into "Cannot read properties of undefined (reading 'temperature')"
    // without any hint at the cause.
    expect(() => parseLocationStatus({ error: "server unavailable" })).toThrow(
      EvohomeResponseError,
    );

    try {
      parseLocationStatus({ error: "server unavailable" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvohomeResponseError);
      expect((error as EvohomeResponseError).path).toBe(
        "locationStatus.gateways",
      );
      expect((error as Error).message).toContain("expected an array");
    }
  });

  it("reports an empty gateways array instead of accessing it blindly", () => {
    expect(() =>
      parseLocationStatus({ locationId: "1", gateways: [] }),
    ).toThrow(/array is empty/);
  });

  it("reports an unknown system mode along with the allowed values", () => {
    const raw = fixture("locationStatus.json") as {
      gateways: {
        temperatureControlSystems: { systemModeStatus: { mode: string } }[];
      }[];
    };
    raw.gateways[0]!.temperatureControlSystems[0]!.systemModeStatus.mode =
      "AutoWithFrostProtect";

    expect(() => parseLocationStatus(raw)).toThrow(/expected one of/);
  });
});

describe("parseSchedule", () => {
  it("reads a weekly schedule of a heating zone", () => {
    const schedule = parseSchedule(fixture("scheduleZone.json"));

    expect(schedule).toHaveLength(7);
    expect(schedule[0]!.dayOfWeek).toBe("Monday");
    expect(schedule[0]!.switchpoints[0]).toEqual({
      timeOfDay: "06:30:00",
      heatSetpoint: 20.5,
      dhwState: undefined,
    });
  });

  it("reads a weekly schedule for hot water", () => {
    const schedule = parseSchedule(fixture("scheduleDhw.json"));

    expect(schedule[0]!.switchpoints[0]).toEqual({
      timeOfDay: "06:00:00",
      heatSetpoint: undefined,
      dhwState: "On",
    });
  });
});
