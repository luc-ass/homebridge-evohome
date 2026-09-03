import { describe, expect, it } from "vitest";

import {
  decideOverride,
  DEFAULT_SETPOINT_STRATEGY,
} from "../../src/util/setpoint.js";

import type { CurrentOverride } from "../../src/util/setpoint.js";

const NOW = new Date("2026-03-22T16:01:00Z");

/** Der Ausgangszustand aus Issue #149: 19 °C bis 20:30. */
const runningOverride: CurrentOverride = {
  setpointMode: "TemporaryOverride",
  until: new Date("2026-03-22T20:30:00Z"),
};

const followingSchedule: CurrentOverride = {
  setpointMode: "FollowSchedule",
  until: undefined,
};

/** Nächster Schaltpunkt laut Zeitprogramm: 18:00. */
const nextSwitchpointAt = new Date("2026-03-22T18:00:00Z");

describe("decideOverride", () => {
  it("verwendet keepExistingUntil als Voreinstellung", () => {
    expect(DEFAULT_SETPOINT_STRATEGY).toBe("keepExistingUntil");
  });

  describe("keepExistingUntil", () => {
    it("behält die Endzeit eines laufenden Overrides (#149)", () => {
      // Der gemeldete Fall: 0.11.2 machte aus „19 °C bis 20:30" beim Erhöhen
      // „20 °C bis 18:00" und ließ die Heizung zwei Stunden zu früh abfallen.
      const decision = decideOverride(
        "keepExistingUntil",
        runningOverride,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(new Date("2026-03-22T20:30:00Z"));
      expect(decision.reason).toContain("laufenden Overrides");
    });

    it("nimmt den nächsten Schaltpunkt, wenn kein Override läuft", () => {
      // Für alle, die #149 nie erlebt haben, bleibt das Verhalten identisch
      // zu 0.11.2.
      const decision = decideOverride(
        "keepExistingUntil",
        followingSchedule,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(nextSwitchpointAt);
      expect(decision.reason).toContain("nächster Schaltpunkt");
    });

    it("ignoriert einen bereits abgelaufenen Override", () => {
      const expired: CurrentOverride = {
        setpointMode: "TemporaryOverride",
        until: new Date("2026-03-22T15:00:00Z"),
      };
      const decision = decideOverride(
        "keepExistingUntil",
        expired,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.until).toEqual(nextSwitchpointAt);
    });

    it("ignoriert einen dauerhaften Override", () => {
      const permanent: CurrentOverride = {
        setpointMode: "PermanentOverride",
        until: undefined,
      };
      const decision = decideOverride(
        "keepExistingUntil",
        permanent,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(nextSwitchpointAt);
    });

    it("ignoriert einen TemporaryOverride ohne Endzeit", () => {
      // Die API liefert `until` nur bei manchen Modi — fehlt es, bleibt nur
      // der nächste Schaltpunkt.
      const decision = decideOverride(
        "keepExistingUntil",
        { setpointMode: "TemporaryOverride", until: undefined },
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.until).toEqual(nextSwitchpointAt);
    });
  });

  describe("untilNextSwitchpoint", () => {
    it("überschreibt die Endzeit eines laufenden Overrides", () => {
      // Das Verhalten von 0.11.2 — bleibt als Option erhalten.
      const decision = decideOverride(
        "untilNextSwitchpoint",
        runningOverride,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(nextSwitchpointAt);
    });
  });

  describe("permanent", () => {
    it("setzt dauerhaft, unabhängig vom Zeitprogramm", () => {
      const decision = decideOverride(
        "permanent",
        runningOverride,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("PermanentOverride");
      expect(decision.until).toBeUndefined();
    });
  });

  describe("ohne verwertbares Zeitprogramm", () => {
    it("weicht auf einen dauerhaften Override aus", () => {
      // 0.11.2 setzte hier ersatzweise "00:00:00" — der Sollwert galt dann
      // bis Mitternacht oder verfiel über den Tageswechsel sofort.
      const decision = decideOverride(
        "untilNextSwitchpoint",
        followingSchedule,
        undefined,
        NOW,
      );

      expect(decision.mode).toBe("PermanentOverride");
      expect(decision.reason).toContain("kein Schaltpunkt");
    });

    it("nimmt keinen Schaltpunkt in der Vergangenheit", () => {
      const decision = decideOverride(
        "untilNextSwitchpoint",
        followingSchedule,
        new Date("2026-03-22T09:00:00Z"),
        NOW,
      );

      expect(decision.mode).toBe("PermanentOverride");
    });

    it("behält auch dann eine laufende Endzeit bei", () => {
      const decision = decideOverride(
        "keepExistingUntil",
        runningOverride,
        undefined,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(runningOverride.until);
    });
  });
});
