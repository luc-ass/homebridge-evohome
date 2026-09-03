import type { DailySchedule, Switchpoint } from "../api/types.js";

/**
 * Ermittelt den nächsten Schaltpunkt eines Zeitprogramms.
 *
 * Ersetzt `getNextScheduledTime()` aus 0.11.2 (Befund S9). Der Altcode hatte
 * drei Fehler:
 *
 * 1. Die Schleifenvariable `proceed` wurde zwischen den Wochentagen nicht
 *    zurückgesetzt, sodass das Ergebnis von der Reihenfolge der Tage in der
 *    Antwort abhing.
 * 2. Verglichen wurde mit `toLocaleTimeString()` — also lexikografisch über
 *    einen lokalisierten String, dessen Format je nach Systemsprache variiert.
 * 3. Gab es heute keinen späteren Schaltpunkt mehr, fiel das Ergebnis auf
 *    `"00:00:00"` zurück, statt den ersten Schaltpunkt des Folgetags zu suchen.
 *
 * Diese Fassung rechnet in Sekunden seit Mitternacht, sucht bei Bedarf über
 * Tagesgrenzen hinweg und gibt einen absoluten Zeitpunkt zurück.
 *
 * **Zeitzonen:** Evohome-Schaltpunkte gelten in der lokalen Zeit der Location.
 * `offsetMinutes` ist deren aktueller UTC-Offset (`currentOffsetMinutes` aus
 * der API). Die Umrechnung nutzt einen festen Offset — an der Nacht der
 * Sommerzeitumstellung kann das Ergebnis daher um eine Stunde abweichen. Das
 * ist bewusst in Kauf genommen: die API liefert nur Windows-Zeitzonen-IDs
 * (z. B. `"W. Europe Standard Time"`), mit denen `Intl` nicht rechnen kann.
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

/** Ein Schaltpunkt mit dem absoluten Zeitpunkt seines nächsten Eintretens. */
export interface UpcomingSwitchpoint extends Switchpoint {
  /** Absoluter Zeitpunkt, zu dem der Schaltpunkt greift. */
  readonly at: Date;
}

/**
 * Wandelt `"HH:MM:SS"` in Sekunden seit Mitternacht.
 * Gibt `undefined` zurück, wenn das Format nicht stimmt.
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

/** Schaltpunkte eines Tages, nach Uhrzeit sortiert und ohne kaputte Einträge. */
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
 * Sucht den nächsten Schaltpunkt nach `now`.
 *
 * @param schedules Wochenprogramm, wie es die API liefert.
 * @param now Bezugszeitpunkt.
 * @param offsetMinutes UTC-Offset der Location in Minuten.
 * @returns Der nächste Schaltpunkt, oder `undefined`, wenn das Programm leer
 *   ist oder keinen verwertbaren Eintrag enthält.
 */
export const nextSwitchpoint = (
  schedules: readonly DailySchedule[],
  now: Date,
  offsetMinutes: number,
): UpcomingSwitchpoint | undefined => {
  const byDay = new Map(schedules.map((day) => [day.dayOfWeek, day]));

  // In lokale Wanduhrzeit der Location umrechnen: der verschobene Zeitstempel
  // liefert über die UTC-Getter direkt die dortige Uhrzeit.
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

  // Heute plus die folgenden sieben Tage — so ist auch ein Programm abgedeckt,
  // in dem nur ein einziger Wochentag Schaltpunkte hat.
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
