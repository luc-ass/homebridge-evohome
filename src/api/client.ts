import { API_PATH, DEFAULT_BASE_URL, REQUEST_TIMEOUT_MS } from "../settings.js";
import {
  EvohomeApiError,
  EvohomeNetworkError,
  EvohomeRateLimitError,
} from "./errors.js";
import {
  parseInstallationInfo,
  parseLocationStatus,
  parseSchedule,
  parseUserAccount,
} from "./parse.js";
import { parseJson } from "./validate.js";

import type { TokenStore } from "./auth.js";
import type {
  DailySchedule,
  DhwState,
  Location,
  LocationStatus,
  SetpointMode,
  SystemMode,
  UserAccount,
} from "./types.js";

/**
 * HTTP client for the TCC EMEA API.
 *
 * Replaces `legacy/evohome.cjs`. Instead of `request` and `q` (both deprecated)
 * it uses the `fetch` built into Node 22+ together with `AbortSignal.timeout`,
 * which leaves the plugin without runtime dependencies.
 *
 * Every response goes through the parsers in `parse.ts`, so an incomplete
 * response produces a named error instead of a `TypeError` somewhere else.
 */

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface RequestOptions {
  readonly method: "GET" | "PUT" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** Set internally only, to bound the retry after a 401. */
  readonly isRetry?: boolean;
}

/** Response to a write: the API acknowledges with a task ID. */
export interface TaskAcknowledgement {
  readonly id: string | undefined;
}

export class EvohomeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly tokens: TokenStore,
    options: ClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL) + API_PATH;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async getUserAccount(): Promise<UserAccount> {
    return parseUserAccount(
      await this.request({ method: "GET", path: "/userAccount" }),
    );
  }

  /**
   * Reads the installation info: every location with its zones, time zone and
   * allowed system modes.
   */
  async getLocations(userId: string): Promise<readonly Location[]> {
    return parseInstallationInfo(
      await this.request({
        method: "GET",
        path: `/location/installationInfo?userId=${encodeURIComponent(userId)}&includeTemperatureControlSystems=True`,
      }),
    );
  }

  /**
   * Reads the complete status of a location — zones, system mode and hot water in
   * **one** request.
   *
   * 0.11.2 called the same endpoint twice per cycle and additionally fetched the
   * installation info.
   */
  async getLocationStatus(locationId: string): Promise<LocationStatus> {
    return parseLocationStatus(
      await this.request({
        method: "GET",
        path: `/location/${encodeURIComponent(locationId)}/status?includeTemperatureControlSystems=True`,
      }),
    );
  }

  async getZoneSchedule(zoneId: string): Promise<readonly DailySchedule[]> {
    return parseSchedule(
      await this.request({
        method: "GET",
        path: `/temperatureZone/${encodeURIComponent(zoneId)}/schedule`,
      }),
    );
  }

  async getDhwSchedule(dhwId: string): Promise<readonly DailySchedule[]> {
    return parseSchedule(
      await this.request({
        method: "GET",
        path: `/domesticHotWater/${encodeURIComponent(dhwId)}/schedule`,
      }),
    );
  }

  /**
   * Sets the target temperature of a zone.
   *
   * @param mode `FollowSchedule` cancels an override, `TemporaryOverride` applies
   *   until `until`, `PermanentOverride` until further notice. Issue #149 turns
   *   on exactly this choice — 0.11.2 always forced `TemporaryOverride`.
   */
  async setHeatSetpoint(
    zoneId: string,
    mode: SetpointMode,
    temperature: number | undefined,
    until: Date | undefined,
  ): Promise<TaskAcknowledgement> {
    return this.acknowledge(
      await this.request({
        method: "PUT",
        path: `/temperatureZone/${encodeURIComponent(zoneId)}/heatSetpoint`,
        body: {
          HeatSetpointValue: mode === "FollowSchedule" ? 0 : temperature,
          SetpointMode: mode,
          TimeUntil: mode === "TemporaryOverride" ? toApiTime(until) : null,
        },
      }),
    );
  }

  async setSystemMode(
    systemId: string,
    mode: SystemMode,
    until: Date | undefined,
  ): Promise<TaskAcknowledgement> {
    return this.acknowledge(
      await this.request({
        method: "PUT",
        path: `/temperatureControlSystem/${encodeURIComponent(systemId)}/mode`,
        body: {
          SystemMode: mode,
          TimeUntil: toApiTime(until),
          Permanent: until === undefined,
        },
      }),
    );
  }

  async setDhwState(
    dhwId: string,
    mode: SetpointMode,
    state: DhwState | undefined,
    until: Date | undefined,
  ): Promise<TaskAcknowledgement> {
    return this.acknowledge(
      await this.request({
        method: "PUT",
        path: `/domesticHotWater/${encodeURIComponent(dhwId)}/state`,
        body: {
          Mode: mode,
          State: mode === "FollowSchedule" ? null : state,
          UntilTime: mode === "TemporaryOverride" ? toApiTime(until) : null,
        },
      }),
    );
  }

  private acknowledge(raw: unknown): TaskAcknowledgement {
    const id =
      typeof raw === "object" && raw !== null
        ? (raw as { id?: unknown }).id
        : undefined;
    return { id: typeof id === "string" ? id : undefined };
  }

  private async request(options: RequestOptions): Promise<unknown> {
    const response = await this.send(options);
    const text = await response.text();

    // An expired token shows up as a 401. Refresh once and retry; after that it
    // is a real error.
    if (response.status === 401 && options.isRetry !== true) {
      await this.tokens.invalidate();
      return this.request({ ...options, isRetry: true });
    }

    if (response.status === 429) {
      throw new EvohomeRateLimitError(
        `Evohome API rate limit reached for ${options.path}.`,
        retryAfterMs(response.headers.get("retry-after")),
        text,
      );
    }

    if (!response.ok) {
      throw new EvohomeApiError(
        `Evohome API responded to ${options.method} ${options.path} with HTTP ${String(response.status)}.`,
        response.status,
        text,
      );
    }

    // Writes may acknowledge with an empty body.
    if (text.trim() === "" && options.method !== "GET") {
      return {};
    }
    return parseJson(text, options.path);
  }

  private async send(options: RequestOptions): Promise<Response> {
    const authorization = await this.tokens.authorization();
    const headers: Record<string, string> = { Authorization: authorization };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    try {
      return await fetch(`${this.baseUrl}${options.path}`, {
        method: options.method,
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new EvohomeNetworkError(
        `Evohome API unreachable (${options.method} ${options.path}): ${String(cause)}`,
        { cause },
      );
    }
  }
}

/**
 * Formats a point in time the way the API expects it.
 *
 * 0.11.2 passed a `Date` to `JSON.stringify`, producing an ISO string with
 * milliseconds. The API accepts that, but second resolution is enough and reads
 * better in the log.
 */
const toApiTime = (until: Date | undefined): string | null =>
  until === undefined ? null : `${until.toISOString().slice(0, 19)}Z`;

/** Reads `Retry-After`, which is either seconds or an HTTP date. */
const retryAfterMs = (header: string | null): number | undefined => {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = new Date(header);
  return Number.isNaN(date.getTime())
    ? undefined
    : Math.max(0, date.getTime() - Date.now());
};
