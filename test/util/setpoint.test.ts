import { describe, expect, it } from "vitest";

import {
  decideOverride,
  DEFAULT_SETPOINT_STRATEGY,
  needsSwitchpoint,
} from "../../src/util/setpoint.js";

import type { CurrentOverride } from "../../src/util/setpoint.js";

const NOW = new Date("2026-03-22T16:01:00Z");

/** The starting state from issue #149: 19 °C until 20:30. */
const runningOverride: CurrentOverride = {
  setpointMode: "TemporaryOverride",
  until: new Date("2026-03-22T20:30:00Z"),
};

const followingSchedule: CurrentOverride = {
  setpointMode: "FollowSchedule",
  until: undefined,
};

/** The same override, but its end time has already passed. */
const expiredOverride: CurrentOverride = {
  setpointMode: "TemporaryOverride",
  until: new Date("2026-03-22T12:00:00Z"),
};

/** Next switchpoint per the schedule: 18:00. */
const nextSwitchpointAt = new Date("2026-03-22T18:00:00Z");

describe("decideOverride", () => {
  it("uses keepExistingUntil as the default", () => {
    expect(DEFAULT_SETPOINT_STRATEGY).toBe("keepExistingUntil");
  });

  describe("keepExistingUntil", () => {
    it("keeps the end time of a running override (#149)", () => {
      // The reported case: raising the temperature turned "19 °C until 20:30" into
      // "20 °C until 18:00", dropping the heating two hours early.
      const decision = decideOverride(
        "keepExistingUntil",
        runningOverride,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(new Date("2026-03-22T20:30:00Z"));
      expect(decision.reason).toContain("end time of the running override");
    });

    it("uses the next switchpoint when no override is running", () => {
      // For anyone who never hit #149 the behaviour is identical to 0.11.2.
      const decision = decideOverride(
        "keepExistingUntil",
        followingSchedule,
        nextSwitchpointAt,
        NOW,
      );

      expect(decision.mode).toBe("TemporaryOverride");
      expect(decision.until).toEqual(nextSwitchpointAt);
      expect(decision.reason).toContain("next switchpoint");
    });

    it("ignores an override that has already expired", () => {
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

    it("ignores a permanent override", () => {
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

    it("ignores a TemporaryOverride without an end time", () => {
      // The API reports `until` only for some modes; without it the next
      // switchpoint is all that is left.
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
    it("overwrites the end time of a running override", () => {
      // The behaviour of 0.11.2, kept as an option.
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
    it("sets permanently, regardless of the schedule", () => {
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

  describe("without a usable schedule", () => {
    it("falls back to a permanent override", () => {
      // 0.11.2 substituted "00:00:00" here, so the setpoint lasted until midnight
      // or expired immediately across a day boundary.
      const decision = decideOverride(
        "untilNextSwitchpoint",
        followingSchedule,
        undefined,
        NOW,
      );

      expect(decision.mode).toBe("PermanentOverride");
      expect(decision.reason).toContain("no switchpoint found");
    });

    it("does not take a switchpoint in the past", () => {
      const decision = decideOverride(
        "untilNextSwitchpoint",
        followingSchedule,
        new Date("2026-03-22T09:00:00Z"),
        NOW,
      );

      expect(decision.mode).toBe("PermanentOverride");
    });

    it("still keeps a running end time", () => {
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

describe("needsSwitchpoint", () => {
  // The accessories ask this before fetching a schedule. Every answer of
  // `false` has to match a branch of decideOverride that ignores the
  // switchpoint, otherwise a decision silently loses its end time.

  it("never needs one for permanent", () => {
    expect(needsSwitchpoint("permanent", followingSchedule, NOW)).toBe(false);
    expect(needsSwitchpoint("permanent", runningOverride, NOW)).toBe(false);
  });

  it("does not need one while an override is running under keepExistingUntil", () => {
    expect(needsSwitchpoint("keepExistingUntil", runningOverride, NOW)).toBe(
      false,
    );
  });

  it("needs one once the running override has expired", () => {
    expect(needsSwitchpoint("keepExistingUntil", expiredOverride, NOW)).toBe(
      true,
    );
  });

  it("needs one when the zone is simply following its schedule", () => {
    expect(needsSwitchpoint("keepExistingUntil", followingSchedule, NOW)).toBe(
      true,
    );
  });

  it("always needs one for untilNextSwitchpoint", () => {
    expect(needsSwitchpoint("untilNextSwitchpoint", runningOverride, NOW)).toBe(
      true,
    );
    expect(
      needsSwitchpoint("untilNextSwitchpoint", followingSchedule, NOW),
    ).toBe(true);
  });

  it("agrees with decideOverride wherever it says no", () => {
    // The contract: if no switchpoint is needed, passing one changes nothing.
    for (const current of [
      runningOverride,
      followingSchedule,
      expiredOverride,
    ]) {
      for (const strategy of ["permanent", "keepExistingUntil"] as const) {
        if (needsSwitchpoint(strategy, current, NOW)) {
          continue;
        }
        expect(
          decideOverride(strategy, current, nextSwitchpointAt, NOW),
        ).toEqual(decideOverride(strategy, current, undefined, NOW));
      }
    }
  });
});
