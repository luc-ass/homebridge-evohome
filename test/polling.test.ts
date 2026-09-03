import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseLocationStatus } from "../src/api/parse.js";
import { EvohomeApiError, EvohomeNetworkError } from "../src/api/errors.js";
import { PollingCoordinator } from "../src/polling.js";
import { fixture } from "./helpers.js";

import type { EvohomeClient } from "../src/api/client.js";
import type { LocationStatus } from "../src/api/types.js";
import type { Logging } from "homebridge";

const status = parseLocationStatus(fixture("locationStatus.json"));

const makeLog = (): Logging & { warnings: string[]; infos: string[] } => {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    warn: (m: string) => warnings.push(m),
    info: (m: string) => infos.push(m),
    debug: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    log: vi.fn(),
  } as unknown as Logging & { warnings: string[]; infos: string[] };
};

/** Client stub with a controllable response. */
const makeClient = (
  impl: () => Promise<LocationStatus>,
): EvohomeClient & { calls: number } => {
  const client = {
    calls: 0,
    getLocationStatus: () => {
      client.calls++;
      return impl();
    },
  };
  return client as unknown as EvohomeClient & { calls: number };
};

describe("PollingCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers the status to every listener", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 300, makeLog());

    const seen: LocationStatus[] = [];
    poller.subscribe((s) => seen.push(s));
    await poller.start();
    poller.stop();

    expect(client.calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.zones).toHaveLength(4);
    expect(poller.status).toBe(status);
  });

  it("stops notifying unsubscribed listeners", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 300, makeLog());

    let count = 0;
    const unsubscribe = poller.subscribe(() => count++);
    await poller.start();
    unsubscribe();
    await poller.refresh();
    poller.stop();

    expect(count).toBe(1);
  });

  it("starts no second run while one is in flight", async () => {
    // 0.11.2 reset its updating flag synchronously at the end of the function,
    // long before the promise chain finished. The guard never worked and polls
    // could stack up: the likely cause of #172.
    let resolve: (value: LocationStatus) => void = () => undefined;
    const client = makeClient(
      () =>
        new Promise<LocationStatus>((r) => {
          resolve = r;
        }),
    );
    const poller = new PollingCoordinator(client, "9876543", 300, makeLog());

    const first = poller.refresh();
    const second = poller.refresh();
    const third = poller.refresh();

    expect(client.calls).toBe(1);

    resolve(status);
    await Promise.all([first, second, third]);
    expect(client.calls).toBe(1);

    // Once finished, the next run is possible again.
    const fourth = poller.refresh();
    expect(client.calls).toBe(2);
    resolve(status);
    await fourth;
    poller.stop();
  });

  it("polls again on the configured interval", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 60, makeLog());

    await poller.start();
    expect(client.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls).toBe(3);

    poller.stop();
  });

  it("issues no further requests after stop()", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 60, makeLog());

    await poller.start();
    poller.stop();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.calls).toBe(1);
  });

  it("survives an error and carries on afterwards", async () => {
    let fail = true;
    const client = makeClient(() =>
      fail
        ? Promise.reject(new EvohomeNetworkError("no connection"))
        : Promise.resolve(status),
    );
    const log = makeLog();
    const poller = new PollingCoordinator(client, "9876543", 60, log);

    await poller.start();
    expect(poller.status).toBeUndefined();
    expect(log.warnings.join()).toContain("no connection");

    fail = false;
    await poller.refresh();
    expect(poller.status).toBe(status);
    expect(log.infos.join()).toContain("Reconnected");
    poller.stop();
  });

  it("does not repeat the same error message on every attempt", async () => {
    // In 0.11.2 a longer Honeywell outage filled the log with the same message
    // and stack trace, which is what prompted PR #204.
    const client = makeClient(() =>
      Promise.reject(new EvohomeNetworkError("no connection")),
    );
    const log = makeLog();
    const poller = new PollingCoordinator(client, "9876543", 60, log);

    await poller.start();
    await poller.refresh();
    await poller.refresh();

    expect(client.calls).toBe(3);
    expect(
      log.warnings.filter((w) => w.includes("no connection")),
    ).toHaveLength(1);
    poller.stop();
  });

  it("calls out permanent errors separately", async () => {
    const client = makeClient(() =>
      Promise.reject(new EvohomeApiError("not found", 404)),
    );
    const log = makeLog();
    const poller = new PollingCoordinator(client, "9876543", 60, log);

    await poller.start();
    expect(log.warnings.join()).toContain("unlikely to resolve");
    poller.stop();
  });

  it("widens the gap after repeated failures", async () => {
    // The gap is always at least the regular interval and grows with the number
    // of failures. After ten minutes of continuous outage there must therefore
    // be far fewer attempts than the ten a fixed 60s cadence would produce.
    const client = makeClient(() =>
      Promise.reject(new EvohomeNetworkError("weg")),
    );
    const poller = new PollingCoordinator(client, "9876543", 60, makeLog());

    await poller.start();
    expect(client.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.calls).toBeGreaterThan(1);
    expect(client.calls).toBeLessThan(10);
    poller.stop();
  });

  it("does not let a failing listener take the others down", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 300, makeLog());

    let reached = false;
    poller.subscribe(() => {
      throw new Error("listener is broken");
    });
    poller.subscribe(() => {
      reached = true;
    });

    await poller.start();
    expect(reached).toBe(true);
    poller.stop();
  });
});
