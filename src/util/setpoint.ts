import type { SetpointMode } from "../api/types.js";

/**
 * Entscheidet, wie ein Sollwert aus HomeKit an Evohome geschrieben wird.
 *
 * Hintergrund ist Issue #149: 0.11.2 schrieb **immer** einen
 * `TemporaryOverride` bis zum nächsten Schaltpunkt und überschrieb damit die
 * Endzeit eines bereits laufenden Overrides. Wer „19 °C bis 20:30" eingestellt
 * hatte und um 16:01 auf 20 °C erhöhte, bekam „20 °C bis 18:00".
 *
 * Die API kennt keinen Modus „Wert ändern, Endzeit behalten" —
 * `PUT /temperatureZone/{id}/heatSetpoint` verlangt zwingend einen der drei
 * `SetpointMode`-Werte. Die laufende Endzeit steht aber in
 * `setpointStatus.until`, sodass sie sich einfach wieder mitschicken lässt.
 */

export const SETPOINT_STRATEGIES = [
  "keepExistingUntil",
  "untilNextSwitchpoint",
  "permanent",
] as const;

export type SetpointStrategy = (typeof SETPOINT_STRATEGIES)[number];

export const DEFAULT_SETPOINT_STRATEGY: SetpointStrategy = "keepExistingUntil";

/** Der aktuell gemeldete Zustand einer Zone bzw. des Warmwassers. */
export interface CurrentOverride {
  readonly setpointMode: SetpointMode;
  readonly until: Date | undefined;
}

export interface OverrideDecision {
  readonly mode: SetpointMode;
  readonly until: Date | undefined;
  /** Kurze Begründung für das Log. */
  readonly reason: string;
}

/**
 * Wählt Modus und Endzeit für einen neuen Sollwert.
 *
 * @param strategy Aus der Konfiguration.
 * @param current Was die API gerade meldet.
 * @param nextSwitchpointAt Nächster Schaltpunkt des Zeitprogramms, falls
 *   ermittelbar.
 * @param now Bezugszeitpunkt.
 */
export const decideOverride = (
  strategy: SetpointStrategy,
  current: CurrentOverride,
  nextSwitchpointAt: Date | undefined,
  now: Date,
): OverrideDecision => {
  if (strategy === "permanent") {
    return { mode: "PermanentOverride", until: undefined, reason: "dauerhaft" };
  }

  if (strategy === "keepExistingUntil" && isRunning(current, now)) {
    return {
      mode: "TemporaryOverride",
      until: current.until,
      reason: `bis ${formatTime(current.until)} (Endzeit des laufenden Overrides)`,
    };
  }

  if (nextSwitchpointAt !== undefined && nextSwitchpointAt > now) {
    return {
      mode: "TemporaryOverride",
      until: nextSwitchpointAt,
      reason: `bis ${formatTime(nextSwitchpointAt)} (nächster Schaltpunkt)`,
    };
  }

  // Ohne verwertbares Zeitprogramm bliebe nur ein Override ohne Endzeit.
  // 0.11.2 setzte hier ersatzweise "00:00:00", was den Sollwert bis
  // Mitternacht galt oder — über den Tageswechsel — sofort verfiel.
  return {
    mode: "PermanentOverride",
    until: undefined,
    reason: "dauerhaft (kein Schaltpunkt im Zeitprogramm gefunden)",
  };
};

/** Läuft gerade ein befristeter Override, dessen Ende noch bevorsteht? */
const isRunning = (current: CurrentOverride, now: Date): boolean =>
  current.setpointMode === "TemporaryOverride" &&
  current.until !== undefined &&
  current.until > now;

const formatTime = (date: Date | undefined): string =>
  date === undefined ? "unbekannt" : date.toISOString().slice(11, 16) + " UTC";
