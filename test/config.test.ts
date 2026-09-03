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
  it("reads the required fields", () => {
    const config = readConfig(base, makeLog());

    expect(config.username).toBe("user@example.com");
    expect(config.password).toBe("geheim");
    expect(config.name).toBe("Evohome");
  });

  it("fails with a clear message when credentials are missing", () => {
    expect(() => readConfig({ platform: "Evohome" }, makeLog())).toThrow(
      ConfigError,
    );
    expect(() =>
      readConfig({ platform: "Evohome", username: "  " }, makeLog()),
    ).toThrow(/username.*password/);
  });

  it("shows every mode switch by default", () => {
    const config = readConfig(base, makeLog());

    expect(config.showSwitches).toEqual({
      Away: true,
      DayOff: true,
      AutoWithEco: true,
      HeatingOff: true,
      Custom: true,
    });
  });

  it("honours disabled mode switches", () => {
    const config = readConfig(
      { ...base, switchAway: false, switchEco: false },
      makeLog(),
    );

    expect(config.showSwitches.Away).toBe(false);
    expect(config.showSwitches.AutoWithEco).toBe(false);
    expect(config.showSwitches.DayOff).toBe(true);
  });

  it("warns about a switch that is not a boolean", () => {
    // 0.11.2 compared with `!= false`, so the string "false" silently became on.
    const log = makeLog();
    const config = readConfig({ ...base, switchAway: "false" }, log);

    expect(config.showSwitches.Away).toBe(true);
    expect(log.warnings.join()).toContain("switchAway");
  });

  describe("polling interval", () => {
    it("uses the default when nothing is set", () => {
      expect(readConfig(base, makeLog()).pollIntervalSeconds).toBe(
        DEFAULT_POLL_INTERVAL_SECONDS,
      );
    });

    it("raises intervals that are too short to the minimum", () => {
      // Otherwise the plugin runs into Honeywell's rate limit, affecting every
      // user of the same account.
      const log = makeLog();
      const config = readConfig({ ...base, pollIntervalSeconds: 5 }, log);

      expect(config.pollIntervalSeconds).toBe(MIN_POLL_INTERVAL_SECONDS);
      expect(log.warnings.join()).toContain("rate limit");
    });

    it("rejects nonsensical values", () => {
      const log = makeLog();
      expect(
        readConfig({ ...base, pollIntervalSeconds: "bald" }, log)
          .pollIntervalSeconds,
      ).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
      expect(log.warnings.join()).toContain("pollIntervalSeconds");
    });
  });

  describe("location selection", () => {
    it("accepts locationId and locationIndex", () => {
      const config = readConfig(
        { ...base, locationId: "9876543", locationIndex: 2 },
        makeLog(),
      );

      expect(config.locationId).toBe("9876543");
      expect(config.locationIndex).toBe(2);
    });

    it("falls back to 0 on an invalid index", () => {
      const log = makeLog();
      expect(
        readConfig({ ...base, locationIndex: -1 }, log).locationIndex,
      ).toBe(0);
      expect(log.warnings.join()).toContain("locationIndex");
    });
  });

  describe("removed options", () => {
    it("warns about childBridge and ignores it", () => {
      const log = makeLog();
      readConfig({ ...base, childBridge: true }, log);

      expect(log.warnings.join()).toContain("childBridge");
      expect(log.warnings.join()).toContain("child bridge");
    });

    it("warns about temperatureUnit and ignores it", () => {
      const log = makeLog();
      readConfig({ ...base, temperatureUnit: "Fahrenheit" }, log);

      expect(log.warnings.join()).toContain("temperatureUnit");
    });

    it("stays quiet when no obsolete options are set", () => {
      const log = makeLog();
      readConfig(base, log);

      expect(log.warnings).toEqual([]);
    });
  });

  describe("setpointMode (#149)", () => {
    it("uses keepExistingUntil as the default", () => {
      expect(readConfig(base, makeLog()).setpointMode).toBe(
        "keepExistingUntil",
      );
    });

    it("accepts the other allowed values", () => {
      for (const mode of ["untilNextSwitchpoint", "permanent"]) {
        expect(
          readConfig({ ...base, setpointMode: mode }, makeLog()).setpointMode,
        ).toBe(mode);
      }
    });

    it("rejects unknown values and lists the allowed ones", () => {
      const log = makeLog();
      const config = readConfig({ ...base, setpointMode: "sofort" }, log);

      expect(config.setpointMode).toBe("keepExistingUntil");
      expect(log.warnings.join()).toContain("keepExistingUntil");
      expect(log.warnings.join()).toContain("untilNextSwitchpoint");
    });
  });

  it("reads logTemperatureChanges, off by default (#146)", () => {
    expect(readConfig(base, makeLog()).logTemperatureChanges).toBe(false);
    expect(
      readConfig({ ...base, logTemperatureChanges: true }, makeLog())
        .logTemperatureChanges,
    ).toBe(true);
  });

  it("reads temperatureAboveAsOff, which had no effect in 0.11.2", () => {
    expect(readConfig(base, makeLog()).temperatureAboveAsOff).toBe(false);
    expect(
      readConfig({ ...base, temperatureAboveAsOff: true }, makeLog())
        .temperatureAboveAsOff,
    ).toBe(true);
  });
});
