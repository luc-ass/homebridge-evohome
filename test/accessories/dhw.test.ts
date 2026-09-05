import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomesticHotWaterAccessory } from "../../src/accessories/dhw.js";
import { createTestApi, createTestLog, hap, type TestApi } from "../hapStub.js";

import type { EvohomeClient } from "../../src/api/client.js";
import type { ScheduleCache } from "../../src/api/scheduleCache.js";
import type { DhwStatus } from "../../src/api/types.js";
import type { EvohomeConfig } from "../../src/config.js";
import type { PollingCoordinator } from "../../src/polling.js";
import type { PlatformAccessory, Service } from "homebridge";

const DHW_ID = "9001";

const config = (overrides: Partial<EvohomeConfig> = {}): EvohomeConfig => ({
  name: "Evohome",
  username: "user@example.com",
  password: "secret",
  locationId: undefined,
  locationIndex: 0,
  pollIntervalSeconds: 300,
  temperatureAboveAsOff: false,
  showSwitches: {
    Away: true,
    DayOff: true,
    HeatingOff: true,
    AutoWithEco: true,
    Custom: true,
  },
  history: false,
  setpointMode: "keepExistingUntil",
  logTemperatureChanges: false,
  ...overrides,
});

const status = (overrides: Partial<DhwStatus> = {}): DhwStatus => ({
  dhwId: DHW_ID,
  temperatureStatus: { temperature: 48.5, isAvailable: true },
  state: "On",
  mode: "FollowSchedule",
  until: undefined,
  activeFaults: [],
  ...overrides,
});

/** Mondays 06:00 On, 09:00 Off — the schedule from the fixtures. */
const dailySchedules = [
  {
    dayOfWeek: "Monday",
    switchpoints: [
      { timeOfDay: "06:00:00", heatSetpoint: undefined, dhwState: "On" },
      { timeOfDay: "09:00:00", heatSetpoint: undefined, dhwState: "Off" },
    ],
  },
] as const;

describe("DomesticHotWaterAccessory", () => {
  let test: TestApi;
  let log: ReturnType<typeof createTestLog>;
  let accessory: PlatformAccessory;
  let setDhwState: ReturnType<typeof vi.fn>;
  let scheduleRefresh: ReturnType<typeof vi.fn>;
  let dhwSchedule: ReturnType<typeof vi.fn>;

  const build = (cfg: EvohomeConfig = config()): DomesticHotWaterAccessory =>
    new DomesticHotWaterAccessory(
      test.api,
      accessory,
      DHW_ID,
      "Evohome Hot Water",
      { setDhwState } as unknown as EvohomeClient,
      { scheduleRefresh } as unknown as PollingCoordinator,
      { dhw: dhwSchedule } as unknown as ScheduleCache,
      cfg,
      0,
      log,
    );

  const sensor = (): Service =>
    accessory.getService(hap.Service.TemperatureSensor)!;
  const toggle = (): Service => accessory.getService(hap.Service.Switch)!;
  const battery = (): Service => accessory.getService(hap.Service.Battery)!;

  beforeEach(() => {
    test = createTestApi();
    log = createTestLog();
    accessory = new test.api.platformAccessory(
      "Evohome Hot Water",
      hap.uuid.generate("evohome:dhw:9001"),
    );
    setDhwState = vi.fn().mockResolvedValue({ id: "task-1" });
    scheduleRefresh = vi.fn();
    dhwSchedule = vi.fn().mockResolvedValue(dailySchedules);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("services", () => {
    it("identifies itself with the hot water id", () => {
      build();

      const info = accessory.getService(hap.Service.AccessoryInformation)!;
      expect(
        info.getCharacteristic(hap.Characteristic.SerialNumber).value,
      ).toBe(DHW_ID);
    });

    it("reuses the services of a cached accessory", () => {
      build();
      const first = sensor();

      build();

      // A second accessory would leave HomeKit with a duplicate that never
      // updates.
      expect(sensor()).toBe(first);
      expect(
        accessory.services.filter((s) => s.UUID === first.UUID),
      ).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("passes temperature and state on to HomeKit", () => {
      const dhw = build();

      dhw.update(
        status({ temperatureStatus: { temperature: 51, isAvailable: true } }),
      );

      expect(
        sensor().getCharacteristic(hap.Characteristic.CurrentTemperature).value,
      ).toBe(51);
      expect(toggle().getCharacteristic(hap.Characteristic.On).value).toBe(
        true,
      );
      expect(dhw.lastStatus?.state).toBe("On");
    });

    it("keeps the last temperature when the sensor reports none", () => {
      const dhw = build();
      dhw.update(status());

      dhw.update(
        status({
          temperatureStatus: { temperature: undefined, isAvailable: false },
        }),
      );

      // Better a slightly stale reading than 0 °C in the Home app.
      expect(
        sensor().getCharacteristic(hap.Characteristic.CurrentTemperature).value,
      ).toBe(48.5);
    });

    it("reports a low battery without raising a fault", () => {
      const dhw = build();

      dhw.update(status({ activeFaults: ["DHWSensorLowBattery"] }));

      // A CS92A with a weak battery still measures; only StatusLowBattery
      // should react.
      expect(
        battery().getCharacteristic(hap.Characteristic.StatusLowBattery).value,
      ).toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
      expect(
        sensor().getCharacteristic(hap.Characteristic.StatusFault).value,
      ).toBe(hap.Characteristic.StatusFault.NO_FAULT);
      expect(
        battery().getCharacteristic(hap.Characteristic.BatteryLevel).value,
      ).toBeLessThan(20);
    });

    it("publishes a battery level and a charging state at all", () => {
      const dhw = build();

      dhw.update(status({ activeFaults: [] }));

      // Without these two, a client renders the battery as "0 %, Charged"
      // (#205) — the cylinder sensor runs on cells that cannot be charged.
      expect(
        battery().getCharacteristic(hap.Characteristic.BatteryLevel).value,
      ).toBe(100);
      expect(
        battery().getCharacteristic(hap.Characteristic.ChargingState).value,
      ).toBe(hap.Characteristic.ChargingState.NOT_CHARGEABLE);
    });

    it("raises a fault for anything that is not a battery", () => {
      const dhw = build();

      dhw.update(status({ activeFaults: ["DHWSensorFailure"] }));

      expect(
        sensor().getCharacteristic(hap.Characteristic.StatusFault).value,
      ).toBe(hap.Characteristic.StatusFault.GENERAL_FAULT);
      expect(
        battery().getCharacteristic(hap.Characteristic.StatusLowBattery).value,
      ).toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    });

    it("clears a fault again once it is gone", () => {
      const dhw = build();
      dhw.update(status({ activeFaults: ["DHWSensorFailure"] }));

      dhw.update(status({ activeFaults: [] }));

      expect(
        sensor().getCharacteristic(hap.Characteristic.StatusFault).value,
      ).toBe(hap.Characteristic.StatusFault.NO_FAULT);
      expect(log.infos.join()).toContain("no active faults");
    });

    it("logs a fault once, not on every poll", () => {
      const dhw = build();

      dhw.update(status({ activeFaults: ["DHWSensorFailure"] }));
      dhw.update(status({ activeFaults: ["DHWSensorFailure"] }));
      // The API gives no guarantee about the order, and a reordering is not a
      // change.
      dhw.update(status({ activeFaults: ["DHWSensorFailure"] }));

      expect(log.warnings).toHaveLength(1);
    });
  });

  describe("reads before the first poll", () => {
    it("answers with a communication failure rather than a made-up value", async () => {
      build();

      await expect(
        sensor()
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).rejects.toBeDefined();
      await expect(
        toggle().getCharacteristic(hap.Characteristic.On).handleGetRequest(),
      ).rejects.toBeDefined();
    });

    it("reports no fault rather than an unknown one", async () => {
      build();

      await expect(
        sensor()
          .getCharacteristic(hap.Characteristic.StatusFault)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusFault.NO_FAULT);
      await expect(
        battery()
          .getCharacteristic(hap.Characteristic.StatusLowBattery)
          .handleGetRequest(),
      ).resolves.toBe(hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    });

    it("fails the temperature read when the sensor reports none", async () => {
      const dhw = build();
      dhw.update(
        status({
          temperatureStatus: { temperature: undefined, isAvailable: false },
        }),
      );

      await expect(
        sensor()
          .getCharacteristic(hap.Characteristic.CurrentTemperature)
          .handleGetRequest(),
      ).rejects.toBeDefined();
    });
  });

  describe("switching (issue #149)", () => {
    const setOn = async (value: boolean): Promise<void> => {
      await toggle()
        .getCharacteristic(hap.Characteristic.On)
        .handleSetRequest(value);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-07T07:30:00Z")); // a Monday
    });

    it("keeps the end time of a running override", async () => {
      const until = new Date("2026-09-07T20:30:00Z");
      const dhw = build();
      dhw.update(status({ mode: "TemporaryOverride", until, state: "On" }));

      await setOn(false);

      // The bug from 0.11.2: it overwrote 20:30 with the next switchpoint.
      expect(setDhwState).toHaveBeenCalledWith(
        DHW_ID,
        "TemporaryOverride",
        "Off",
        until,
      );
      // The schedule is not needed for this decision, and fetching it would put
      // a request on the write path — what ScheduleCache exists to avoid.
      expect(dhwSchedule).not.toHaveBeenCalled();
    });

    it("falls back to the next switchpoint without a running override", async () => {
      const dhw = build();
      dhw.update(status({ mode: "FollowSchedule" }));

      await setOn(false);

      expect(setDhwState).toHaveBeenCalledWith(
        DHW_ID,
        "TemporaryOverride",
        "Off",
        new Date("2026-09-07T09:00:00Z"),
      );
    });

    it("writes a permanent override when configured to", async () => {
      const dhw = build(config({ setpointMode: "permanent" }));
      dhw.update(status());

      await setOn(true);

      expect(setDhwState).toHaveBeenCalledWith(
        DHW_ID,
        "PermanentOverride",
        "On",
        undefined,
      );
      // No schedule is needed for a permanent override.
      expect(dhwSchedule).not.toHaveBeenCalled();
    });

    it("goes permanent when the schedule holds no later switchpoint", async () => {
      vi.setSystemTime(new Date("2026-09-07T23:30:00Z"));
      dhwSchedule.mockResolvedValue([]);
      const dhw = build();
      dhw.update(status({ mode: "FollowSchedule" }));

      await setOn(true);

      // 0.11.2 wrote "00:00:00" here, so the setpoint expired immediately.
      expect(setDhwState).toHaveBeenCalledWith(
        DHW_ID,
        "PermanentOverride",
        "On",
        undefined,
      );
    });

    it("asks for a fresh poll so HomeKit does not keep the old state", async () => {
      const dhw = build();
      dhw.update(status());

      await setOn(false);

      expect(scheduleRefresh).toHaveBeenCalled();
    });

    it("answers immediately instead of timing out (issue #180)", async () => {
      const dhw = build();
      dhw.update(status());

      // 0.11.2 called its callback only on failure, so a successful switch ran
      // into HomeKit's ~15s timeout and showed "Error Action Set Failed".
      await expect(setOn(true)).resolves.toBeUndefined();
    });
  });
});
