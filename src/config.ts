import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
} from "./settings.js";

import {
  DEFAULT_SETPOINT_STRATEGY,
  SETPOINT_STRATEGIES,
  type SetpointStrategy,
} from "./util/setpoint.js";

import type { SystemMode } from "./api/types.js";
import type { Logging, PlatformConfig } from "homebridge";

/**
 * Liest und prüft die Platform-Konfiguration.
 *
 * 0.11.2 las die Werte direkt aus `config["..."]` und verglich Schalter mit
 * `!= false`, sodass ein Tippfehler stillschweigend als `true` durchging.
 * Hier wird jeder Wert geprüft, fehlerhafte Angaben werden mit Hinweis auf den
 * verwendeten Ersatzwert protokolliert.
 */

/** Systemmodi, für die das Plugin einen Schalter anbieten kann. */
export const SWITCHABLE_MODES = [
  "Away",
  "DayOff",
  "AutoWithEco",
  "HeatingOff",
  "Custom",
] as const;

export type SwitchableMode = (typeof SWITCHABLE_MODES)[number];

/** Zuordnung der Config-Schlüssel zu den Systemmodi. */
const SWITCH_KEYS: Record<SwitchableMode, string> = {
  Away: "switchAway",
  DayOff: "switchDayOff",
  AutoWithEco: "switchEco",
  HeatingOff: "switchHeatingOff",
  Custom: "switchCustom",
};

/** Anzeigename je Schalter, an 0.11.2 angelehnt. */
export const SWITCH_LABELS: Record<SwitchableMode, string> = {
  Away: "Away Mode",
  DayOff: "Day Off Mode",
  AutoWithEco: "Eco Mode",
  HeatingOff: "Heating Off Mode",
  Custom: "Custom Mode",
};

export interface EvohomeConfig {
  readonly name: string;
  readonly username: string;
  readonly password: string;
  /**
   * Bevorzugte Adressierung der Location. Stabil gegenüber Umsortierungen bei
   * Honeywell — anders als der Index (Entscheidung F5).
   */
  readonly locationId: string | undefined;
  /** Rückfallebene, wenn keine `locationId` gesetzt ist. */
  readonly locationIndex: number;
  readonly pollIntervalSeconds: number;
  readonly temperatureAboveAsOff: boolean;
  readonly showSwitches: Readonly<Record<SwitchableMode, boolean>>;
  readonly history: boolean;
  /**
   * Wie ein Sollwert aus HomeKit geschrieben wird (Issue #149).
   * Siehe {@link SetpointStrategy}.
   */
  readonly setpointMode: SetpointStrategy;
  /** Jede Änderung der Ist-Temperatur ins Log schreiben (Issue #146). */
  readonly logTemperatureChanges: boolean;
}

const readSetpointStrategy = (
  value: unknown,
  log: Logging,
): SetpointStrategy => {
  if (value === undefined || value === null) {
    return DEFAULT_SETPOINT_STRATEGY;
  }
  if (
    typeof value === "string" &&
    (SETPOINT_STRATEGIES as readonly string[]).includes(value)
  ) {
    return value as SetpointStrategy;
  }
  log.warn(
    `Unknown value for "setpointMode" (${JSON.stringify(value)}). Allowed values are ${SETPOINT_STRATEGIES.join(", ")}. Using ${DEFAULT_SETPOINT_STRATEGY}.`,
  );
  return DEFAULT_SETPOINT_STRATEGY;
};

const readBoolean = (
  value: unknown,
  fallback: boolean,
  key: string,
  log: Logging,
): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  log.warn(
    `Configuration value "${key}" is not true/false (${JSON.stringify(value)}). Using ${String(fallback)}.`,
  );
  return fallback;
};

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const readPollInterval = (value: unknown, log: Logging): number => {
  if (value === undefined || value === null) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    log.warn(
      `Configuration value "pollIntervalSeconds" is not a number (${JSON.stringify(value)}). Using ${String(DEFAULT_POLL_INTERVAL_SECONDS)}s.`,
    );
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  if (seconds < MIN_POLL_INTERVAL_SECONDS) {
    // Ein zu kurzes Intervall führt in den Rate-Limiter der Honeywell-Server
    // und trifft dann alle Nutzer desselben Kontos.
    log.warn(
      `A polling interval of ${String(seconds)}s is too short and would hit Honeywell’s rate limit. Using ${String(MIN_POLL_INTERVAL_SECONDS)}s.`,
    );
    return MIN_POLL_INTERVAL_SECONDS;
  }
  return Math.round(seconds);
};

const readLocationIndex = (value: unknown, log: Logging): number => {
  if (value === undefined || value === null) {
    return 0;
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    log.warn(
      `Configuration value "locationIndex" is not a valid index (${JSON.stringify(value)}). Using 0.`,
    );
    return 0;
  }
  return index;
};

/** Meldet Config-Schlüssel, die es nicht mehr gibt. */
const warnAboutRemovedKeys = (config: PlatformConfig, log: Logging): void => {
  if (config["childBridge"] !== undefined) {
    // Der Schalter unterdrückte in 0.11.2 nur ein `callback([])` im
    // Fehlerfall. Eine dynamische Platform verliert ihre Accessories bei
    // einem Fehler ohnehin nicht mehr (Befund S2).
    log.warn(
      'The "childBridge" option no longer exists and is ignored. Accessories now survive errors without a child bridge, so the entry can be removed from your config.json.',
    );
  }
  if (config["temperatureUnit"] !== undefined) {
    // HomeKit zeigt Temperaturen immer in der Einheit des iOS-Geräts an; die
    // Option hatte in 0.11.2 keine Wirkung auf die Anzeige.
    log.warn(
      'The "temperatureUnit" option no longer exists and is ignored. HomeKit picks the display unit from the iOS device settings.',
    );
  }
};

/**
 * Fehler in der Konfiguration, die einen sinnvollen Betrieb unmöglich machen.
 */
export class ConfigError extends Error {}

export const readConfig = (
  config: PlatformConfig,
  log: Logging,
): EvohomeConfig => {
  warnAboutRemovedKeys(config, log);

  const username = readString(config["username"]);
  const password = readString(config["password"]);
  if (username === undefined || password === undefined) {
    throw new ConfigError(
      'Your config.json is missing "username" and/or "password" for the Honeywell account.',
    );
  }

  const showSwitches = Object.fromEntries(
    SWITCHABLE_MODES.map((mode) => [
      mode,
      readBoolean(config[SWITCH_KEYS[mode]], true, SWITCH_KEYS[mode], log),
    ]),
  ) as Record<SwitchableMode, boolean>;

  return {
    name: readString(config.name) ?? "Evohome",
    username,
    password,
    locationId: readString(config["locationId"]),
    locationIndex: readLocationIndex(config["locationIndex"], log),
    pollIntervalSeconds: readPollInterval(config["pollIntervalSeconds"], log),
    temperatureAboveAsOff: readBoolean(
      config["temperatureAboveAsOff"],
      false,
      "temperatureAboveAsOff",
      log,
    ),
    showSwitches,
    history: readBoolean(config["history"], true, "history", log),
    setpointMode: readSetpointStrategy(config["setpointMode"], log),
    logTemperatureChanges: readBoolean(
      config["logTemperatureChanges"],
      false,
      "logTemperatureChanges",
      log,
    ),
  };
};

/** Ist `mode` ein Modus, für den ein Schalter angeboten wird? */
export const isSwitchableMode = (mode: SystemMode): mode is SwitchableMode =>
  (SWITCHABLE_MODES as readonly SystemMode[]).includes(mode);
