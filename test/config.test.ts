import { describe, expect, it, vi } from "vitest";

import { ConfigError, readConfig } from "../src/config.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
} from "../src/settings.js";

import type { Logging, PlatformConfig } from "homebridge";

const makeLog = (): Logging & { warnings: string[] } => {
  const warnings: string[] = [];
  const log = {
    warnings,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (message: string) => warnings.push(message),
    success: vi.fn(),
    log: vi.fn(),
  };
  return log as unknown as Logging & { warnings: string[] };
};

const base: PlatformConfig = {
  platform: "Evohome",
  username: "user@example.com",
  password: "geheim",
};

describe("readConfig", () => {
  it("liest die Pflichtfelder", () => {
    const config = readConfig(base, makeLog());

    expect(config.username).toBe("user@example.com");
    expect(config.password).toBe("geheim");
    expect(config.name).toBe("Evohome");
  });

  it("bricht mit klarer Meldung ab, wenn Zugangsdaten fehlen", () => {
    expect(() => readConfig({ platform: "Evohome" }, makeLog())).toThrow(
      ConfigError,
    );
    expect(() =>
      readConfig({ platform: "Evohome", username: "  " }, makeLog()),
    ).toThrow(/username.*password/);
  });

  it("zeigt standardmäßig alle Modus-Schalter", () => {
    const config = readConfig(base, makeLog());

    expect(config.showSwitches).toEqual({
      Away: true,
      DayOff: true,
      AutoWithEco: true,
      HeatingOff: true,
      Custom: true,
    });
  });

  it("beachtet abgeschaltete Modus-Schalter", () => {
    const config = readConfig(
      { ...base, switchAway: false, switchEco: false },
      makeLog(),
    );

    expect(config.showSwitches.Away).toBe(false);
    expect(config.showSwitches.AutoWithEco).toBe(false);
    expect(config.showSwitches.DayOff).toBe(true);
  });

  it("warnt bei einem Schalter, der kein Ja/Nein-Wert ist", () => {
    // 0.11.2 verglich mit `!= false` — aus dem String "false" wurde damit
    // stillschweigend „an".
    const log = makeLog();
    const config = readConfig({ ...base, switchAway: "false" }, log);

    expect(config.showSwitches.Away).toBe(true);
    expect(log.warnings.join()).toContain("switchAway");
  });

  describe("Pollingintervall", () => {
    it("verwendet den Standardwert, wenn nichts gesetzt ist", () => {
      expect(readConfig(base, makeLog()).pollIntervalSeconds).toBe(
        DEFAULT_POLL_INTERVAL_SECONDS,
      );
    });

    it("hebt zu kurze Intervalle auf das Minimum an", () => {
      // Sonst läuft das Plugin in den Rate-Limiter von Honeywell und trifft
      // damit alle Nutzer desselben Kontos.
      const log = makeLog();
      const config = readConfig({ ...base, pollIntervalSeconds: 5 }, log);

      expect(config.pollIntervalSeconds).toBe(MIN_POLL_INTERVAL_SECONDS);
      expect(log.warnings.join()).toContain("rate limit");
    });

    it("weist unsinnige Werte zurück", () => {
      const log = makeLog();
      expect(
        readConfig({ ...base, pollIntervalSeconds: "bald" }, log)
          .pollIntervalSeconds,
      ).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
      expect(log.warnings.join()).toContain("pollIntervalSeconds");
    });
  });

  describe("Location-Auswahl (F5)", () => {
    it("übernimmt locationId und locationIndex", () => {
      const config = readConfig(
        { ...base, locationId: "9876543", locationIndex: 2 },
        makeLog(),
      );

      expect(config.locationId).toBe("9876543");
      expect(config.locationIndex).toBe(2);
    });

    it("fällt bei einem ungültigen Index auf 0 zurück", () => {
      const log = makeLog();
      expect(
        readConfig({ ...base, locationIndex: -1 }, log).locationIndex,
      ).toBe(0);
      expect(log.warnings.join()).toContain("locationIndex");
    });
  });

  describe("entfernte Optionen", () => {
    it("warnt bei childBridge und ignoriert es (S2)", () => {
      const log = makeLog();
      readConfig({ ...base, childBridge: true }, log);

      expect(log.warnings.join()).toContain("childBridge");
      expect(log.warnings.join()).toContain("child bridge");
    });

    it("warnt bei temperatureUnit und ignoriert es", () => {
      const log = makeLog();
      readConfig({ ...base, temperatureUnit: "Fahrenheit" }, log);

      expect(log.warnings.join()).toContain("temperatureUnit");
    });

    it("schweigt, wenn keine veralteten Optionen gesetzt sind", () => {
      const log = makeLog();
      readConfig(base, log);

      expect(log.warnings).toEqual([]);
    });
  });

  describe("setpointMode (#149)", () => {
    it("verwendet keepExistingUntil als Voreinstellung", () => {
      expect(readConfig(base, makeLog()).setpointMode).toBe(
        "keepExistingUntil",
      );
    });

    it("übernimmt die anderen erlaubten Werte", () => {
      for (const mode of ["untilNextSwitchpoint", "permanent"]) {
        expect(
          readConfig({ ...base, setpointMode: mode }, makeLog()).setpointMode,
        ).toBe(mode);
      }
    });

    it("weist unbekannte Werte mit Auflistung der erlaubten zurück", () => {
      const log = makeLog();
      const config = readConfig({ ...base, setpointMode: "sofort" }, log);

      expect(config.setpointMode).toBe("keepExistingUntil");
      expect(log.warnings.join()).toContain("keepExistingUntil");
      expect(log.warnings.join()).toContain("untilNextSwitchpoint");
    });
  });

  it("liest logTemperatureChanges, standardmäßig aus (#146)", () => {
    expect(readConfig(base, makeLog()).logTemperatureChanges).toBe(false);
    expect(
      readConfig({ ...base, logTemperatureChanges: true }, makeLog())
        .logTemperatureChanges,
    ).toBe(true);
  });

  it("liest temperatureAboveAsOff, das in 0.11.2 wirkungslos war (S6)", () => {
    expect(readConfig(base, makeLog()).temperatureAboveAsOff).toBe(false);
    expect(
      readConfig({ ...base, temperatureAboveAsOff: true }, makeLog())
        .temperatureAboveAsOff,
    ).toBe(true);
  });
});
