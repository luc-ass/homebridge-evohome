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
 * HTTP-Client für die TCC-EMEA-API.
 *
 * Ersetzt `legacy/evohome.cjs`. Statt `request` und `q` (beide deprecated,
 * Befund S14) nutzt der Client das in Node 22+ eingebaute `fetch` mit
 * `AbortSignal.timeout` — das Plugin hat damit keine Laufzeitabhängigkeiten
 * mehr.
 *
 * Jede Antwort läuft durch die Parser aus `parse.ts`, sodass eine
 * unvollständige Antwort einen benannten Fehler erzeugt statt eines
 * `TypeError` an beliebiger Stelle (Befund S8).
 */

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface RequestOptions {
  readonly method: "GET" | "PUT" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** Wird nur intern gesetzt, um die 401-Wiederholung zu begrenzen. */
  readonly isRetry?: boolean;
}

/** Antwort der Schreiboperationen: die API quittiert mit einer Task-ID. */
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
   * Liest die Installationsbeschreibung: alle Locations mit Zonen, Zeitzone und
   * erlaubten Systemmodi.
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
   * Liest den kompletten Status einer Location — Zonen, Systemmodus und
   * Warmwasser in **einer** Anfrage.
   *
   * 0.11.2 rief denselben Endpunkt pro Zyklus zweimal auf und holte zusätzlich
   * die Installationsbeschreibung (Befund S13).
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
   * Setzt den Sollwert einer Zone.
   *
   * @param mode `FollowSchedule` hebt einen Override auf, `TemporaryOverride`
   *   gilt bis `until`, `PermanentOverride` bis auf Weiteres. Issue #149 hängt
   *   genau an dieser Wahl — 0.11.2 erzwang immer `TemporaryOverride`.
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

    // Ein abgelaufener Token äußert sich als 401. Einmal erneuern und
    // wiederholen — danach ist es ein echter Fehler.
    if (response.status === 401 && options.isRetry !== true) {
      await this.tokens.invalidate();
      return this.request({ ...options, isRetry: true });
    }

    if (response.status === 429) {
      throw new EvohomeRateLimitError(
        `Evohome-API meldet zu viele Anfragen für ${options.path}.`,
        retryAfterMs(response.headers.get("retry-after")),
        text,
      );
    }

    if (!response.ok) {
      throw new EvohomeApiError(
        `Evohome-API antwortete auf ${options.method} ${options.path} mit HTTP ${String(response.status)}.`,
        response.status,
        text,
      );
    }

    // Schreiboperationen dürfen mit leerem Body quittieren.
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
        `Evohome-API nicht erreichbar (${options.method} ${options.path}): ${String(cause)}`,
        { cause },
      );
    }
  }
}

/**
 * Formatiert einen Zeitpunkt so, wie die API ihn erwartet.
 *
 * 0.11.2 übergab ein `Date`-Objekt an `JSON.stringify`, was einen
 * ISO-String mit Millisekunden und `Z` ergab. Die API akzeptiert das, aber die
 * Sekundenauflösung reicht und ist besser lesbar im Log.
 */
const toApiTime = (until: Date | undefined): string | null =>
  until === undefined ? null : `${until.toISOString().slice(0, 19)}Z`;

/** Liest `Retry-After` — entweder Sekunden oder ein HTTP-Datum. */
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
