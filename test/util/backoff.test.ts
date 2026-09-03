import { describe, expect, it } from "vitest";

import {
  backoffDelay,
  DEFAULT_BACKOFF,
  type BackoffOptions,
} from "../../src/util/backoff.js";

/** Without jitter the plain curve can be asserted. */
const NO_JITTER: BackoffOptions = { ...DEFAULT_BACKOFF, jitter: 0 };

describe("backoffDelay", () => {
  it("grows exponentially", () => {
    expect(backoffDelay(1, NO_JITTER)).toBe(30_000);
    expect(backoffDelay(2, NO_JITTER)).toBe(60_000);
    expect(backoffDelay(3, NO_JITTER)).toBe(120_000);
    expect(backoffDelay(4, NO_JITTER)).toBe(240_000);
  });

  it("caps at maxMs instead of growing without bound", () => {
    // Issue #136 explicitly warns about hitting the rate limit, but a cap also
    // keeps the plugin from going silent for hours after a long outage.
    expect(backoffDelay(20, NO_JITTER)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelay(100, NO_JITTER)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("treats the first attempt like a failure", () => {
    expect(backoffDelay(0, NO_JITTER)).toBe(DEFAULT_BACKOFF.initialMs);
  });

  it("spreads around the base value so instances do not return in lockstep", () => {
    const base = 60_000;
    const spread = base * DEFAULT_BACKOFF.jitter;

    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0)).toBe(base - spread);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 1)).toBe(base + spread);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0.5)).toBe(base);
  });

  it("never goes negative", () => {
    const wild: BackoffOptions = { ...DEFAULT_BACKOFF, jitter: 5 };
    expect(backoffDelay(1, wild, () => 0)).toBeGreaterThanOrEqual(0);
  });
});
