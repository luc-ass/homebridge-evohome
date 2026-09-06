import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as hap from "@homebridge/hap-nodejs";
import { vi } from "vitest";

import type { API, Logging, PlatformAccessory } from "homebridge";

/**
 * Test double for the Homebridge API, backed by the **real** HAP from
 * `@homebridge/hap-nodejs` that Homebridge 2.x uses in production.
 *
 * That is the point: a hand-rolled HAP stub would never have surfaced the crash
 * from issue #205. Against the real HAP, a custom characteristic built as a
 * function instead of an ES class fails immediately, exactly as in Homebridge 2.
 *
 * Only what Homebridge itself contributes is reimplemented: the
 * `PlatformAccessory` wrapper and the registration functions.
 */

/** Homebridge's PlatformAccessory, backed by a real HAP accessory. */
class TestPlatformAccessory {
  readonly context: Record<string, unknown> = {};
  private readonly accessory: hap.Accessory;

  constructor(
    public displayName: string,
    readonly UUID: string,
  ) {
    this.accessory = new hap.Accessory(displayName, UUID);
  }

  get services(): hap.Service[] {
    return this.accessory.services;
  }

  addService(...args: Parameters<hap.Accessory["addService"]>): hap.Service {
    return this.accessory.addService(...args);
  }

  getService(
    ...args: Parameters<hap.Accessory["getService"]>
  ): hap.Service | undefined {
    return this.accessory.getService(...args);
  }

  getServiceById(
    ...args: Parameters<hap.Accessory["getServiceById"]>
  ): hap.Service | undefined {
    return this.accessory.getServiceById(...args);
  }

  removeService(service: hap.Service): void {
    this.accessory.removeService(service);
  }
}

export interface TestApi {
  readonly api: API;
  /** Fires a Homebridge lifecycle event. */
  emit(event: "didFinishLaunching" | "shutdown"): void;
  readonly registered: PlatformAccessory[];
  readonly unregistered: PlatformAccessory[];
  readonly storagePath: string;
}

export const createTestApi = (): TestApi => {
  const emitter = new EventEmitter();
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];
  const storagePath = mkdtempSync(join(tmpdir(), "evohome-test-"));

  const api = {
    hap,
    version: 2.0,
    serverVersion: "2.4.0",
    platformAccessory: TestPlatformAccessory,
    user: { storagePath: () => storagePath },
    on(event: string, handler: () => void) {
      emitter.on(event, handler);
      return api;
    },
    registerPlatform: vi.fn(),
    registerAccessory: vi.fn(),
    registerPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => registered.push(...accessories),
    unregisterPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => unregistered.push(...accessories),
    updatePlatformAccessories: vi.fn(),
    publishExternalAccessories: vi.fn(),
  } as unknown as API;

  return {
    api,
    emit: (event) => {
      emitter.emit(event);
    },
    registered,
    unregistered,
    storagePath,
  };
};

/** Logger that collects its output for assertions. */
export interface TestLog extends Logging {
  readonly infos: string[];
  readonly warnings: string[];
  readonly errors: string[];
}

export const createTestLog = (): TestLog => {
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warnings,
    errors,
    info: (m: string) => infos.push(m),
    warn: (m: string) => warnings.push(m),
    error: (m: string) => errors.push(m),
    debug: vi.fn(),
    success: vi.fn(),
    log: vi.fn(),
  } as unknown as TestLog;
};

export { hap };
