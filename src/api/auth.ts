import { DEFAULT_BASE_URL, REQUEST_TIMEOUT_MS } from "../settings.js";
import { EvohomeAuthError, EvohomeNetworkError } from "./errors.js";
import { parseTokens } from "./parse.js";
import { parseJson } from "./validate.js";

import type { Tokens } from "./types.js";

/**
 * Manages the session against the TCC EMEA API.
 *
 * Three things changed compared with 0.11.2:
 *
 * - The token is refreshed **on demand** before it expires, instead of via a
 *   `setInterval` using the `expires_in` read once at startup. If the refresh
 *   fails, a full re-login follows; previously the plugin stayed dead until
 *   restart (issue #136).
 * - Credentials live only here, not in a module-level map that was never read
 *   and never cleared.
 * - Concurrent callers share one in-flight login instead of each issuing their
 *   own request.
 */

/**
 * OAuth client credentials of the Honeywell mobile app, base64 encoded.
 *
 * Baked into the protocol and identical in every Evohome integration; this is not
 * a user secret. Overridable via `AuthOptions.basicAuth` should Resideo rotate
 * them.
 */
const APP_BASIC_AUTH =
  "Basic NGEyMzEwODktZDJiNi00MWJkLWE1ZWItMTZhMGE0MjJiOTk5OjFhMTVjZGI4LTQyZGUtNDA3Yi1hZGQwLTA1OWY5MmM1MzBjYg==";

const SCOPE =
  "EMEA-V1-Basic EMEA-V1-Anonymous EMEA-V1-Get-Current-User-Account";

/** Safety margin before expiry at which we refresh pre-emptively. */
const REFRESH_MARGIN_MS = 60_000;

export interface AuthOptions {
  readonly baseUrl?: string;
  readonly basicAuth?: string;
  readonly timeoutMs?: number;
}

/** Storage for tokens across restarts. */
export interface TokenCache {
  read(): Promise<Tokens | undefined>;
  write(tokens: Tokens | undefined): Promise<void>;
}

interface OAuthErrorBody {
  readonly error?: string;
  readonly error_description?: string;
}

/**
 * Error codes for which retrying is pointless.
 *
 * For `grant_type=password`, `invalid_grant` means bad credentials; for
 * `grant_type=refresh_token` it means a spent refresh token, where a re-login
 * helps — handled separately by the caller.
 */
const PERMANENT_ERRORS = new Set(["invalid_grant", "unauthorized_client"]);

export class TokenStore {
  private tokens: Tokens | undefined;

  /** A login or refresh in flight, shared between concurrent callers. */
  private pending: Promise<Tokens> | undefined;

  private readonly baseUrl: string;
  private readonly basicAuth: string;
  private readonly timeoutMs: number;

  // Credentials live in ES private fields: those are not enumerable and so
  // appear neither in JSON.stringify nor in an object dump in the log.
  // Homebridge logs whole objects on failure, which makes this the right place
  // for them.
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
   * Returns a valid `Authorization` header, refreshing the session if needed.
   */
  async authorization(): Promise<string> {
    const tokens = await this.valid();
    return `bearer ${tokens.accessToken}`;
  }

  /**
   * Forces a refresh, e.g. after the API answered with 401.
   *
   * @param authorization The header the failed request actually sent. While
   *   that request was in flight a concurrent one may already have logged in
   *   again; dropping *that* token would force a second full password login
   *   and is exactly the rate-limit pressure the backoff exists to avoid
   *   (issue #218). Without the argument the token is dropped unconditionally.
   */
  async invalidate(authorization?: string): Promise<void> {
    if (
      authorization !== undefined &&
      this.tokens !== undefined &&
      `bearer ${this.tokens.accessToken}` !== authorization
    ) {
      return;
    }
    this.tokens = undefined;
    await this.cache?.write(undefined);
  }

  /** For tests and diagnostics only: the token currently held. */
  get current(): Tokens | undefined {
    return this.tokens;
  }

  /** Is the token about to expire and due for a refresh? */
  private expiresSoon(tokens: Tokens): boolean {
    return tokens.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  }

  private async valid(): Promise<Tokens> {
    if (this.tokens !== undefined && !this.expiresSoon(this.tokens)) {
      return this.tokens;
    }

    // Concurrent callers share the same attempt.
    this.pending ??= this.acquire().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async acquire(): Promise<Tokens> {
    const cached = this.tokens ?? (await this.cache?.read());

    // After a Homebridge restart the cache often still holds a valid token.
    // Adopting it saves one request per start and does not burn the refresh
    // token needlessly.
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
   * Attempts the refresh and returns `undefined` if it fails.
   *
   * A spent refresh token is no reason to give up: it is the normal case after a
   * longer outage and leads to a re-login here.
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
    // The API answers some errors with HTTP 200 and an `error` field in the
    // body, so the status code alone is not enough.
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
        `Could not reach the Evohome login endpoint: ${String(cause)}`,
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
      // Not JSON, so the status code is all we have.
    }

    const permanent = code !== undefined && PERMANENT_ERRORS.has(code);
    const detail = description ?? code ?? text.slice(0, 200);
    const hint = permanent
      ? " Please check the username and password in your config.json."
      : "";

    return new EvohomeAuthError(
      `Evohome login failed (HTTP ${String(status)}): ${detail}.${hint}`,
      !permanent,
    );
  }
}
