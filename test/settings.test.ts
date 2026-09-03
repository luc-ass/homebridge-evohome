import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  API_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from "../src/settings.js";

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

describe("settings", () => {
  it("keeps PLUGIN_NAME in sync with package.json", () => {
    const pkg = readJson("../package.json");
    expect(PLUGIN_NAME).toBe(pkg.name);
  });

  it("keeps PLATFORM_NAME in sync with the pluginAlias in the config schema", () => {
    const schema = readJson("../config.schema.json");
    expect(PLATFORM_NAME).toBe(schema.pluginAlias);
  });

  it("points at the Resideo domain, not the expired Honeywell one", () => {
    // Resideo did not renew the certificate for tccna.honeywell.com.
    expect(DEFAULT_BASE_URL).toBe("https://tccna.resideo.com");
    expect(API_PATH).toBe("/WebAPI/emea/api/v1");
  });

  it("keeps the default polling interval above the minimum", () => {
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBeGreaterThanOrEqual(
      MIN_POLL_INTERVAL_SECONDS,
    );
  });
});

describe("package.json", () => {
  const pkg = readJson("../package.json");

  it("declares Homebridge 2 and the matching Node versions", () => {
    const engines = pkg.engines as Record<string, string>;
    expect(engines.homebridge).toBe("^2.0.0");
    expect(engines.node).toBe("^22 || ^24 || ^26");
  });

  it("is an ESM package and points at the build output", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("dist/index.js");
  });

  it("does not list homebridge or hap-nodejs as a runtime dependency", () => {
    // Homebridge warns at load time when a plugin ships its own copy
    // (homebridge/dist/plugin.js:154).
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    expect(deps).not.toHaveProperty("homebridge");
    expect(deps).not.toHaveProperty("hap-nodejs");
    expect(deps).not.toHaveProperty("@homebridge/hap-nodejs");
  });

  it("no longer carries the deprecated legacy dependencies", () => {
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    for (const dead of ["request", "q", "lodash", "moment"]) {
      expect(deps).not.toHaveProperty(dead);
    }
  });

  it("keeps fakegato-history optional", () => {
    const optional = pkg.optionalDependencies as Record<string, string>;
    expect(optional).toHaveProperty("fakegato-history");
  });
});
