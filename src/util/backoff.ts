/**
 * Exponential backoff with a cap and jitter.
 *
 * Issue #136 asks for an automatic retry after a failed login but explicitly
 * warns against running into Honeywell's rate limit while doing so. The jitter
 * also keeps many Homebridge instances from coming back in lockstep after an
 * outage.
 */

export interface BackoffOptions {
  /** Delay after the first failure, in milliseconds. */
  readonly initialMs: number;
  /** Upper bound for the delay, in milliseconds. */
  readonly maxMs: number;
  /** Multiplier applied per additional failure. */
  readonly factor: number;
  /** Amount of random spread, 0 to 1. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 30_000,
  maxMs: 30 * 60_000,
  factor: 2,
  jitter: 0.2,
};

/**
 * Computes the delay before attempt number `attempt`.
 *
 * @param attempt Number of failures so far, starting at 1.
 * @param random Source of randomness, replaceable in tests.
 */
export const backoffDelay = (
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    options.maxMs,
    options.initialMs * options.factor ** exponent,
  );
  // Spread above and below the base value, but never negative.
  const spread = base * options.jitter;
  const delay = base + (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(delay));
};

/** Waits for the given duration. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
