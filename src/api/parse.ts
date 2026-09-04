import {
  asArray,
  asBoolean,
  asEnum,
  asId,
  asNumber,
  asRecord,
  asString,
  first,
  optional,
} from "./validate.js";

import {
  DHW_STATES,
  HEATING_ZONE_MODELS,
  SETPOINT_MODES,
  SYSTEM_MODES,
  type DailySchedule,
  type DhwStatus,
  type Location,
  type LocationStatus,
  type SetpointCapabilities,
  type SetpointStatus,
  type Switchpoint,
  type SystemMode,
  type SystemModeStatus,
  type TemperatureControlSystem,
  type TemperatureStatus,
  type TimeZoneInfo,
  type Tokens,
  type UserAccount,
  type Zone,
  type ZoneModel,
  type ZoneStatus,
} from "./types.js";

/**
 * Translates raw API responses into the domain types from `types.ts`.
 *
 * Every access goes through the helpers in `validate.ts` so an incomplete
 * response yields a named `EvohomeResponseError` rather than a `TypeError`
 * somewhere further down.
 */

const asDate = (value: unknown, path: string): Date | undefined => {
  const text = optional(value, path, asString);
  if (text === undefined) {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const parseTokens = (raw: unknown, now: number): Tokens => {
  const json = asRecord(raw, "token");
  return {
    accessToken: asString(json["access_token"], "token.access_token"),
    refreshToken: asString(json["refresh_token"], "token.refresh_token"),
    expiresAt: now + asNumber(json["expires_in"], "token.expires_in") * 1000,
  };
};

export const parseUserAccount = (raw: unknown): UserAccount => {
  const json = asRecord(raw, "userAccount");
  return {
    userId: asId(json["userId"], "userAccount.userId"),
    username: asString(json["username"], "userAccount.username"),
  };
};

const parseTimeZone = (raw: unknown, path: string): TimeZoneInfo => {
  const json = asRecord(raw, path);
  return {
    timeZoneId: asString(json["timeZoneId"], `${path}.timeZoneId`),
    displayName: asString(json["displayName"], `${path}.displayName`),
    offsetMinutes: asNumber(json["offsetMinutes"], `${path}.offsetMinutes`),
    currentOffsetMinutes: asNumber(
      json["currentOffsetMinutes"],
      `${path}.currentOffsetMinutes`,
    ),
    supportsDaylightSaving: asBoolean(
      json["supportsDaylightSaving"],
      `${path}.supportsDaylightSaving`,
    ),
  };
};

const parseSetpointCapabilities = (
  raw: unknown,
  path: string,
): SetpointCapabilities => {
  const json = asRecord(raw, path);
  return {
    minHeatSetpoint: asNumber(
      json["minHeatSetpoint"],
      `${path}.minHeatSetpoint`,
    ),
    maxHeatSetpoint: asNumber(
      json["maxHeatSetpoint"],
      `${path}.maxHeatSetpoint`,
    ),
    valueResolution: asNumber(
      json["valueResolution"],
      `${path}.valueResolution`,
    ),
  };
};

/**
 * Unknown `modelType` values become `Unknown` rather than an error.
 *
 * A new valve model at Resideo must not take down the whole plugin; the zone is
 * skipped later and logged while doing so.
 */
const parseZoneModel = (raw: unknown, path: string): ZoneModel => {
  const text = asString(raw, path);
  return (HEATING_ZONE_MODELS as readonly string[]).includes(text)
    ? (text as ZoneModel)
    : "Unknown";
};

const parseZone = (raw: unknown, path: string): Zone => {
  const json = asRecord(raw, path);
  return {
    zoneId: asId(json["zoneId"], `${path}.zoneId`),
    name: asString(json["name"], `${path}.name`),
    zoneType: asString(json["zoneType"], `${path}.zoneType`),
    modelType: parseZoneModel(json["modelType"], `${path}.modelType`),
    setpointCapabilities: parseSetpointCapabilities(
      json["setpointCapabilities"],
      `${path}.setpointCapabilities`,
    ),
  };
};

/**
 * `allowedSystemModes` is a list of objects, not of strings. Unknown modes are
 * dropped rather than treated as an error.
 */
const parseAllowedSystemModes = (
  raw: unknown,
  path: string,
): readonly SystemMode[] => {
  const entries = asArray(raw, path);
  const modes: SystemMode[] = [];
  entries.forEach((entry, index) => {
    const mode = asString(
      asRecord(entry, `${path}[${String(index)}]`)["systemMode"],
      `${path}[${String(index)}].systemMode`,
    );
    if ((SYSTEM_MODES as readonly string[]).includes(mode)) {
      modes.push(mode as SystemMode);
    }
  });
  return modes;
};

const parseSystem = (raw: unknown, path: string): TemperatureControlSystem => {
  const json = asRecord(raw, path);
  const dhwRaw = json["dhw"];
  return {
    systemId: asId(json["systemId"], `${path}.systemId`),
    modelType: asString(json["modelType"], `${path}.modelType`),
    zones: asArray(json["zones"], `${path}.zones`).map((zone, index) =>
      parseZone(zone, `${path}.zones[${String(index)}]`),
    ),
    dhw:
      dhwRaw === undefined || dhwRaw === null
        ? undefined
        : {
            dhwId: asId(
              asRecord(dhwRaw, `${path}.dhw`)["dhwId"],
              `${path}.dhw.dhwId`,
            ),
          },
    allowedSystemModes: parseAllowedSystemModes(
      json["allowedSystemModes"],
      `${path}.allowedSystemModes`,
    ),
  };
};

/** Reads `gateways[0].temperatureControlSystems[0]` with useful errors. */
const firstSystem = (json: Record<string, unknown>, path: string): unknown => {
  const gateway = asRecord(
    first(json["gateways"], `${path}.gateways`),
    `${path}.gateways[0]`,
  );
  return first(
    gateway["temperatureControlSystems"],
    `${path}.gateways[0].temperatureControlSystems`,
  );
};

/**
 * Counts the gateways of a location and the controllers on them.
 *
 * Lenient on purpose: only the first gateway is actually read, so a malformed
 * second one must not stop the plugin — it simply adds nothing to the count.
 */
const countSystems = (
  json: Record<string, unknown>,
  path: string,
): { readonly gateways: number; readonly systems: number } => {
  const gateways = asArray(json["gateways"], `${path}.gateways`);
  const systems = gateways.reduce<number>((total, gateway) => {
    const list =
      typeof gateway === "object" && gateway !== null
        ? (gateway as Record<string, unknown>)["temperatureControlSystems"]
        : undefined;
    return total + (Array.isArray(list) ? list.length : 0);
  }, 0);
  return { gateways: gateways.length, systems };
};

export const parseInstallationInfo = (raw: unknown): readonly Location[] => {
  const locations = asArray(raw, "installationInfo");
  return locations.map((entry, index) => {
    const path = `installationInfo[${String(index)}]`;
    const json = asRecord(entry, path);
    const info = asRecord(json["locationInfo"], `${path}.locationInfo`);
    const counts = countSystems(json, path);
    return {
      locationId: asId(info["locationId"], `${path}.locationInfo.locationId`),
      name: asString(info["name"], `${path}.locationInfo.name`),
      timeZone: parseTimeZone(
        info["timeZone"],
        `${path}.locationInfo.timeZone`,
      ),
      system: parseSystem(
        firstSystem(json, path),
        `${path}.gateways[0].temperatureControlSystems[0]`,
      ),
      gatewayCount: counts.gateways,
      systemCount: counts.systems,
    } satisfies Location;
  });
};

const parseTemperatureStatus = (
  raw: unknown,
  path: string,
): TemperatureStatus => {
  const json = asRecord(raw, path);
  const isAvailable = asBoolean(json["isAvailable"], `${path}.isAvailable`);
  // Unavailable zones either omit `temperature` or report something unusable.
  // 0.11.2 passed the value straight to HomeKit, hence the
  // "characteristic value expected valid finite number" from issue #94.
  const temperature = isAvailable
    ? optional(json["temperature"], `${path}.temperature`, asNumber)
    : undefined;
  return { isAvailable, temperature };
};

const parseSetpointStatus = (raw: unknown, path: string): SetpointStatus => {
  const json = asRecord(raw, path);
  return {
    targetHeatTemperature: asNumber(
      json["targetHeatTemperature"],
      `${path}.targetHeatTemperature`,
    ),
    setpointMode: asEnum(
      json["setpointMode"],
      `${path}.setpointMode`,
      SETPOINT_MODES,
    ),
    until: asDate(json["until"], `${path}.until`),
  };
};

/** `activeFaults` is a list of objects with `faultType` and `since`. */
const parseActiveFaults = (raw: unknown, path: string): readonly string[] => {
  const entries = optional(raw, path, asArray) ?? [];
  return entries.map((entry, index) =>
    asString(
      asRecord(entry, `${path}[${String(index)}]`)["faultType"],
      `${path}[${String(index)}].faultType`,
    ),
  );
};

const parseZoneStatus = (raw: unknown, path: string): ZoneStatus => {
  const json = asRecord(raw, path);
  return {
    zoneId: asId(json["zoneId"], `${path}.zoneId`),
    name: asString(json["name"], `${path}.name`),
    temperatureStatus: parseTemperatureStatus(
      json["temperatureStatus"],
      `${path}.temperatureStatus`,
    ),
    setpointStatus: parseSetpointStatus(
      json["setpointStatus"],
      `${path}.setpointStatus`,
    ),
    activeFaults: parseActiveFaults(
      json["activeFaults"],
      `${path}.activeFaults`,
    ),
  };
};

const parseDhwStatus = (raw: unknown, path: string): DhwStatus => {
  const json = asRecord(raw, path);
  const state = asRecord(json["stateStatus"], `${path}.stateStatus`);
  return {
    dhwId: asId(json["dhwId"], `${path}.dhwId`),
    temperatureStatus: parseTemperatureStatus(
      json["temperatureStatus"],
      `${path}.temperatureStatus`,
    ),
    state: asEnum(state["state"], `${path}.stateStatus.state`, DHW_STATES),
    mode: asEnum(state["mode"], `${path}.stateStatus.mode`, SETPOINT_MODES),
    until: asDate(state["until"], `${path}.stateStatus.until`),
    activeFaults: parseActiveFaults(
      json["activeFaults"],
      `${path}.activeFaults`,
    ),
  };
};

const parseSystemModeStatus = (
  raw: unknown,
  path: string,
): SystemModeStatus => {
  const json = asRecord(raw, path);
  return {
    mode: asEnum(json["mode"], `${path}.mode`, SYSTEM_MODES),
    isPermanent: asBoolean(json["isPermanent"], `${path}.isPermanent`),
    until: asDate(json["timeUntil"], `${path}.timeUntil`),
  };
};

/**
 * Reads the status of a whole location from a single response.
 *
 * 0.11.2 called the same endpoint twice, once for the zones and once for the
 * system mode. Here both come from one call.
 */
export const parseLocationStatus = (raw: unknown): LocationStatus => {
  const path = "locationStatus";
  const json = asRecord(raw, path);
  const system = asRecord(
    firstSystem(json, path),
    `${path}.gateways[0].temperatureControlSystems[0]`,
  );
  const systemPath = `${path}.gateways[0].temperatureControlSystems[0]`;
  const dhwRaw = system["dhw"];
  return {
    locationId: asId(json["locationId"], `${path}.locationId`),
    systemId: asId(system["systemId"], `${systemPath}.systemId`),
    systemModeStatus: parseSystemModeStatus(
      system["systemModeStatus"],
      `${systemPath}.systemModeStatus`,
    ),
    zones: asArray(system["zones"], `${systemPath}.zones`).map((zone, index) =>
      parseZoneStatus(zone, `${systemPath}.zones[${String(index)}]`),
    ),
    dhw:
      dhwRaw === undefined || dhwRaw === null
        ? undefined
        : parseDhwStatus(dhwRaw, `${systemPath}.dhw`),
  };
};

const parseSwitchpoint = (raw: unknown, path: string): Switchpoint => {
  const json = asRecord(raw, path);
  return {
    timeOfDay: asString(json["timeOfDay"], `${path}.timeOfDay`),
    heatSetpoint: optional(
      json["heatSetpoint"],
      `${path}.heatSetpoint`,
      asNumber,
    ),
    dhwState: optional(json["dhwState"], `${path}.dhwState`, (value, p) =>
      asEnum(value, p, DHW_STATES),
    ),
  };
};

export const parseSchedule = (raw: unknown): readonly DailySchedule[] => {
  const path = "schedule";
  const json = asRecord(raw, path);
  return asArray(json["dailySchedules"], `${path}.dailySchedules`).map(
    (day, index) => {
      const dayPath = `${path}.dailySchedules[${String(index)}]`;
      const dayJson = asRecord(day, dayPath);
      return {
        dayOfWeek: asString(dayJson["dayOfWeek"], `${dayPath}.dayOfWeek`),
        switchpoints: asArray(
          dayJson["switchpoints"],
          `${dayPath}.switchpoints`,
        ).map((sp, spIndex) =>
          parseSwitchpoint(sp, `${dayPath}.switchpoints[${String(spIndex)}]`),
        ),
      } satisfies DailySchedule;
    },
  );
};
