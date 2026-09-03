import type { DailySchedule, Switchpoint } from "../api/types.js";

/**
 * Finds the next switchpoint in a schedule.
 *
 * Replaces `getNextScheduledTime()` from 0.11.2, which had three bugs:
 *
 * 1. The loop variable `proceed` was not reset between weekdays, so the result
 *    depended on the order of days in the response.
 * 2. Comparison used `toLocaleTimeString()`, i.e. a lexicographic comparison of
 *    a localised string whose format varies with the system language.
 * 3. With no later switchpoint today, the result fell back to `"00:00:00"`
 *    instead of looking for the first switchpoint of the next day.
 *
 * This version works in seconds since midnight, searches across day boundaries
 * when needed and returns an absolute point in time.
 *
 * **Time zones:** Evohome switchpoints apply in the location's local time.
 * `offsetMinutes` is its current UTC offset (`currentOffsetMinutes` from the
 * API). The conversion uses a fixed offset, so on the night of a daylight
 * saving change the result can be off by an hour. That is accepted knowingly:
 * the API only reports Windows time zone IDs (e.g. `"W. Europe Standard Time"`)
 * which `Intl` cannot work with.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A switchpoint together with the absolute time it next takes effect. */
export interface UpcomingSwitchpoint extends Switchpoint {
  /** Absolute point in time at which the switchpoint applies. */
  readonly at: Date;
}

/**
 * Converts `"HH:MM:SS"` into seconds since midnight.
 * Returns `undefined` if the format does not match.
 */
export const parseTimeOfDay = (timeOfDay: string): number | undefined => {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeOfDay);
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return undefined;
  }
  return hours * 3600 + minutes * 60 + seconds;
};

/** A day's switchpoints, sorted by time and without unparsable entries. */
const sortedSwitchpoints = (
  day: DailySchedule,
): { seconds: number; switchpoint: Switchpoint }[] =>
  day.switchpoints
    .map((switchpoint) => ({
      seconds: parseTimeOfDay(switchpoint.timeOfDay),
      switchpoint,
    }))
    .filter(
      (entry): entry is { seconds: number; switchpoint: Switchpoint } =>
        entry.seconds !== undefined,
    )
    .sort((a, b) => a.seconds - b.seconds);

/**
 * Finds the next switchpoint after `now`.
 *
 * @param schedules The weekly schedule as returned by the API.
 * @param now Reference point in time.
 * @param offsetMinutes UTC offset of the location, in minutes.
 * @returns The next switchpoint, or `undefined` if the schedule is empty or
 *   holds no usable entry.
 */
export const nextSwitchpoint = (
  schedules: readonly DailySchedule[],
  now: Date,
  offsetMinutes: number,
): UpcomingSwitchpoint | undefined => {
  const byDay = new Map(schedules.map((day) => [day.dayOfWeek, day]));

  // Convert to the location's wall-clock time: reading the shifted timestamp
  // through the UTC getters yields the local time there directly.
  const local = new Date(now.getTime() + offsetMinutes * MINUTE_MS);
  const secondsNow =
    local.getUTCHours() * 3600 +
    local.getUTCMinutes() * 60 +
    local.getUTCSeconds();
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );

  // Today plus the following seven days, which also covers a schedule where
  // only a single weekday has any switchpoints.
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const weekdayIndex = (local.getUTCDay() + dayOffset) % 7;
    const day = byDay.get(WEEKDAYS[weekdayIndex] ?? "");
    if (day === undefined) {
      continue;
    }

    const candidate = sortedSwitchpoints(day).find(
      (entry) => dayOffset > 0 || entry.seconds > secondsNow,
    );
    if (candidate === undefined) {
      continue;
    }

    const at = new Date(
      localMidnight +
        dayOffset * DAY_MS +
        candidate.seconds * 1000 -
        offsetMinutes * MINUTE_MS,
    );
    return { ...candidate.switchpoint, at };
  }

  return undefined;
};
