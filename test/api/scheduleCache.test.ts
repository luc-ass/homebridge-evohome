import { describe, expect, it, vi } from "vitest";

import { parseSchedule } from "../../src/api/parse.js";
import { ScheduleCache } from "../../src/api/scheduleCache.js";
import { fixture } from "../helpers.js";

import type { EvohomeClient } from "../../src/api/client.js";
import type { Logging } from "homebridge";

const schedule = parseSchedule(fixture("scheduleZone.json"));
const dhwSchedule = parseSchedule(fixture("scheduleDhw.json"));

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  log: vi.fn(),
} as unknown as Logging;

const makeClient = (): EvohomeClient & {
  zoneCalls: number;
  dhwCalls: number;
  fail: boolean;
} => {
  const client = {
    zoneCalls: 0,
    dhwCalls: 0,
    fail: false,
    getZoneSchedule: () => {
      client.zoneCalls++;
      return client.fail
        ? Promise.reject(new Error("API weg"))
        : Promise.resolve(schedule);
    },
    getDhwSchedule: () => {
      client.dhwCalls++;
      return Promise.resolve(dhwSchedule);
    },
  };
  return client as unknown as EvohomeClient & {
    zoneCalls: number;
    dhwCalls: number;
    fail: boolean;
  };
};

describe("ScheduleCache", () => {
  it("holt ein Zeitprogramm nur einmal", async () => {
    // 0.11.2 fragte den Zeitplan bei jeder Temperaturänderung neu ab — bei
    // zwölf Zonen also ein Dutzend zusätzlicher Anfragen pro Rundgang.
    const client = makeClient();
    const cache = new ScheduleCache(client, log);

    await cache.zone("3001");
    await cache.zone("3001");
    await cache.zone("3001");

    expect(client.zoneCalls).toBe(1);
  });

  it("hält Zonen und Warmwasser getrennt", async () => {
    const client = makeClient();
    const cache = new ScheduleCache(client, log);

    expect(await cache.zone("3001")).toBe(schedule);
    expect(await cache.dhw("2001")).toBe(dhwSchedule);
    expect(client.zoneCalls).toBe(1);
    expect(client.dhwCalls).toBe(1);
  });

  it("hält verschiedene Zonen getrennt", async () => {
    const client = makeClient();
    const cache = new ScheduleCache(client, log);

    await cache.zone("3001");
    await cache.zone("3002");

    expect(client.zoneCalls).toBe(2);
  });

  it("bündelt gleichzeitige Abfragen derselben Zone", async () => {
    const client = makeClient();
    const cache = new ScheduleCache(client, log);

    await Promise.all([
      cache.zone("3001"),
      cache.zone("3001"),
      cache.zone("3001"),
    ]);

    expect(client.zoneCalls).toBe(1);
  });

  it("holt nach Ablauf der Frist erneut", async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient();
      const cache = new ScheduleCache(client, log, 1000);

      await cache.zone("3001");
      vi.advanceTimersByTime(1500);
      await cache.zone("3001");

      expect(client.zoneCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holt nach clear() erneut", async () => {
    const client = makeClient();
    const cache = new ScheduleCache(client, log);

    await cache.zone("3001");
    cache.clear();
    await cache.zone("3001");

    expect(client.zoneCalls).toBe(2);
  });

  it("liefert bei einem Fehler ein leeres Programm statt zu werfen", async () => {
    // Ohne Zeitprogramm bleibt immer noch ein dauerhafter Override möglich —
    // besser als die Bedienung ganz zu verweigern.
    const client = makeClient();
    client.fail = true;
    const cache = new ScheduleCache(client, log);

    await expect(cache.zone("3001")).resolves.toEqual([]);
  });

  it("merkt sich einen Fehlschlag nicht dauerhaft", async () => {
    const client = makeClient();
    client.fail = true;
    const cache = new ScheduleCache(client, log);

    expect(await cache.zone("3001")).toEqual([]);
    client.fail = false;
    expect(await cache.zone("3001")).toBe(schedule);
  });
});
