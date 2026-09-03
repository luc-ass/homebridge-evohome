import { describe, expect, it, vi } from "vitest";

import { readConfig } from "../src/config.js";
import { PLATFORM_NAME } from "../src/settings.js";
import { SETPOINT_STRATEGIES } from "../src/util/setpoint.js";
import { repoJson } from "./helpers.js";

import type { Logging, PlatformConfig } from "homebridge";

/**
 * Hält `config.schema.json` und `src/config.ts` zusammen.
 *
 * Das Formular in Config UI X und der Code, der die Werte liest, sind zwei
 * getrennte Dateien — in 0.11.2 sind sie auseinandergelaufen:
 * `temperatureAboveAsOff` stand im Schema, wurde aber nie ausgewertet
 * (Befund S6), und `childBridge` war ein Behelf, der nach dem Umbau keinen
 * Sinn mehr ergibt.
 */

interface Schema {
  pluginAlias: string;
  pluginType: string;
  singular: boolean;
  schema: {
    properties: Record<
      string,
      { type: string; default?: unknown; oneOf?: { enum: string[] }[] }
    >;
  };
  layout: unknown[];
}

const schema = repoJson("config.schema.json") as Schema;
const properties = schema.schema.properties;

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  log: vi.fn(),
} as unknown as Logging;

/** Alle im Layout referenzierten Feldnamen. */
const layoutKeys = (nodes: unknown[]): string[] =>
  nodes.flatMap((node): string[] => {
    if (typeof node === "string") {
      return [node];
    }
    if (typeof node !== "object" || node === null) {
      return [];
    }
    const record = node as { key?: unknown; items?: unknown };
    const own = typeof record.key === "string" ? [record.key] : [];
    const children = Array.isArray(record.items)
      ? layoutKeys(record.items)
      : [];
    return [...own, ...children];
  });

describe("config.schema.json", () => {
  it("passt zum Plugin-Alias und bleibt mehrfach verwendbar (F5)", () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
    expect(schema.pluginType).toBe("platform");
    // Ein Eintrag je Location — mehrere Systeme sind meist getrennte Haushalte.
    expect(schema.singular).toBe(false);
  });

  it("bietet keine Optionen mehr an, die das Plugin ignoriert", () => {
    expect(properties).not.toHaveProperty("childBridge");
    expect(properties).not.toHaveProperty("temperatureUnit");
  });

  it("zeigt jedes Feld auch im Formular an", () => {
    const inLayout = new Set(layoutKeys(schema.layout));
    for (const key of Object.keys(properties)) {
      expect(inLayout, `"${key}" fehlt im layout`).toContain(key);
    }
  });

  it("referenziert im Layout nur existierende Felder", () => {
    for (const key of layoutKeys(schema.layout)) {
      expect(
        properties,
        `layout verweist auf unbekanntes "${key}"`,
      ).toHaveProperty(key);
    }
  });

  it("listet bei setpointMode genau die unterstützten Werte (#149)", () => {
    const offered = properties["setpointMode"]?.oneOf?.flatMap(
      (entry) => entry.enum,
    );
    expect(offered).toEqual([...SETPOINT_STRATEGIES]);
  });

  it("erzwingt das Mindest-Abfrageintervall auch im Formular", () => {
    // Sonst trägt jemand 10 Sekunden ein, das Plugin hebt still an und die
    // Anzeige stimmt nicht mehr mit dem Verhalten überein.
    const poll = properties["pollIntervalSeconds"] as { minimum?: number };
    expect(poll.minimum).toBe(60);
  });

  describe("Voreinstellungen", () => {
    // Was das Formular als Standard anzeigt, muss das sein, was der Code
    // ohne Angabe verwendet.
    const fromCode = readConfig(
      {
        platform: PLATFORM_NAME,
        username: "user@example.com",
        password: "geheim",
      } satisfies PlatformConfig,
      silentLog,
    );

    it.each([
      ["name", fromCode.name],
      ["locationIndex", fromCode.locationIndex],
      ["pollIntervalSeconds", fromCode.pollIntervalSeconds],
      ["setpointMode", fromCode.setpointMode],
      ["temperatureAboveAsOff", fromCode.temperatureAboveAsOff],
      ["logTemperatureChanges", fromCode.logTemperatureChanges],
      ["switchAway", fromCode.showSwitches.Away],
      ["switchDayOff", fromCode.showSwitches.DayOff],
      ["switchEco", fromCode.showSwitches.AutoWithEco],
      ["switchHeatingOff", fromCode.showSwitches.HeatingOff],
      ["switchCustom", fromCode.showSwitches.Custom],
    ])("stimmt bei %s überein", (key, expected) => {
      expect(properties[key]?.default).toEqual(expected);
    });
  });

  it("weist im Kopftext auf die einmalige Neuzuordnung hin", () => {
    // Entscheidung F1/Variante A: der Bruch wird angekündigt, nicht kaschiert.
    const header = (schema as unknown as { headerDisplay: string })
      .headerDisplay;
    expect(header).toContain("0.11.x");
    expect(header).toContain("childBridge");
  });
});
