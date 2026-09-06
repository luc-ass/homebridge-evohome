import type { API } from "homebridge";
import { describe, expect, it, vi } from "vitest";

import registerPlugin from "../src/index.js";
import { EvohomePlatform } from "../src/platform.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "../src/settings.js";

describe("plugin entry point", () => {
  it("registers the platform under the expected alias", () => {
    const registerPlatform = vi.fn();
    registerPlugin({ registerPlatform } as unknown as API);

    expect(registerPlatform).toHaveBeenCalledOnce();
    expect(registerPlatform).toHaveBeenCalledWith(
      PLUGIN_NAME,
      PLATFORM_NAME,
      EvohomePlatform,
    );
  });
});

describe("EvohomePlatform", () => {
  const makeApi = (): { api: API; handlers: Map<string, () => void> } => {
    const handlers = new Map<string, () => void>();
    const api = {
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
        return api;
      },
    } as unknown as API;
    return { api, handlers };
  };

  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  it("subscribes to didFinishLaunching and shutdown", () => {
    const { api, handlers } = makeApi();
    new EvohomePlatform(
      log as never,
      { platform: PLATFORM_NAME, name: "Evohome" },
      api,
    );

    expect([...handlers.keys()]).toEqual(["didFinishLaunching", "shutdown"]);
  });

  it("accepts cached accessories", () => {
    const { api } = makeApi();
    const platform = new EvohomePlatform(
      log as never,
      { platform: PLATFORM_NAME, name: "Evohome" },
      api,
    );

    expect(platform.cachedAccessoryCount).toBe(0);

    platform.configureAccessory({
      UUID: "uuid-a",
      displayName: "Kitchen Thermostat",
    } as never);
    platform.configureAccessory({
      UUID: "uuid-b",
      displayName: "Bad Thermostat",
    } as never);
    // The same UUID must not be counted twice.
    platform.configureAccessory({
      UUID: "uuid-a",
      displayName: "Kitchen Thermostat",
    } as never);

    expect(platform.cachedAccessoryCount).toBe(2);
  });
});
