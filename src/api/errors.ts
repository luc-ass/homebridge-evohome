/**
 * Error types raised by the Evohome client.
 *
 * 0.11.2 had none: an outage surfaced as a bare `TypeError`, because response
 * fields were read without checking, and the error paths swallowed the rest.
 * Every cause gets its own type here so the caller can decide whether to retry,
 * re-authenticate or give up.
 */

/** Common base for every error this client throws. */
export class EvohomeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Login failed, or the session could not be refreshed.
 *
 * `retryable` separates the permanent case (wrong password: retrying achieves
 * nothing and only runs into the rate limit) from the temporary one (expired
 * refresh token, server error during login).
 *
 * `status` is the HTTP status the token endpoint answered with. `TokenStore`
 * needs it to tell a rejected refresh token from an endpoint that was simply
 * unreachable, because only the first is worth a re-login (issue #136).
 */
export class EvohomeAuthError extends EvohomeError {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The API responded with a status outside 2xx. */
export class EvohomeApiError extends EvohomeError {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/**
 * Honeywell's rate limit was reached (HTTP 429).
 *
 * `retryAfterMs` comes from the `Retry-After` header, when present.
 */
export class EvohomeRateLimitError extends EvohomeApiError {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
    body?: string,
  ) {
    super(message, 429, body);
  }
}

/** Network error or timeout: the request never reached the server. */
export class EvohomeNetworkError extends EvohomeError {}

/**
 * The response was valid JSON but did not match the expected shape.
 *
 * Exactly the case that surfaced in 0.11.2 as
 * `Cannot read properties of undefined (reading 'temperature')` (issue #205).
 */
export class EvohomeResponseError extends EvohomeError {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/**
 * Reports whether an error is worth retrying.
 *
 * Bad credentials and malformed responses are permanent; retrying will not help.
 * Network, server and rate-limit errors pass.
 */
export const isRetryable = (error: unknown): boolean => {
  if (error instanceof EvohomeAuthError) {
    return error.retryable;
  }
  if (error instanceof EvohomeRateLimitError) {
    return true;
  }
  if (error instanceof EvohomeApiError) {
    return error.status >= 500;
  }
  return error instanceof EvohomeNetworkError;
};
