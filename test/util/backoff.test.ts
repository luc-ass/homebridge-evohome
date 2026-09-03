import { describe, expect, it } from "vitest";

import {
  backoffDelay,
  DEFAULT_BACKOFF,
  type BackoffOptions,
} from "../../src/util/backoff.js";

/** Ohne Jitter lässt sich die reine Kurve prüfen. */
const NO_JITTER: BackoffOptions = { ...DEFAULT_BACKOFF, jitter: 0 };

describe("backoffDelay", () => {
  it("wächst exponentiell", () => {
    expect(backoffDelay(1, NO_JITTER)).toBe(30_000);
    expect(backoffDelay(2, NO_JITTER)).toBe(60_000);
    expect(backoffDelay(3, NO_JITTER)).toBe(120_000);
    expect(backoffDelay(4, NO_JITTER)).toBe(240_000);
  });

  it("deckelt bei maxMs, statt ins Unendliche zu laufen", () => {
    // Issue #136 warnt ausdrücklich davor, den Rate-Limiter zu treffen —
    // ein Deckel verhindert aber auch, dass das Plugin nach einem langen
    // Ausfall stundenlang schweigt.
    expect(backoffDelay(20, NO_JITTER)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelay(100, NO_JITTER)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("behandelt den ersten Versuch wie einen Fehlschlag", () => {
    expect(backoffDelay(0, NO_JITTER)).toBe(DEFAULT_BACKOFF.initialMs);
  });

  it("streut um den Basiswert, damit Instanzen nicht im Gleichtakt zurückkommen", () => {
    const base = 60_000;
    const spread = base * DEFAULT_BACKOFF.jitter;

    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0)).toBe(base - spread);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 1)).toBe(base + spread);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0.5)).toBe(base);
  });

  it("wird nie negativ", () => {
    const wild: BackoffOptions = { ...DEFAULT_BACKOFF, jitter: 5 };
    expect(backoffDelay(1, wild, () => 0)).toBeGreaterThanOrEqual(0);
  });
});
