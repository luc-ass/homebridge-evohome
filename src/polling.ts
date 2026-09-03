import { isRetryable } from "./api/errors.js";
import { backoffDelay, DEFAULT_BACKOFF } from "./util/backoff.js";

import type { EvohomeClient } from "./api/client.js";
import type { LocationStatus } from "./api/types.js";
import type { Logging } from "homebridge";

/**
 * Fetches the location status and hands it to every accessory handler.
 *
 * Replaces four separate timer constructions from 0.11.2:
 *
 * - `periodicUpdate` every 300s making three API calls
 * - `periodicCheckSetTemperature` every 5s **per zone**
 * - `periodicCheckStatus` every 60s for hot water
 * - `renewSession` on a hard-wired interval (now handled by the TokenStore)
 *
 * The reentrancy guard is the important part: 0.11.2 reset its `updating` flag
 * synchronously at the end of the function, long before the promise chain had
 * finished. The guard never worked, so polls could overlap and stack up — the
 * likely cause of issue #172. Here an `await` on the in-flight run actually
 * holds concurrency back.
 */

export type StatusListener = (status: LocationStatus) => void;

export class PollingCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<LocationStatus | undefined> | undefined;
  private stopped = false;
  private consecutiveFailures = 0;

  private readonly listeners = new Set<StatusListener>();

  /** Last status that was read successfully. */
  private lastStatus: LocationStatus | undefined;

  constructor(
    private readonly client: EvohomeClient,
    private readonly locationId: string,
    private readonly intervalSeconds: number,
    private readonly log: Logging,
  ) {}

  get status(): LocationStatus | undefined {
    return this.lastStatus;
  }

  /** Registers a listener and returns the unsubscribe function. */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts the cycle and performs a first request immediately. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.poll();
    this.schedule();
  }

  /**
   * Stops the cycle.
   *
   * 0.11.2 never kept its timer handles and therefore could not clear them.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * Triggers a refresh **without** waiting for it.
   *
   * For the write path from HomeKit: once the API has acknowledged the command,
   * the `onSet` handler is done. Waiting for the follow-up read as well would
   * stall HomeKit for several seconds on every tap, and on a slow response run
   * into the very timeout behind issue #180.
   */
  scheduleRefresh(delayMs = 0): void {
    if (this.stopped) {
      return;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.poll();
    }, delayMs);
    this.refreshTimer.unref();
  }

  /**
   * Forces an out-of-band request.
   *
   * Used after a write: Honeywell's servers need a moment before a change shows
   * up in the status.
   */
  async refresh(delayMs = 0): Promise<void> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!this.stopped) {
      await this.poll();
    }
  }

  /**
   * Performs a request. If one is already running, waits for it instead of
   * starting a second.
   */
  private async poll(): Promise<LocationStatus | undefined> {
    this.inFlight ??= this.fetchOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<LocationStatus | undefined> {
    try {
      const status = await this.client.getLocationStatus(this.locationId);
      this.onSuccess(status);
      return status;
    } catch (error) {
      this.onFailure(error);
      return undefined;
    }
  }

  private onSuccess(status: LocationStatus): void {
    if (this.consecutiveFailures > 0) {
      this.log.info(
        `Reconnected to Evohome after ${String(this.consecutiveFailures)} failed attempt(s).`,
      );
    }
    this.consecutiveFailures = 0;
    this.lastStatus = status;

    for (const listener of this.listeners) {
      // A failing handler must not take the others down with it.
      try {
        listener(status);
      } catch (error) {
        this.log.error(
          `Error while handling the status update: ${String(error)}`,
        );
      }
    }
  }

  /**
   * Logs a failure.
   *
   * The first failure is a warning, every later one goes to the debug log only.
   * Otherwise a longer Honeywell outage fills the log with the same message —
   * the reason PR #204 was opened.
   */
  private onFailure(error: unknown): void {
    this.consecutiveFailures++;
    const message = error instanceof Error ? error.message : String(error);

    if (this.consecutiveFailures === 1) {
      this.log.warn(`Failed to fetch status from Evohome: ${message}`);
    } else {
      this.log.debug(
        `Status request failed (${String(this.consecutiveFailures)} consecutive failures): ${message}`,
      );
    }

    if (!isRetryable(error) && this.consecutiveFailures === 1) {
      this.log.warn(
        "This error is unlikely to resolve on its own. Please check your configuration and the log above.",
      );
    }
  }

  /** Schedules the next run, with a growing delay after failures. */
  private schedule(): void {
    if (this.stopped) {
      return;
    }

    const regular = this.intervalSeconds * 1000;
    const delay =
      this.consecutiveFailures === 0
        ? regular
        : Math.max(
            regular,
            backoffDelay(this.consecutiveFailures, DEFAULT_BACKOFF),
          );

    this.timer = setTimeout(() => {
      void this.poll().finally(() => {
        this.schedule();
      });
    }, delay);
    // An open timer must not keep Node from exiting.
    this.timer.unref();
  }
}
