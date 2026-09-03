import { DEFAULT_BASE_URL, REQUEST_TIMEOUT_MS } from "../settings.js";
import { EvohomeAuthError, EvohomeNetworkError } from "./errors.js";
import { parseTokens } from "./parse.js";
import { parseJson } from "./validate.js";

import type { Tokens } from "./types.js";

/**
 * Verwaltet die Sitzung gegenüber der TCC-EMEA-API.
 *
 * Gegenüber 0.11.2 ändert sich dreierlei:
 *
 * - Der Token wird **bedarfsgesteuert** vor dem Ablauf erneuert, statt über ein
 *   `setInterval` mit dem einmalig gelesenen `expires_in`. Scheitert die
 *   Erneuerung, folgt eine vollständige Neuanmeldung — vorher war das Plugin
 *   bis zum Neustart tot (Befund S12, Issue #136).
 * - Zugangsdaten liegen ausschließlich hier, nicht in einer modulglobalen Map,
 *   die nie gelesen und nie geleert wurde (Befund S10).
 * - Parallele Aufrufe teilen sich einen laufenden Anmeldeversuch, statt jeder
 *   für sich eine Anfrage zu stellen.
 */

/**
 * OAuth-Client-Credentials der Honeywell-Mobile-App, Base64-kodiert.
 *
 * Fest im Protokoll verankert und in jeder Evohome-Integration identisch — es
 * ist kein Geheimnis des Nutzers. Über `AuthOptions.basicAuth` überschreibbar,
 * falls Resideo sie austauscht.
 */
const APP_BASIC_AUTH =
  "Basic NGEyMzEwODktZDJiNi00MWJkLWE1ZWItMTZhMGE0MjJiOTk5OjFhMTVjZGI4LTQyZGUtNDA3Yi1hZGQwLTA1OWY5MmM1MzBjYg==";

const SCOPE =
  "EMEA-V1-Basic EMEA-V1-Anonymous EMEA-V1-Get-Current-User-Account";

/** Zeitpuffer vor dem Ablauf, ab dem vorsorglich erneuert wird. */
const REFRESH_MARGIN_MS = 60_000;

export interface AuthOptions {
  readonly baseUrl?: string;
  readonly basicAuth?: string;
  readonly timeoutMs?: number;
}

/** Speicher für Tokens über Neustarts hinweg. */
export interface TokenCache {
  read(): Promise<Tokens | undefined>;
  write(tokens: Tokens | undefined): Promise<void>;
}

interface OAuthErrorBody {
  readonly error?: string;
  readonly error_description?: string;
}

/**
 * Fehlerkennungen, bei denen ein Neuversuch sinnlos ist.
 *
 * `invalid_grant` steht bei `grant_type=password` für falsche Zugangsdaten,
 * bei `grant_type=refresh_token` für einen verbrauchten Refresh-Token — dort
 * hilft eine Neuanmeldung, was der Aufrufer separat behandelt.
 */
const PERMANENT_ERRORS = new Set(["invalid_grant", "unauthorized_client"]);

export class TokenStore {
  private tokens: Tokens | undefined;

  /** Läuft gerade eine Anmeldung oder Erneuerung, wird sie hier geteilt. */
  private pending: Promise<Tokens> | undefined;

  private readonly baseUrl: string;
  private readonly basicAuth: string;
  private readonly timeoutMs: number;

  // Zugangsdaten liegen in ES-Private-Feldern: die sind nicht aufzählbar und
  // tauchen daher weder in JSON.stringify noch in einem Objekt-Dump im Log auf.
  // Befund S10 betraf zwar die modulglobale Map aus 0.11.2 — dass Homebridge
  // im Fehlerfall ganze Objekte protokolliert, macht das hier trotzdem zur
  // richtigen Ablage.
  readonly #username: string;
  readonly #password: string;

  constructor(
    username: string,
    password: string,
    private readonly cache: TokenCache | undefined,
    options: AuthOptions = {},
  ) {
    this.#username = username;
    this.#password = password;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.basicAuth = options.basicAuth ?? APP_BASIC_AUTH;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Liefert einen gültigen `Authorization`-Header und erneuert die Sitzung,
   * falls nötig.
   */
  async authorization(): Promise<string> {
    const tokens = await this.valid();
    return `bearer ${tokens.accessToken}`;
  }

  /** Erzwingt eine Erneuerung, etwa nachdem die API mit 401 geantwortet hat. */
  async invalidate(): Promise<void> {
    this.tokens = undefined;
    await this.cache?.write(undefined);
  }

  /** Nur für Tests und Diagnose: der aktuell gehaltene Token. */
  get current(): Tokens | undefined {
    return this.tokens;
  }

  /** Läuft der Token bald ab und sollte erneuert werden? */
  private expiresSoon(tokens: Tokens): boolean {
    return tokens.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  }

  private async valid(): Promise<Tokens> {
    if (this.tokens !== undefined && !this.expiresSoon(this.tokens)) {
      return this.tokens;
    }

    // Mehrere gleichzeitige Aufrufe teilen sich denselben Versuch.
    this.pending ??= this.acquire().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async acquire(): Promise<Tokens> {
    const cached = this.tokens ?? (await this.cache?.read());

    // Nach einem Homebridge-Neustart liegt oft noch ein gültiger Token im
    // Cache. Den einfach zu übernehmen spart eine Anfrage pro Start und
    // verbraucht nicht unnötig den Refresh-Token.
    if (cached !== undefined && !this.expiresSoon(cached)) {
      return this.remember(cached);
    }

    if (cached !== undefined && cached.refreshToken !== "") {
      const refreshed = await this.tryRefresh(cached.refreshToken);
      if (refreshed !== undefined) {
        return this.remember(refreshed);
      }
    }

    return this.remember(await this.login());
  }

  /**
   * Versucht die Erneuerung und gibt `undefined` zurück, wenn sie scheitert.
   *
   * Ein verbrauchter Refresh-Token ist kein Grund aufzugeben — er ist der
   * Normalfall nach längerer Ausfallzeit und führt hier zur Neuanmeldung.
   */
  private async tryRefresh(refreshToken: string): Promise<Tokens | undefined> {
    try {
      return await this.token({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (error) {
      if (error instanceof EvohomeAuthError && !error.retryable) {
        return undefined;
      }
      throw error;
    }
  }

  private async login(): Promise<Tokens> {
    return this.token({
      grant_type: "password",
      scope: SCOPE,
      Username: this.#username,
      Password: this.#password,
    });
  }

  private async remember(tokens: Tokens): Promise<Tokens> {
    this.tokens = tokens;
    await this.cache?.write(tokens);
    return tokens;
  }

  private async token(fields: Record<string, string>): Promise<Tokens> {
    const body = new URLSearchParams(fields).toString();
    const response = await this.post(body);
    const text = await response.text();

    if (!response.ok) {
      throw this.authError(response.status, text);
    }

    const json = parseJson(text, "token");
    // Die API antwortet auf manche Fehler mit HTTP 200 und einem
    // `error`-Feld im Body — deshalb reicht der Statuscode allein nicht.
    const oauthError = (json as OAuthErrorBody).error;
    if (oauthError !== undefined) {
      throw this.authError(response.status, text);
    }
    return parseTokens(json, Date.now());
  }

  private async post(body: string): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/Auth/OAuth/Token`, {
        method: "POST",
        headers: {
          Authorization: this.basicAuth,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-store no-cache",
          Pragma: "no-cache",
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new EvohomeNetworkError(
        `Anmeldung bei Evohome nicht möglich: ${String(cause)}`,
        { cause },
      );
    }
  }

  private authError(status: number, text: string): EvohomeAuthError {
    let code: string | undefined;
    let description: string | undefined;
    try {
      const json = JSON.parse(text) as OAuthErrorBody;
      code = json.error;
      description = json.error_description;
    } catch {
      // Kein JSON — dann bleibt es beim Statuscode.
    }

    const permanent = code !== undefined && PERMANENT_ERRORS.has(code);
    const detail = description ?? code ?? text.slice(0, 200);
    const hint = permanent
      ? " Bitte Benutzername und Passwort in der config.json prüfen."
      : "";

    return new EvohomeAuthError(
      `Anmeldung bei Evohome fehlgeschlagen (HTTP ${String(status)}): ${detail}.${hint}`,
      !permanent,
    );
  }
}
