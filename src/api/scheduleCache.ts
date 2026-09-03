import type { EvohomeClient } from "./client.js";
import type { DailySchedule } from "./types.js";
import type { Logging } from "homebridge";

/**
 * Hält Zeitprogramme zwischen.
 *
 * 0.11.2 holte den Zeitplan bei **jeder** Temperaturänderung neu — bei einem
 * Haus mit zwölf Zonen und einer Runde durch die Räume also ein Dutzend
 * zusätzlicher Anfragen. Zeitprogramme ändern sich aber nur, wenn jemand sie
 * am Controller oder in der App bearbeitet.
 *
 * Der Cache ist bewusst schlicht: eine Ablaufzeit, kein Invalidierungssignal.
 * Ändert jemand das Programm, greift es spätestens nach `ttlMs`.
 */
export class ScheduleCache {
  private readonly entries = new Map<
    string,
    { schedules: readonly DailySchedule[]; expiresAt: number }
  >();

  /** Laufende Abfragen, damit gleichzeitige Zugriffe sich eine teilen. */
  private readonly pending = new Map<
    string,
    Promise<readonly DailySchedule[]>
  >();

  constructor(
    private readonly client: EvohomeClient,
    private readonly log: Logging,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  zone(zoneId: string): Promise<readonly DailySchedule[]> {
    return this.get(`zone:${zoneId}`, () =>
      this.client.getZoneSchedule(zoneId),
    );
  }

  dhw(dhwId: string): Promise<readonly DailySchedule[]> {
    return this.get(`dhw:${dhwId}`, () => this.client.getDhwSchedule(dhwId));
  }

  /** Verwirft alle Einträge, etwa nach einer Änderung am Zeitprogramm. */
  clear(): void {
    this.entries.clear();
  }

  private async get(
    key: string,
    fetch: () => Promise<readonly DailySchedule[]>,
  ): Promise<readonly DailySchedule[]> {
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.schedules;
    }

    const running = this.pending.get(key);
    if (running !== undefined) {
      return running;
    }

    const request = fetch()
      .then((schedules) => {
        this.entries.set(key, {
          schedules,
          expiresAt: Date.now() + this.ttlMs,
        });
        return schedules;
      })
      .catch((error: unknown) => {
        // Ohne Zeitprogramm lässt sich immer noch ein dauerhafter Override
        // setzen — das ist besser, als die Bedienung ganz zu verweigern.
        this.log.debug(
          `Zeitprogramm für ${key} nicht abrufbar: ${String(error)}`,
        );
        return [] as readonly DailySchedule[];
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, request);
    return request;
  }
}
