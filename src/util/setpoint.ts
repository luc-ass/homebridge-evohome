import type { SetpointMode } from "../api/types.js";

/**
 * Decides how a setpoint from HomeKit is written to Evohome.
 *
 * The background is issue #149: 0.11.2 **always** wrote a `TemporaryOverride`
 * lasting until the next switchpoint, thereby overwriting the end time of an
 * override that was already running. Someone who had set "19 °C until 20:30"
 * and raised it to 20 °C at 16:01 ended up with "20 °C until 18:00".
 *
 * The API has no "change the value, keep the end time" mode:
 * `PUT /temperatureZone/{id}/heatSetpoint` requires one of the three
 * `SetpointMode` values. The running end time is reported in
 * `setpointStatus.until`, though, so it can simply be sent back.
 */

export const SETPOINT_STRATEGIES = [
  "keepExistingUntil",
  "untilNextSwitchpoint",
  "permanent",
] as const;

export type SetpointStrategy = (typeof SETPOINT_STRATEGIES)[number];

export const DEFAULT_SETPOINT_STRATEGY: SetpointStrategy = "keepExistingUntil";

/** The currently reported state of a zone or of the hot water. */
export interface CurrentOverride {
  readonly setpointMode: SetpointMode;
  readonly until: Date | undefined;
}

export interface OverrideDecision {
  readonly mode: SetpointMode;
  readonly until: Date | undefined;
  /** Short rationale for the log. */
  readonly reason: string;
}

/**
 * Picks the mode and end time for a new setpoint.
 *
 * @param strategy From the configuration.
 * @param current What the API currently reports.
 * @param nextSwitchpointAt Next switchpoint of the schedule, if it could be
 *   determined.
 * @param now Reference point in time.
 */
export const decideOverride = (
  strategy: SetpointStrategy,
  current: CurrentOverride,
  nextSwitchpointAt: Date | undefined,
  now: Date,
): OverrideDecision => {
  if (strategy === "permanent") {
    return { mode: "PermanentOverride", until: undefined, reason: "permanent" };
  }

  if (strategy === "keepExistingUntil" && isRunning(current, now)) {
    return {
      mode: "TemporaryOverride",
      until: current.until,
      reason: `until ${formatTime(current.until)} (end time of the running override)`,
    };
  }

  if (nextSwitchpointAt !== undefined && nextSwitchpointAt > now) {
    return {
      mode: "TemporaryOverride",
      until: nextSwitchpointAt,
      reason: `until ${formatTime(nextSwitchpointAt)} (next switchpoint)`,
    };
  }

  // Without a usable schedule the only option left is an override with no end
  // time. 0.11.2 substituted "00:00:00" here, which meant the setpoint lasted
  // until midnight, or expired immediately across a day boundary.
  return {
    mode: "PermanentOverride",
    until: undefined,
    reason: "permanent (no switchpoint found in the schedule)",
  };
};

/** Is a temporary override running whose end time is still ahead? */
const isRunning = (current: CurrentOverride, now: Date): boolean =>
  current.setpointMode === "TemporaryOverride" &&
  current.until !== undefined &&
  current.until > now;

const formatTime = (date: Date | undefined): string =>
  date === undefined ? "unknown" : date.toISOString().slice(11, 16) + " UTC";
