import { describe, expect, it } from "vitest";

import {
  batteryLevel,
  faultKey,
  isLowBattery,
  summarizeFaults,
} from "../../src/util/faults.js";

describe("isLowBattery", () => {
  it("recognises the fault types the API actually sends", () => {
    expect(isLowBattery("TempZoneActuatorLowBattery")).toBe(true);
    expect(isLowBattery("TempZoneSensorLowBattery")).toBe(true);
    expect(isLowBattery("DHWSensorLowBattery")).toBe(true);
  });

  it("recognises an unknown low-battery type as well", () => {
    // The point of matching by substring: a fault type nobody has seen yet
    // still ends up in the right category.
    expect(isLowBattery("SomeNewThingLowBatteryWarning")).toBe(true);
  });

  it("does not mistake other faults for a battery", () => {
    expect(isLowBattery("TempZoneActuatorCommunicationLost")).toBe(false);
    expect(isLowBattery("BoilerCommunicationLost")).toBe(false);
  });
});

describe("summarizeFaults", () => {
  it("reports nothing without faults", () => {
    expect(summarizeFaults([])).toEqual({ fault: false, lowBattery: false });
  });

  it("keeps a low battery out of StatusFault", () => {
    // A valve with a weak battery still reports and still heats; declaring the
    // zone faulty would be wrong.
    expect(summarizeFaults(["TempZoneActuatorLowBattery"])).toEqual({
      fault: false,
      lowBattery: true,
    });
  });

  it("treats a lost connection as a fault", () => {
    expect(summarizeFaults(["TempZoneActuatorCommunicationLost"])).toEqual({
      fault: true,
      lowBattery: false,
    });
  });

  it("reports both when both are present", () => {
    expect(
      summarizeFaults([
        "TempZoneSensorLowBattery",
        "TempZoneActuatorCommunicationLost",
      ]),
    ).toEqual({ fault: true, lowBattery: true });
  });
});

describe("faultKey", () => {
  it("ignores the order", () => {
    // The API gives no guarantee about it, and a reordered list is not a change
    // worth a second warning in the log.
    expect(faultKey(["a", "b"])).toBe(faultKey(["b", "a"]));
  });

  it("distinguishes different sets", () => {
    expect(faultKey(["a"])).not.toBe(faultKey(["a", "b"]));
    expect(faultKey([])).not.toBe(faultKey(["a"]));
  });
});

describe("batteryLevel", () => {
  it("stays below the threshold clients warn at", () => {
    // The API never gives a percentage. What matters is that the low value is
    // low enough for a client to show it as low, not the number itself.
    expect(batteryLevel(true)).toBeLessThan(20);
  });

  it("reports a full battery when nothing is wrong", () => {
    // Not zero: beta.1 published no BatteryLevel at all and clients rendered
    // the missing value as "0 %", which looked like a dead battery (#205).
    expect(batteryLevel(false)).toBe(100);
  });
});
