import { describe, expect, it } from "vitest";

import { clampSetpoint } from "../../src/accessories/thermostat.js";

import type { SetpointCapabilities } from "../../src/api/types.js";

/** The "Bad" zone from the fixtures: minimum 10 °C, the case from issue #94. */
const bathroom: SetpointCapabilities = {
  minHeatSetpoint: 10,
  maxHeatSetpoint: 35,
  valueResolution: 0.5,
};

const livingRoom: SetpointCapabilities = {
  minHeatSetpoint: 5,
  maxHeatSetpoint: 35,
  valueResolution: 0.5,
};

describe("clampSetpoint", () => {
  it("leaves values inside the allowed range untouched", () => {
    expect(clampSetpoint(21, bathroom)).toBe(21);
    expect(clampSetpoint(20.5, bathroom)).toBe(20.5);
  });

  it("raises values below the minimum (#94)", () => {
    // 0.11.2 wrote a flat 5 °C to turn a zone off. For this zone HomeKit then
    // reported: "characteristic was supplied illegal value: number 5 exceeded
    // minimum of 10".
    expect(clampSetpoint(5, bathroom)).toBe(10);
    expect(clampSetpoint(-40, bathroom)).toBe(10);
  });

  it("lowers values above the maximum", () => {
    expect(clampSetpoint(40, bathroom)).toBe(35);
  });

  it("snaps to the device step size", () => {
    expect(clampSetpoint(20.3, bathroom)).toBe(20.5);
    expect(clampSetpoint(20.2, bathroom)).toBe(20);
  });

  it("produces no floating point residue", () => {
    // 20.5 from a division can come out as 20.500000000000004, which HomeKit
    // rejects against minStep 0.5.
    const value = clampSetpoint(20.4999999, bathroom);
    expect(value).toBe(20.5);
    expect(String(value)).toBe("20.5");
  });

  it("stays within the bounds after rounding", () => {
    // Rounding to the step size must not overshoot the maximum.
    const odd: SetpointCapabilities = {
      minHeatSetpoint: 5,
      maxHeatSetpoint: 34.8,
      valueResolution: 0.5,
    };
    expect(clampSetpoint(34.8, odd)).toBeLessThanOrEqual(34.8);
    expect(clampSetpoint(100, odd)).toBeLessThanOrEqual(34.8);
  });

  it("copes with a step size of 0", () => {
    const broken: SetpointCapabilities = {
      minHeatSetpoint: 5,
      maxHeatSetpoint: 35,
      valueResolution: 0,
    };
    expect(clampSetpoint(21.37, broken)).toBe(21.37);
  });

  it("treats zones with different minima separately", () => {
    // This is where the bug was: 0.11.2 assumed the same 5 °C for every zone.
    expect(clampSetpoint(5, livingRoom)).toBe(5);
    expect(clampSetpoint(5, bathroom)).toBe(10);
  });
});
