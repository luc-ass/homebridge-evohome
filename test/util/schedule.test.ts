import { describe, expect, it } from "vitest";

import { parseSchedule } from "../../src/api/parse.js";
import { nextSwitchpoint, parseTimeOfDay } from "../../src/util/schedule.js";
import { fixture } from "../helpers.js";

import type { DailySchedule } from "../../src/api/types.js";

const zoneSchedule = parseSchedule(fixture("scheduleZone.json"));
const dhwSchedule = parseSchedule(fixture("scheduleDhw.json"));

/** Sommerzeit in Mitteleuropa: UTC+2. */
const CEST = 120;
/** Winterzeit in Mitteleuropa: UTC+1. */
const CET = 60;

describe("parseTimeOfDay", () => {
  it("liest HH:MM:SS", () => {
    expect(parseTimeOfDay("06:30:00")).toBe(6 * 3600 + 30 * 60);
    expect(parseTimeOfDay("00:00:00")).toBe(0);
    expect(parseTimeOfDay("23:59:59")).toBe(86399);
  });

  it("liest auch HH:MM ohne Sekunden", () => {
    expect(parseTimeOfDay("17:00")).toBe(17 * 3600);
  });

  it("weist Unsinn zurück, statt ihn stillschweigend zu akzeptieren", () => {
    for (const bad of ["", "6:30 PM", "25:00:00", "12:60:00", "abc"]) {
      expect(parseTimeOfDay(bad)).toBeUndefined();
    }
  });
});

describe("nextSwitchpoint", () => {
  it("findet den nächsten Schaltpunkt des laufenden Tages", () => {
    // Montag, 3.8.2026, 07:00 Ortszeit (05:00 UTC bei CEST).
    const now = new Date("2026-08-03T05:00:00Z");
    const next = nextSwitchpoint(zoneSchedule, now, CEST);

    expect(next?.timeOfDay).toBe("08:30:00");
    expect(next?.heatSetpoint).toBe(17);
    expect(next?.at.toISOString()).toBe("2026-08-03T06:30:00.000Z");
  });

  it("springt auf den Folgetag, wenn heute nichts mehr kommt", () => {
    // Montag 23:00 Ortszeit — nach dem letzten Schaltpunkt (22:30).
    // 0.11.2 lieferte hier "00:00:00" statt des ersten Punkts am Dienstag
    // (Befund S9).
    const now = new Date("2026-08-03T21:00:00Z");
    const next = nextSwitchpoint(zoneSchedule, now, CEST);

    expect(next?.timeOfDay).toBe("06:30:00");
    expect(next?.at.toISOString()).toBe("2026-08-04T04:30:00.000Z");
  });

  it("behandelt exakt auf einem Schaltpunkt liegende Zeiten als vergangen", () => {
    // Genau 06:30 Ortszeit: der 06:30-Punkt greift bereits, der nächste ist 08:30.
    const now = new Date("2026-08-03T04:30:00Z");
    expect(nextSwitchpoint(zoneSchedule, now, CEST)?.timeOfDay).toBe(
      "08:30:00",
    );
  });

  it("wechselt korrekt über die Sonntag-Montag-Grenze", () => {
    // Sonntag, 2.8.2026, 23:30 Ortszeit.
    const now = new Date("2026-08-02T21:30:00Z");
    const next = nextSwitchpoint(zoneSchedule, now, CEST);

    expect(next?.timeOfDay).toBe("06:30:00");
    expect(next?.at.toISOString()).toBe("2026-08-03T04:30:00.000Z");
  });

  it("rechnet mit dem Offset der Location, nicht mit dem des Systems", () => {
    // Derselbe Zeitpunkt, einmal als CET und einmal als CEST gelesen, ergibt
    // eine andere Ortszeit — und damit einen anderen nächsten Schaltpunkt.
    // Genau diese Verwechslung steckt hinter der Zeitzonen-Warnung im README.
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

  it("ist unabhängig von der Reihenfolge der Tage in der Antwort", () => {
    // 0.11.2 setzte die Schleifenvariable zwischen den Tagen nicht zurück,
    // sodass das Ergebnis von der Sortierung abhing (Befund S9).
    const reversed = [...zoneSchedule].reverse();
    const now = new Date("2026-08-03T05:00:00Z");

    expect(nextSwitchpoint(reversed, now, CEST)).toEqual(
      nextSwitchpoint(zoneSchedule, now, CEST),
    );
  });

  it("sortiert unsortierte Schaltpunkte innerhalb eines Tages", () => {
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
    const now = new Date("2026-08-03T05:00:00Z"); // 07:00 Ortszeit
    expect(nextSwitchpoint(scrambled, now, CEST)?.timeOfDay).toBe("17:00:00");
  });

  it("findet den nächsten Termin auch, wenn nur ein Wochentag belegt ist", () => {
    const onlySaturday: DailySchedule[] = [
      {
        dayOfWeek: "Saturday",
        switchpoints: [
          { timeOfDay: "08:00:00", heatSetpoint: 21, dhwState: undefined },
        ],
      },
    ];
    // Montag — der Treffer liegt fünf Tage voraus.
    const now = new Date("2026-08-03T05:00:00Z");
    expect(nextSwitchpoint(onlySaturday, now, CEST)?.at.toISOString()).toBe(
      "2026-08-08T06:00:00.000Z",
    );
  });

  it("gibt undefined zurück, wenn das Programm leer ist", () => {
    expect(nextSwitchpoint([], new Date(), CEST)).toBeUndefined();
  });

  it("überspringt Schaltpunkte mit kaputter Uhrzeit", () => {
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

  it("funktioniert genauso für Warmwasser-Programme", () => {
    const now = new Date("2026-08-03T05:00:00Z"); // Montag 07:00 Ortszeit
    const next = nextSwitchpoint(dhwSchedule, now, CEST);

    expect(next?.dhwState).toBe("Off");
    expect(next?.heatSetpoint).toBeUndefined();
    expect(next?.at.toISOString()).toBe("2026-08-03T07:00:00.000Z");
  });

  describe("Sommerzeitumstellung", () => {
    // In der Nacht zum 25.10.2026 wird in Europa von CEST auf CET gestellt.
    // Die API liefert nur Windows-Zeitzonen-IDs, mit denen Intl nicht rechnen
    // kann; deshalb wird mit dem gemeldeten festen Offset gerechnet. Diese
    // Tests halten das dokumentierte Verhalten fest.
    it("rechnet vor der Umstellung mit dem Sommerzeit-Offset", () => {
      const now = new Date("2026-10-24T05:00:00Z"); // Samstag 07:00 CEST
      expect(nextSwitchpoint(zoneSchedule, now, CEST)?.at.toISOString()).toBe(
        "2026-10-24T06:00:00.000Z",
      );
    });

    it("rechnet nach der Umstellung mit dem Winterzeit-Offset", () => {
      const now = new Date("2026-10-25T06:00:00Z"); // Sonntag 07:00 CET
      expect(nextSwitchpoint(zoneSchedule, now, CET)?.at.toISOString()).toBe(
        "2026-10-25T07:00:00.000Z",
      );
    });
  });
});
