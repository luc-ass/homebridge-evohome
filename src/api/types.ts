/**
 * Domänentypen der TCC-EMEA-API.
 *
 * Die API ist nicht dokumentiert; die Felder stammen aus dem Altcode
 * (`legacy/evohome.cjs`) und aus echten Antworten. Alles, was das Plugin nicht
 * auswertet, wird bewusst weggelassen — je kleiner die Fläche, desto weniger
 * bricht, wenn Resideo etwas ändert (siehe Risiko-Tabelle in
 * docs/MIGRATION-HB2.md).
 */

/** Betriebsart eines Temperature Control System. */
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

/** Art eines Sollwerts, wie ihn die API meldet und entgegennimmt. */
export const SETPOINT_MODES = [
  "FollowSchedule",
  "TemporaryOverride",
  "PermanentOverride",
] as const;

export type SetpointMode = (typeof SETPOINT_MODES)[number];

/** Zustand der Warmwasserbereitung. */
export const DHW_STATES = ["On", "Off"] as const;

export type DhwState = (typeof DHW_STATES)[number];

/**
 * Gerätetypen, die als Heizzone auftreten.
 *
 * 0.11.2 filterte auf genau diese drei Werte. Unbekannte Typen werden weiterhin
 * übersprungen, aber protokolliert, statt still zu verschwinden.
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
  /** Windows-Zeitzonen-ID, z. B. "W. Europe Standard Time" — kein IANA-Name. */
  readonly timeZoneId: string;
  readonly displayName: string;
  /** Basis-Offset in Minuten, ohne Sommerzeit. */
  readonly offsetMinutes: number;
  /** Aktuell gültiger Offset in Minuten, inklusive Sommerzeit. */
  readonly currentOffsetMinutes: number;
  readonly supportsDaylightSaving: boolean;
}

/** Grenzen und Schrittweite eines Sollwerts, aus `setpointCapabilities`. */
export interface SetpointCapabilities {
  readonly minHeatSetpoint: number;
  readonly maxHeatSetpoint: number;
  readonly valueResolution: number;
}

/** Eine Heizzone, wie sie in der Installationsbeschreibung steht. */
export interface Zone {
  readonly zoneId: string;
  readonly name: string;
  readonly zoneType: string;
  readonly modelType: ZoneModel;
  readonly setpointCapabilities: SetpointCapabilities;
}

/** Warmwasserbereitung, sofern das System eine hat. */
export interface DomesticHotWater {
  readonly dhwId: string;
}

/** Ein Temperature Control System — die Evohome-Zentrale einer Location. */
export interface TemperatureControlSystem {
  readonly systemId: string;
  readonly modelType: string;
  readonly zones: readonly Zone[];
  readonly dhw: DomesticHotWater | undefined;
  /** Vom System unterstützte Betriebsarten, aus `allowedSystemModes`. */
  readonly allowedSystemModes: readonly SystemMode[];
}

/** Eine Location — in der Regel ein Haushalt. */
export interface Location {
  readonly locationId: string;
  readonly name: string;
  readonly timeZone: TimeZoneInfo;
  readonly system: TemperatureControlSystem;
}

/** Messwert einer Zone. Nicht jede Zone liefert immer einen. */
export interface TemperatureStatus {
  readonly isAvailable: boolean;
  /** Fehlt, wenn `isAvailable` false ist — etwa bei leerer Batterie. */
  readonly temperature: number | undefined;
}

export interface SetpointStatus {
  readonly targetHeatTemperature: number;
  readonly setpointMode: SetpointMode;
  /** Endzeitpunkt eines `TemporaryOverride`, sonst undefined. */
  readonly until: Date | undefined;
}

/** Laufender Status einer Zone. */
export interface ZoneStatus {
  readonly zoneId: string;
  readonly name: string;
  readonly temperatureStatus: TemperatureStatus;
  readonly setpointStatus: SetpointStatus;
  /** Aktive Störungen, z. B. `TempZoneActuatorCommunicationLost`. */
  readonly activeFaults: readonly string[];
}

export interface DhwStatus {
  readonly dhwId: string;
  readonly temperatureStatus: TemperatureStatus;
  readonly state: DhwState;
  readonly mode: SetpointMode;
  readonly until: Date | undefined;
}

export interface SystemModeStatus {
  readonly mode: SystemMode;
  readonly isPermanent: boolean;
  readonly until: Date | undefined;
}

/** Laufender Status einer kompletten Location — eine Abfrage, alle Werte. */
export interface LocationStatus {
  readonly locationId: string;
  readonly systemId: string;
  readonly systemModeStatus: SystemModeStatus;
  readonly zones: readonly ZoneStatus[];
  readonly dhw: DhwStatus | undefined;
}

/** Ein Schaltpunkt im Zeitprogramm. */
export interface Switchpoint {
  /** Lokale Uhrzeit der Location im Format `HH:MM:SS`. */
  readonly timeOfDay: string;
  /** Bei Heizzonen gesetzt. */
  readonly heatSetpoint: number | undefined;
  /** Bei Warmwasser gesetzt. */
  readonly dhwState: DhwState | undefined;
}

export interface DailySchedule {
  /** Englischer Wochentagsname, wie ihn die API liefert: `Monday` … `Sunday`. */
  readonly dayOfWeek: string;
  readonly switchpoints: readonly Switchpoint[];
}

/** Anmeldedaten einer Sitzung. */
export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absoluter Ablaufzeitpunkt, aus `expires_in` berechnet. */
  readonly expiresAt: number;
}
