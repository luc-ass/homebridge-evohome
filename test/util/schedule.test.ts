import { describe, expect, it } from "vitest";

import { parseSchedule } from "../../src/api/parse.js";
import { nextSwitchpoint, parseTimeOfDay } from "../../src/util/schedule.js";
import { fixture } from "../helpers.js";

import type { DailySchedule } from "../../src/api/types.js";

const zoneSchedule = parseSchedule(fixture("scheduleZone.json"));
const dhwSchedule = parseSchedule(fixture("scheduleDhw.json"));

/** Central European summer time: UTC+2. */
const CEST = 120;
/** Central European winter time: UTC+1. */
const CET = 60;

describe("parseTimeOfDay", () => {
  it("reads HH:MM:SS", () => {
    expect(parseTimeOfDay("06:30:00")).toBe(6 * 3600 + 30 * 60);
    expect(parseTimeOfDay("00:00:00")).toBe(0);
    expect(parseTimeOfDay("23:59:59")).toBe(86399);
  });

  it("also reads HH:MM without seconds", () => {
    expect(parseTimeOfDay("17:00")).toBe(17 * 3600);
  });

  it("rejects nonsense instead of silently accepting it", () => {
    for (const bad of ["", "6:30 PM", "25:00:00", "12:60:00", "abc"]) {
      expect(parseTimeOfDay(bad)).toBeUndefined();
    }
  });
});

describe("nextSwitchpoint", () => {
  it("finds the next switchpoint on the current day", () => {
    // Monday 2026-08-03, 07:00 local time (05:00 UTC under CEST).
    const now = new Date("2026-08-03T05:00:00Z");
    const next = nextSwitchpoint(zoneSchedule, now, CEST);

    expect(next?.timeOfDay).toBe("08:30:00");
    expect(next?.heatSetpoint).toBe(17);
    expect(next?.at.toISOString()).toBe("2026-08-03T06:30:00.000Z");
  });

  it("moves to the next day when nothing is left today", () => {
    // Monday 23:00 local time, after the last switchpoint (22:30).
    // 0.11.2 returned "00:00:00" here instead of the first point on Tuesday.
    const now = new Date("2026-08-03T21:00:00Z");
    const next = nextSwitchpoint(zoneSchedule, now, CEST);

    expect(next?.timeOfDay).toBe("06:30:00");
    expect(next?.at.toISOString()).toBe("2026-08-04T04:30:00.000Z");
  });

  it("treats a time exactly on a switchpoint as already past", () => {
    // Exactly 06:30 local: the 06:30 point already applies, the next is 08:30.
    const now = new Date("2026-08-03T04:30:00Z");
    expect(nextSwitchpoint(zoneSchedule, now, CEST)?.timeOfDay).toBe(
      "08:30:00",
    );
  });

  it("crosses the Sunday to Monday boundary correctly", () => {
    // Sunday 2026-08-02, 23:30 local time.
    const now = new Date("2026-08-02T21:30:00Z");
    const next = nextSwitchpoint(zoneSchedule, now, CEST);

    expect(next?.timeOfDay).toBe("06:30:00");
    expect(next?.at.toISOString()).toBe("2026-08-03T04:30:00.000Z");
  });

  it("uses the location offset, not the system offset", () => {
    // The same instant read once as CET and once as CEST gives a different local
    // time, and therefore a different next switchpoint. This mix-up is what the
    // time zone warning in the old README was about.
    const now = new Date("2026-08-03T05:45:00Z"); // 07:45 CEST / 06:45 CET
    expect(nextSwitchpoint(zoneSchedule, now, CEST)?.timeOfDay).toBe(
      "08:30:00",
    );
    expect(nextSwitchpoint(zoneSchedule, now, CET)?.timeOfDay).toBe("08:30:00");

    const earlier = new Date("2026-08-03T04:15:00Z"); // 06:15 CEST / 05:15 CET
    expect(nextSwitchpoint(zoneSchedule, earlier, CEST)?.timeOfDay).toBe(
      "06:30:00",
    );
    expect(nextSwitchpoint(zoneSchedule, earlier, CET)?.at.toISOString()).toBe(
      "2026-08-03T05:30:00.000Z",
    );
  });

  it("is independent of the order of days in the response", () => {
    // 0.11.2 did not reset its loop variable between days, so the result
    // depended on the ordering.
    const reversed = [...zoneSchedule].reverse();
    const now = new Date("2026-08-03T05:00:00Z");

    expect(nextSwitchpoint(reversed, now, CEST)).toEqual(
      nextSwitchpoint(zoneSchedule, now, CEST),
    );
  });

  it("sorts unsorted switchpoints within a day", () => {
    const scrambled: DailySchedule[] = [
      {
        dayOfWeek: "Monday",
        switchpoints: [
          { timeOfDay: "22:30:00", heatSetpoint: 16, dhwState: undefined },
          { timeOfDay: "06:30:00", heatSetpoint: 20.5, dhwState: undefined },
          { timeOfDay: "17:00:00", heatSetpoint: 21, dhwState: undefined },
        ],
      },
    ];
    const now = new Date("2026-08-03T05:00:00Z"); // 07:00 local time
    expect(nextSwitchpoint(scrambled, now, CEST)?.timeOfDay).toBe("17:00:00");
  });

  it("finds the next occurrence even if only one weekday is populated", () => {
    const onlySaturday: DailySchedule[] = [
      {
        dayOfWeek: "Saturday",
        switchpoints: [
          { timeOfDay: "08:00:00", heatSetpoint: 21, dhwState: undefined },
        ],
      },
    ];
    // Monday: the hit is five days ahead.
    const now = new Date("2026-08-03T05:00:00Z");
    expect(nextSwitchpoint(onlySaturday, now, CEST)?.at.toISOString()).toBe(
      "2026-08-08T06:00:00.000Z",
    );
  });

  it("returns undefined when the schedule is empty", () => {
    expect(nextSwitchpoint([], new Date(), CEST)).toBeUndefined();
  });

  it("skips switchpoints with an unparsable time", () => {
    const broken: DailySchedule[] = [
      {
        dayOfWeek: "Monday",
        switchpoints: [
          { timeOfDay: "kaputt", heatSetpoint: 20, dhwState: undefined },
          { timeOfDay: "17:00:00", heatSetpoint: 21, dhwState: undefined },
        ],
      },
    ];
    const now = new Date("2026-08-03T05:00:00Z");
    expect(nextSwitchpoint(broken, now, CEST)?.timeOfDay).toBe("17:00:00");
  });

  it("works the same way for hot water schedules", () => {
    const now = new Date("2026-08-03T05:00:00Z"); // Monday 07:00 local time
    const next = nextSwitchpoint(dhwSchedule, now, CEST);

    expect(next?.dhwState).toBe("Off");
    expect(next?.heatSetpoint).toBeUndefined();
    expect(next?.at.toISOString()).toBe("2026-08-03T07:00:00.000Z");
  });

  describe("daylight saving change", () => {
    // Europe switches from CEST to CET during the night of 2026-10-25. The API
    // only reports Windows time zone IDs, which Intl cannot work with, so the
    // reported fixed offset is used. These tests pin the documented behaviour.
    it("uses the summer time offset before the change", () => {
      const now = new Date("2026-10-24T05:00:00Z"); // Saturday 07:00 CEST
      expect(nextSwitchpoint(zoneSchedule, now, CEST)?.at.toISOString()).toBe(
        "2026-10-24T06:00:00.000Z",
      );
    });

    it("uses the winter time offset after the change", () => {
      const now = new Date("2026-10-25T06:00:00Z"); // Sunday 07:00 CET
      expect(nextSwitchpoint(zoneSchedule, now, CET)?.at.toISOString()).toBe(
        "2026-10-25T07:00:00.000Z",
      );
    });
  });
});
