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
 * Übersetzt die rohen API-Antworten in die Domänentypen aus `types.ts`.
 *
 * Jeder Zugriff läuft über die Helfer aus `validate.ts`, damit eine
 * unvollständige Antwort einen benannten `EvohomeResponseError` erzeugt statt
 * eines `TypeError` an irgendeiner späteren Stelle (Befund S8).
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
 * Unbekannte `modelType`-Werte werden zu `Unknown` statt zu einem Fehler.
 *
 * Ein neues Ventilmodell bei Resideo soll nicht das ganze Plugin lahmlegen —
 * die betroffene Zone wird später übersprungen und dabei protokolliert.
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
 * `allowedSystemModes` ist eine Liste von Objekten, nicht von Strings.
 * Unbekannte Modi werden verworfen statt zu einem Fehler zu führen.
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

/** Liest `gateways[0].temperatureControlSystems[0]` mit sprechenden Fehlern. */
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

export const parseInstallationInfo = (raw: unknown): readonly Location[] => {
  const locations = asArray(raw, "installationInfo");
  return locations.map((entry, index) => {
    const path = `installationInfo[${String(index)}]`;
    const json = asRecord(entry, path);
    const info = asRecord(json["locationInfo"], `${path}.locationInfo`);
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
    } satisfies Location;
  });
};

const parseTemperatureStatus = (
  raw: unknown,
  path: string,
): TemperatureStatus => {
  const json = asRecord(raw, path);
  const isAvailable = asBoolean(json["isAvailable"], `${path}.isAvailable`);
  // Bei nicht verfügbaren Zonen fehlt `temperature` oder ist unbrauchbar.
  // 0.11.2 reichte den Wert ungeprüft an HomeKit weiter — daher die
  // "characteristic value expected valid finite number" aus Issue #94.
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

/** `activeFaults` ist eine Liste von Objekten mit `faultType` und `since`. */
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
 * Liest den Status einer kompletten Location aus einer einzigen Antwort.
 *
 * 0.11.2 rief denselben Endpunkt zweimal auf — einmal für die Zonen, einmal für
 * den Systemmodus (Befund S13). Hier fällt beides zusammen an.
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
