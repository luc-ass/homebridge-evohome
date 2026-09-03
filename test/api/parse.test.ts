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
  it("liest die Kontodaten", () => {
    expect(parseUserAccount(fixture("userAccount.json"))).toEqual({
      userId: "1234567",
      username: "user@example.com",
    });
  });

  it("akzeptiert eine numerische userId", () => {
    // Die API liefert die ID je nach Endpunkt als Zahl oder als String.
    expect(
      parseUserAccount({ userId: 1234567, username: "a@b.c" }).userId,
    ).toBe("1234567");
  });
});

describe("parseTokens", () => {
  it("rechnet expires_in in einen absoluten Zeitpunkt um", () => {
    const tokens = parseTokens(fixture("token.json"), 1_000_000);

    expect(tokens.accessToken).toBe("access-token-aaa");
    expect(tokens.refreshToken).toBe("refresh-token-bbb");
    expect(tokens.expiresAt).toBe(1_000_000 + 1799 * 1000);
  });
});

describe("parseInstallationInfo", () => {
  const locations = parseInstallationInfo(fixture("installationInfo.json"));

  it("liest Location, Zeitzone und System", () => {
    expect(locations).toHaveLength(1);
    const location = locations[0]!;

    expect(location.locationId).toBe("9876543");
    expect(location.name).toBe("Zuhause");
    expect(location.timeZone.currentOffsetMinutes).toBe(120);
    expect(location.system.systemId).toBe("444001");
  });

  it("liest die Sollwertgrenzen jeder Zone", () => {
    // Diese Grenzen entscheiden darüber, ob HomeKit einen Wert annimmt —
    // Zone 3002 hat minHeatSetpoint 10, dort erzeugte der 5-°C-Aus-Wert von
    // 0.11.2 die Warnung aus Issue #94.
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

  it("bildet unbekannte Ventilmodelle auf Unknown ab, statt zu scheitern", () => {
    // Ein neues Modell bei Resideo darf nicht das ganze Plugin lahmlegen.
    expect(locations[0]!.system.zones[3]!.modelType).toBe("Unknown");
    expect(locations[0]!.system.zones[2]!.modelType).toBe("RoundWireless");
  });

  it("liest allowedSystemModes als Liste von Modi", () => {
    expect(locations[0]!.system.allowedSystemModes).toEqual([
      "Auto",
      "AutoWithEco",
      "Away",
      "DayOff",
      "HeatingOff",
      "Custom",
    ]);
  });

  it("liest die Warmwasser-ID", () => {
    expect(locations[0]!.system.dhw?.dhwId).toBe("2001");
  });

  it("kommt ohne Warmwasser aus", () => {
    const raw = fixture("installationInfo.json") as {
      gateways: { temperatureControlSystems: { dhw?: unknown }[] }[];
    }[];
    delete raw[0]!.gateways[0]!.temperatureControlSystems[0]!.dhw;

    expect(parseInstallationInfo(raw)[0]!.system.dhw).toBeUndefined();
  });
});

describe("parseLocationStatus", () => {
  const status = parseLocationStatus(fixture("locationStatus.json"));

  it("liest Systemmodus und Zonen aus einer einzigen Antwort", () => {
    // 0.11.2 fragte denselben Endpunkt zweimal ab (Befund S13).
    expect(status.systemModeStatus.mode).toBe("AutoWithEco");
    expect(status.systemModeStatus.isPermanent).toBe(true);
    expect(status.zones).toHaveLength(4);
  });

  it("liest den Endzeitpunkt eines laufenden Overrides", () => {
    // Genau diese Information fehlte 0.11.2, weshalb jede Änderung aus
    // HomeKit den laufenden Override überschrieb (Issue #149).
    const bad = status.zones[1]!;
    expect(bad.setpointStatus.setpointMode).toBe("TemporaryOverride");
    expect(bad.setpointStatus.until?.toISOString()).toBe(
      "2026-09-03T18:30:00.000Z",
    );
  });

  it("liefert keine Temperatur, wenn die Zone nicht verfügbar ist", () => {
    // 0.11.2 reichte hier undefined an HomeKit durch — daraus wurde die
    // Warnung "expected valid finite number and received NaN" (Issue #94).
    const flur = status.zones[2]!;
    expect(flur.temperatureStatus.isAvailable).toBe(false);
    expect(flur.temperatureStatus.temperature).toBeUndefined();
  });

  it("liest aktive Störungen als Liste von Fehlertypen", () => {
    expect(status.zones[2]!.activeFaults).toEqual([
      "TempZoneActuatorLowBattery",
    ]);
    expect(status.zones[0]!.activeFaults).toEqual([]);
  });

  it("liest den Warmwasserstatus", () => {
    expect(status.dhw).toEqual({
      dhwId: "2001",
      temperatureStatus: { isAvailable: true, temperature: 54.5 },
      state: "On",
      mode: "TemporaryOverride",
      until: new Date("2026-09-03T20:00:00Z"),
    });
  });
});

describe("Fehlerbehandlung beim Parsen", () => {
  it("nennt den Pfad des fehlenden Feldes", () => {
    // Der Fall aus Issue #205: die API antwortet mit einem Fehlerkörper,
    // 0.11.2 lief in "Cannot read properties of undefined (reading
    // 'temperature')" ohne jeden Hinweis auf die Ursache (Befund S8).
    expect(() => parseLocationStatus({ error: "server unavailable" })).toThrow(
      EvohomeResponseError,
    );

    try {
      parseLocationStatus({ error: "server unavailable" });
      expect.unreachable("hätte werfen müssen");
    } catch (error) {
      expect(error).toBeInstanceOf(EvohomeResponseError);
      expect((error as EvohomeResponseError).path).toBe(
        "locationStatus.gateways",
      );
      expect((error as Error).message).toContain("Array erwartet");
    }
  });

  it("meldet ein leeres gateways-Array statt blind zuzugreifen", () => {
    expect(() =>
      parseLocationStatus({ locationId: "1", gateways: [] }),
    ).toThrow(/Array ist leer/);
  });

  it("meldet einen unbekannten Systemmodus mit den erlaubten Werten", () => {
    const raw = fixture("locationStatus.json") as {
      gateways: {
        temperatureControlSystems: { systemModeStatus: { mode: string } }[];
      }[];
    };
    raw.gateways[0]!.temperatureControlSystems[0]!.systemModeStatus.mode =
      "AutoWithFrostProtect";

    expect(() => parseLocationStatus(raw)).toThrow(/erwartet eines von/);
  });
});

describe("parseSchedule", () => {
  it("liest ein Wochenprogramm einer Heizzone", () => {
    const schedule = parseSchedule(fixture("scheduleZone.json"));

    expect(schedule).toHaveLength(7);
    expect(schedule[0]!.dayOfWeek).toBe("Monday");
    expect(schedule[0]!.switchpoints[0]).toEqual({
      timeOfDay: "06:30:00",
      heatSetpoint: 20.5,
      dhwState: undefined,
    });
  });

  it("liest ein Wochenprogramm für Warmwasser", () => {
    const schedule = parseSchedule(fixture("scheduleDhw.json"));

    expect(schedule[0]!.switchpoints[0]).toEqual({
      timeOfDay: "06:00:00",
      heatSetpoint: undefined,
      dhwState: "On",
    });
  });
});
