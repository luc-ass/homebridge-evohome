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

/** Client-Attrappe mit steuerbarer Antwort. */
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

  it("liefert den Status an alle Empfänger", async () => {
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

  it("meldet abbestellte Empfänger nicht mehr", async () => {
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

  it("startet keinen zweiten Durchlauf, während einer läuft (S5)", async () => {
    // 0.11.2 setzte sein updating-Flag synchron am Ende der Funktion zurück,
    // also lange vor dem Ende der Promise-Kette. Der Schutz wirkte nie und
    // Abfragen konnten sich stapeln — wahrscheinliche Ursache von #172.
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

    // Nach Abschluss ist der nächste Durchlauf wieder möglich.
    const fourth = poller.refresh();
    expect(client.calls).toBe(2);
    resolve(status);
    await fourth;
    poller.stop();
  });

  it("fragt im konfigurierten Takt erneut ab", async () => {
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

  it("stellt nach stop() keine weiteren Anfragen (S11)", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 60, makeLog());

    await poller.start();
    poller.stop();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.calls).toBe(1);
  });

  it("überlebt einen Fehler und arbeitet danach weiter", async () => {
    let fail = true;
    const client = makeClient(() =>
      fail
        ? Promise.reject(new EvohomeNetworkError("keine Verbindung"))
        : Promise.resolve(status),
    );
    const log = makeLog();
    const poller = new PollingCoordinator(client, "9876543", 60, log);

    await poller.start();
    expect(poller.status).toBeUndefined();
    expect(log.warnings.join()).toContain("keine Verbindung");

    fail = false;
    await poller.refresh();
    expect(poller.status).toBe(status);
    expect(log.infos.join()).toContain("wiederhergestellt");
    poller.stop();
  });

  it("wiederholt dieselbe Fehlermeldung nicht bei jedem Versuch", async () => {
    // Ein längerer Honeywell-Ausfall füllte in 0.11.2 das Log mit derselben
    // Meldung samt Stacktrace — der Anlass für PR #204.
    const client = makeClient(() =>
      Promise.reject(new EvohomeNetworkError("keine Verbindung")),
    );
    const log = makeLog();
    const poller = new PollingCoordinator(client, "9876543", 60, log);

    await poller.start();
    await poller.refresh();
    await poller.refresh();

    expect(client.calls).toBe(3);
    expect(
      log.warnings.filter((w) => w.includes("keine Verbindung")),
    ).toHaveLength(1);
    poller.stop();
  });

  it("weist auf dauerhafte Fehler gesondert hin", async () => {
    const client = makeClient(() =>
      Promise.reject(new EvohomeApiError("nicht gefunden", 404)),
    );
    const log = makeLog();
    const poller = new PollingCoordinator(client, "9876543", 60, log);

    await poller.start();
    expect(log.warnings.join()).toContain("nicht von selbst weg");
    poller.stop();
  });

  it("vergrößert den Abstand nach wiederholten Fehlern", async () => {
    // Der Abstand ist stets mindestens das reguläre Intervall und wächst mit
    // der Zahl der Fehlschläge. Nach zehn Minuten Dauerausfall darf deshalb
    // deutlich seltener angefragt worden sein als die zehn Versuche, die ein
    // starrer 60-s-Takt ergäbe.
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

  it("lässt einen fehlerhaften Empfänger die übrigen nicht mitreißen", async () => {
    const client = makeClient(() => Promise.resolve(status));
    const poller = new PollingCoordinator(client, "9876543", 300, makeLog());

    let reached = false;
    poller.subscribe(() => {
      throw new Error("Handler kaputt");
    });
    poller.subscribe(() => {
      reached = true;
    });

    await poller.start();
    expect(reached).toBe(true);
    poller.stop();
  });
});
