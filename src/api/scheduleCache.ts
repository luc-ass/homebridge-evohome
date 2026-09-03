import type { EvohomeClient } from "./client.js";
import type { DailySchedule } from "./types.js";
import type { Logging } from "homebridge";

/**
 * Caches schedules.
 *
 * 0.11.2 fetched the schedule on **every** temperature change — a dozen extra
 * requests for a walk through a twelve-zone house. Schedules only change when
 * somebody edits them on the controller or in the app.
 *
 * The cache is deliberately simple: an expiry, no invalidation signal. An edited
 * schedule takes effect after `ttlMs` at the latest.
 */
export class ScheduleCache {
  private readonly entries = new Map<
    string,
    { schedules: readonly DailySchedule[]; expiresAt: number }
  >();

  /** In-flight requests, so concurrent callers share one. */
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

  /** Drops every entry, e.g. after a schedule was edited. */
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
        // Without a schedule a permanent override is still possible, which beats
        // refusing to operate at all.
        this.log.debug(
          `Could not fetch the schedule for ${key}: ${String(error)}`,
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
