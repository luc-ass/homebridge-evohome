import { describe, expect, it } from "vitest";

import { clampSetpoint } from "../../src/accessories/thermostat.js";

import type { SetpointCapabilities } from "../../src/api/types.js";

/** Zone „Bad" aus den Fixtures: Minimum 10 °C — der Fall aus Issue #94. */
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
  it("lässt Werte im erlaubten Bereich unverändert", () => {
    expect(clampSetpoint(21, bathroom)).toBe(21);
    expect(clampSetpoint(20.5, bathroom)).toBe(20.5);
  });

  it("hebt Werte unterhalb des Minimums an (#94)", () => {
    // 0.11.2 schrieb zum Ausschalten pauschal 5 °C. Bei dieser Zone meldete
    // HomeKit daraufhin: "characteristic was supplied illegal value: number 5
    // exceeded minimum of 10".
    expect(clampSetpoint(5, bathroom)).toBe(10);
    expect(clampSetpoint(-40, bathroom)).toBe(10);
  });

  it("senkt Werte oberhalb des Maximums ab", () => {
    expect(clampSetpoint(40, bathroom)).toBe(35);
  });

  it("rastet auf die Schrittweite des Geräts ein", () => {
    expect(clampSetpoint(20.3, bathroom)).toBe(20.5);
    expect(clampSetpoint(20.2, bathroom)).toBe(20);
  });

  it("erzeugt keine Gleitkommareste", () => {
    // 20.5 aus einer Division kann als 20.500000000000004 herauskommen —
    // HomeKit lehnt das gegen minStep 0.5 ab.
    const value = clampSetpoint(20.4999999, bathroom);
    expect(value).toBe(20.5);
    expect(String(value)).toBe("20.5");
  });

  it("bleibt nach dem Runden innerhalb der Grenzen", () => {
    // Runden auf die Schrittweite darf nicht über das Maximum schießen.
    const odd: SetpointCapabilities = {
      minHeatSetpoint: 5,
      maxHeatSetpoint: 34.8,
      valueResolution: 0.5,
    };
    expect(clampSetpoint(34.8, odd)).toBeLessThanOrEqual(34.8);
    expect(clampSetpoint(100, odd)).toBeLessThanOrEqual(34.8);
  });

  it("kommt mit einer Schrittweite von 0 zurecht", () => {
    const broken: SetpointCapabilities = {
      minHeatSetpoint: 5,
      maxHeatSetpoint: 35,
      valueResolution: 0,
    };
    expect(clampSetpoint(21.37, broken)).toBe(21.37);
  });

  it("behandelt Zonen mit unterschiedlichen Minima getrennt", () => {
    // Genau hier lag der Fehler: 0.11.2 nahm für alle Zonen dieselben 5 °C an.
    expect(clampSetpoint(5, livingRoom)).toBe(5);
    expect(clampSetpoint(5, bathroom)).toBe(10);
  });
});
