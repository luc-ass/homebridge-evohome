/**
 * Domain types for the TCC EMEA API.
 *
 * The API is undocumented; the fields come from the old implementation
 * (`legacy/evohome.cjs`) and from real responses. Anything the plugin does not
 * use is deliberately left out: the smaller the surface, the less breaks when
 * Resideo changes something.
 */

/** Operating mode of a temperature control system. */
export const SYSTEM_MODES = [
  "Auto",
  "AutoWithEco",
  "AutoWithReset",
  "Away",
  "DayOff",
  "HeatingOff",
  "Custom",
] as const;

export type SystemMode = (typeof SYSTEM_MODES)[number];

/** Kind of setpoint, as reported and accepted by the API. */
export const SETPOINT_MODES = [
  "FollowSchedule",
  "TemporaryOverride",
  "PermanentOverride",
] as const;

export type SetpointMode = (typeof SETPOINT_MODES)[number];

/** State of the domestic hot water. */
export const DHW_STATES = ["On", "Off"] as const;

export type DhwState = (typeof DHW_STATES)[number];

/**
 * Device types that appear as a heating zone.
 *
 * 0.11.2 filtered on exactly these three values. Unknown types are still skipped,
 * but they are logged instead of silently disappearing.
 */
export const HEATING_ZONE_MODELS = [
  "HeatingZone",
  "RoundWireless",
  "RoundModulation",
  "Unknown",
] as const;

export type ZoneModel = (typeof HEATING_ZONE_MODELS)[number];

export interface UserAccount {
  readonly userId: string;
  readonly username: string;
}

export interface TimeZoneInfo {
  /** Windows time zone ID, e.g. "W. Europe Standard Time" — not an IANA name. */
  readonly timeZoneId: string;
  readonly displayName: string;
  /** Base offset in minutes, excluding daylight saving. */
  readonly offsetMinutes: number;
  /** Currently effective offset in minutes, including daylight saving. */
  readonly currentOffsetMinutes: number;
  readonly supportsDaylightSaving: boolean;
}

/** Bounds and step of a setpoint, from `setpointCapabilities`. */
export interface SetpointCapabilities {
  readonly minHeatSetpoint: number;
  readonly maxHeatSetpoint: number;
  readonly valueResolution: number;
}

/** A heating zone as described in the installation info. */
export interface Zone {
  readonly zoneId: string;
  readonly name: string;
  readonly zoneType: string;
  readonly modelType: ZoneModel;
  readonly setpointCapabilities: SetpointCapabilities;
}

/** Domestic hot water, if the system has any. */
export interface DomesticHotWater {
  readonly dhwId: string;
}

/** A temperature control system — the Evohome controller of a location. */
export interface TemperatureControlSystem {
  readonly systemId: string;
  readonly modelType: string;
  readonly zones: readonly Zone[];
  readonly dhw: DomesticHotWater | undefined;
  /** Modes this system supports, from `allowedSystemModes`. */
  readonly allowedSystemModes: readonly SystemMode[];
}

/** A location — usually one household. */
export interface Location {
  readonly locationId: string;
  readonly name: string;
  readonly timeZone: TimeZoneInfo;
  /**
   * The controller the plugin works with:
   * `gateways[0].temperatureControlSystems[0]`, as in 0.11.2.
   */
  readonly system: TemperatureControlSystem;
  /**
   * How many gateways and controllers the location reports in total.
   *
   * Only the counts, not the contents: anything beyond the first controller of
   * the first gateway is not read. They exist so such a system is named in the
   * log instead of silently losing its zones (issue #205).
   */
  readonly gatewayCount: number;
  readonly systemCount: number;
}

/** A zone's reading. Not every zone always provides one. */
export interface TemperatureStatus {
  readonly isAvailable: boolean;
  /** Absent when `isAvailable` is false, e.g. on an empty battery. */
  readonly temperature: number | undefined;
}

export interface SetpointStatus {
  readonly targetHeatTemperature: number;
  readonly setpointMode: SetpointMode;
  /** End of a `TemporaryOverride`, otherwise undefined. */
  readonly until: Date | undefined;
}

/** Live status of a zone. */
export interface ZoneStatus {
  readonly zoneId: string;
  readonly name: string;
  readonly temperatureStatus: TemperatureStatus;
  readonly setpointStatus: SetpointStatus;
  /** Active faults, e.g. `TempZoneActuatorCommunicationLost`. */
  readonly activeFaults: readonly string[];
}

export interface DhwStatus {
  readonly dhwId: string;
  readonly temperatureStatus: TemperatureStatus;
  readonly state: DhwState;
  readonly mode: SetpointMode;
  readonly until: Date | undefined;
  /** Active faults, e.g. `DHWSensorLowBattery`. */
  readonly activeFaults: readonly string[];
}

export interface SystemModeStatus {
  readonly mode: SystemMode;
  readonly isPermanent: boolean;
  readonly until: Date | undefined;
}

/** Live status of a whole location — one request, every value. */
export interface LocationStatus {
  readonly locationId: string;
  readonly systemId: string;
  readonly systemModeStatus: SystemModeStatus;
  readonly zones: readonly ZoneStatus[];
  readonly dhw: DhwStatus | undefined;
}

/** A switchpoint in the schedule. */
export interface Switchpoint {
  /** Local time at the location, formatted `HH:MM:SS`. */
  readonly timeOfDay: string;
  /** Set for heating zones. */
  readonly heatSetpoint: number | undefined;
  /** Set for domestic hot water. */
  readonly dhwState: DhwState | undefined;
}

export interface DailySchedule {
  /** Weekday name as returned by the API: `Monday` … `Sunday`. */
  readonly dayOfWeek: string;
  readonly switchpoints: readonly Switchpoint[];
}

/** Credentials of a session. */
export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute expiry, derived from `expires_in`. */
  readonly expiresAt: number;
}
