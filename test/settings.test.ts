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
  it("hält PLUGIN_NAME mit package.json synchron", () => {
    const pkg = readJson("../package.json");
    expect(PLUGIN_NAME).toBe(pkg.name);
  });

  it("hält PLATFORM_NAME mit dem pluginAlias im Config-Schema synchron", () => {
    const schema = readJson("../config.schema.json");
    expect(PLATFORM_NAME).toBe(schema.pluginAlias);
  });

  it("zeigt auf die Resideo-Domain, nicht auf die abgelaufene Honeywell-Domain", () => {
    // Resideo hat das Zertifikat für tccna.honeywell.com nicht erneuert.
    expect(DEFAULT_BASE_URL).toBe("https://tccna.resideo.com");
    expect(API_PATH).toBe("/WebAPI/emea/api/v1");
  });

  it("hält das Standard-Pollingintervall über dem Minimum", () => {
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBeGreaterThanOrEqual(
      MIN_POLL_INTERVAL_SECONDS,
    );
  });
});

describe("package.json", () => {
  const pkg = readJson("../package.json");

  it("deklariert Homebridge 2 und die passenden Node-Versionen (F1, F2)", () => {
    const engines = pkg.engines as Record<string, string>;
    expect(engines.homebridge).toBe("^2.0.0");
    expect(engines.node).toBe("^22 || ^24 || ^26");
  });

  it("ist ein ESM-Paket und zeigt auf den Build", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("dist/index.js");
  });

  it("führt homebridge und hap-nodejs nicht als Laufzeitabhängigkeit", () => {
    // Homebridge warnt beim Laden, wenn ein Plugin eine eigene Kopie mitbringt
    // (homebridge/dist/plugin.js:154).
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    expect(deps).not.toHaveProperty("homebridge");
    expect(deps).not.toHaveProperty("hap-nodejs");
    expect(deps).not.toHaveProperty("@homebridge/hap-nodejs");
  });

  it("führt keine als deprecated markierten Altlasten mehr (S14)", () => {
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    for (const dead of ["request", "q", "lodash", "moment"]) {
      expect(deps).not.toHaveProperty(dead);
    }
  });

  it("hält fakegato-history optional (Entscheidung F3)", () => {
    const optional = pkg.optionalDependencies as Record<string, string>;
    expect(optional).toHaveProperty("fakegato-history");
  });
});
