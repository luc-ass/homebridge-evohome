import { describe, expect, it, vi } from "vitest";

import { readConfig } from "../src/config.js";
import { PLATFORM_NAME } from "../src/settings.js";
import { SETPOINT_STRATEGIES } from "../src/util/setpoint.js";
import { repoJson } from "./helpers.js";

import type { Logging, PlatformConfig } from "homebridge";

/**
 * Keeps `config.schema.json` and `src/config.ts` in step.
 *
 * The form in the Homebridge UI and the code that reads the values are two
 * separate files, and in 0.11.2 they drifted apart: `temperatureAboveAsOff` was
 * in the schema but never evaluated, and `childBridge` was a workaround that no
 * longer makes sense after the rewrite.
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

/** Every field name referenced from the layout. */
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
  it("matches the plugin alias and stays usable more than once", () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
    expect(schema.pluginType).toBe("platform");
    // One entry per location; several systems are usually separate households.
    expect(schema.singular).toBe(false);
  });

  it("no longer offers options the plugin ignores", () => {
    expect(properties).not.toHaveProperty("childBridge");
    expect(properties).not.toHaveProperty("temperatureUnit");
  });

  it("shows every field in the form as well", () => {
    const inLayout = new Set(layoutKeys(schema.layout));
    for (const key of Object.keys(properties)) {
      expect(inLayout, `"${key}" is missing from the layout`).toContain(key);
    }
  });

  it("only references existing fields from the layout", () => {
    for (const key of layoutKeys(schema.layout)) {
      expect(
        properties,
        `layout references unknown field "${key}"`,
      ).toHaveProperty(key);
    }
  });

  it("lists exactly the supported values for setpointMode (#149)", () => {
    const offered = properties["setpointMode"]?.oneOf?.flatMap(
      (entry) => entry.enum,
    );
    expect(offered).toEqual([...SETPOINT_STRATEGIES]);
  });

  it("enforces the minimum polling interval in the form too", () => {
    // Otherwise somebody enters 10 seconds, the plugin silently raises it and the
    // form no longer matches the behaviour.
    const poll = properties["pollIntervalSeconds"] as { minimum?: number };
    expect(poll.minimum).toBe(60);
  });

  describe("defaults", () => {
    // What the form shows as the default must be what the code uses when the
    // value is absent.
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
    ])("matches for %s", (key, expected) => {
      expect(properties[key]?.default).toEqual(expected);
    });
  });

  it("mentions the one-off reassignment in the header text", () => {
    // The break is announced rather than glossed over.
    const header = (schema as unknown as { headerDisplay: string })
      .headerDisplay;
    expect(header).toContain("0.11.x");
    expect(header).toContain("childBridge");
  });
});
