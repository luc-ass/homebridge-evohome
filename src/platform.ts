import { DomesticHotWaterAccessory } from "./accessories/dhw.js";
import { SystemModeAccessory } from "./accessories/systemMode.js";
import { TokenStore } from "./api/auth.js";
import { EvohomeClient } from "./api/client.js";
import { ScheduleCache } from "./api/scheduleCache.js";
import { FileTokenCache } from "./api/tokenCache.js";
import { createEveCharacteristics } from "./characteristics/eve.js";
import { loadHistoryFactory, type HistoryFactory } from "./history.js";
import {
  ConfigError,
  readConfig,
  SWITCH_LABELS,
  SWITCHABLE_MODES,
  type EvohomeConfig,
} from "./config.js";
import { ThermostatAccessory } from "./accessories/thermostat.js";
import { PollingCoordinator } from "./polling.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

import type { Location, LocationStatus } from "./api/types.js";
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from "homebridge";

/**
 * The platform instances of one bridge, keyed by the Homebridge API object.
 *
 * Homebridge keeps a single active instance per platform *name*
 * (`Plugin.getActiveDynamicPlatform`) and hands every cached accessory to that
 * one. Two "Evohome" blocks on the same bridge therefore share a cache: the
 * instance that receives it sees the other one's accessories as stale and would
 * retire them on every start. There is one API object per bridge process, so
 * this map answers whether that situation exists — a child bridge runs in its
 * own process with its own API object and its own cache file and never shares.
 */
const platformsPerBridge = new WeakMap<API, Set<EvohomePlatform>>();

/** Names every location with its ID, for the log. */
const describeLocations = (locations: readonly Location[]): string =>
  locations
    .map((location) => `${location.name} (locationId ${location.locationId})`)
    .join(", ");

const registerInstance = (api: API, platform: EvohomePlatform): void => {
  const instances = platformsPerBridge.get(api);
  if (instances === undefined) {
    platformsPerBridge.set(api, new Set([platform]));
    return;
  }
  instances.add(platform);
};

/**
 * The Evohome platform.
 *
 * A `DynamicPlatformPlugin` rather than the static platform of 0.11.2.
 * Homebridge restores cached accessories through {@link configureAccessory}
 * instead of creating them anew on every start. Together with UUIDs derived
 * from the `zoneId` rather than the array index, room assignment, scenes and
 * automations survive (issue #61).
 */
export class EvohomePlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();

  /** UUIDs actually used during this run. */
  private readonly claimed = new Set<string>();

  /** Handlers that receive every status update. */
  private readonly zoneHandlers = new Map<string, ThermostatAccessory>();
  private readonly switchHandlers = new Set<SystemModeAccessory>();
  private dhwHandler: DomesticHotWaterAccessory | undefined;

  private poller: PollingCoordinator | undefined;

  constructor(
    private readonly log: Logging,
    private readonly platformConfig: PlatformConfig,
    private readonly api: API,
  ) {
    registerInstance(this.api, this);

    this.api.on("didFinishLaunching", () => {
      void this.start();
    });

    this.api.on("shutdown", () => {
      // 0.11.2 never kept its timer handles.
      this.poller?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug("Restored accessory from cache:", accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  get cachedAccessoryCount(): number {
    return this.cachedAccessories.size;
  }

  private async start(): Promise<void> {
    let config: EvohomeConfig;
    try {
      config = readConfig(this.platformConfig, this.log);
    } catch (error) {
      if (error instanceof ConfigError) {
        this.log.error(error.message);
        return;
      }
      throw error;
    }

    this.warnAboutSiblings();

    const tokens = new TokenStore(
      config.username,
      config.password,
      new FileTokenCache(
        this.api.user.storagePath(),
        config.username,
        this.log,
      ),
    );
    const client = new EvohomeClient(tokens);

    try {
      const location = await this.findLocation(client, config);
      this.log.info(
        `Location "${location.name}" with ${String(location.system.zones.length)} zone(s).`,
      );

      this.poller = new PollingCoordinator(
        client,
        location.locationId,
        config.pollIntervalSeconds,
        this.log,
      );

      const history = await loadHistoryFactory(
        this.api,
        this.log,
        config.history,
      );
      this.register(location, client, this.poller, config, history);
      await this.poller.start();
      this.removeStaleAccessories(location.locationId);
    } catch (error) {
      // Unlike 0.11.2 the cached accessories stay: HomeKit shows them as
      // unreachable instead of losing them.
      this.log.error(
        `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.log.info(
        "Known accessories are kept. The plugin will pick up again on the next successful request.",
      );
    }
  }

  /** The other Evohome blocks on the same bridge. */
  private siblings(): readonly EvohomePlatform[] {
    return [...(platformsPerBridge.get(this.api) ?? [])].filter(
      (platform) => platform !== this,
    );
  }

  /**
   * Points out several platform blocks sharing one bridge.
   *
   * Only one of them is handed the cached accessories, so the others recreate
   * theirs on every start — the same symptom as issue #61, from a different
   * cause. A child bridge per block is the only way around it.
   */
  private warnAboutSiblings(): void {
    const siblings = this.siblings();
    if (siblings.length === 0) {
      return;
    }
    const names = siblings
      .map((platform) => `"${platform.platformConfig.name ?? PLATFORM_NAME}"`)
      .join(", ");
    this.log.warn(
      `Another Evohome block (${names}) runs on the same bridge. Homebridge hands the cached accessories to only one platform of the same name, so every other block recreates its accessories on each start and loses their rooms. Give each block its own child bridge: Homebridge UI, the plugin's menu, "Bridge Settings". Accessories belonging to another location are left untouched in the meantime.`,
    );
  }

  /**
   * Picks the location: preferably by `locationId`, otherwise by index.
   *
   * The index is the position in Honeywell's response: if they reorder it, the
   * configuration suddenly points at a different home. The ID is the safer way.
   */
  private async findLocation(
    client: EvohomeClient,
    config: EvohomeConfig,
  ): Promise<Location> {
    const account = await client.getUserAccount();
    const locations = await client.getLocations(account.userId);

    if (locations.length === 0) {
      throw new Error("The Honeywell account contains no location.");
    }

    // Every location with its ID, so a second home can be configured without
    // guessing: 0.11.2 and beta.0 only ever named the one they picked, and the
    // ID of the other one appeared nowhere.
    const summary =
      locations.length === 1
        ? `The account has one location: ${describeLocations(locations)}.`
        : `The account has ${String(locations.length)} locations: ${describeLocations(locations)}.`;

    if (config.locationId !== undefined) {
      const match = locations.find(
        (location) => location.locationId === config.locationId,
      );
      if (match !== undefined) {
        this.log.info(`${summary} Using "${match.name}".`);
        return match;
      }
      this.log.warn(
        `${summary} None of them has the configured locationId "${config.locationId}". Falling back to locationIndex ${String(config.locationIndex)}.`,
      );
    }

    const byIndex = locations[config.locationIndex];
    if (byIndex === undefined) {
      throw new Error(
        `locationIndex ${String(config.locationIndex)} does not exist. ${summary}`,
      );
    }

    if (config.locationId !== undefined) {
      return byIndex;
    }

    if (locations.length > 1) {
      this.log.info(
        `${summary} Using "${byIndex.name}" (locationId ${byIndex.locationId}). Set "locationId" in your config.json for a stable mapping; a second location needs a platform block of its own in its own child bridge.`,
      );
    } else {
      this.log.debug(summary);
    }
    return byIndex;
  }

  private register(
    location: Location,
    client: EvohomeClient,
    poller: PollingCoordinator,
    config: EvohomeConfig,
    history: HistoryFactory,
  ): void {
    const eve = createEveCharacteristics(this.api);
    const schedules = new ScheduleCache(client, this.log);

    this.registerZones(
      location,
      client,
      poller,
      schedules,
      config,
      history,
      eve,
    );
    this.registerSwitches(location, client, poller, config);

    if (location.system.dhw !== undefined) {
      this.registerDhw(
        location.system.dhw.dhwId,
        location,
        client,
        poller,
        schedules,
        config,
      );
    }

    poller.subscribe((status) => {
      this.distribute(status);
    });
  }

  private registerZones(
    location: Location,
    client: EvohomeClient,
    poller: PollingCoordinator,
    schedules: ScheduleCache,
    config: EvohomeConfig,
    history: HistoryFactory,
    eve: ReturnType<typeof createEveCharacteristics>,
  ): void {
    for (const zone of location.system.zones) {
      if (zone.modelType === "Unknown") {
        this.log.warn(
          `Zone "${zone.name}" reports an unknown model and is skipped.`,
        );
        continue;
      }
      if (zone.name.trim() === "") {
        // Unnamed zones are almost always the hot water, which gets an accessory
        // of its own.
        this.log.debug("Skipped a zone without a name.");
        continue;
      }

      const accessory = this.accessoryFor(
        `zone:${zone.zoneId}`,
        `${zone.name} Thermostat`,
        location.locationId,
      );
      this.zoneHandlers.set(
        zone.zoneId,
        new ThermostatAccessory(
          this.api,
          accessory,
          zone,
          client,
          poller,
          schedules,
          config,
          location.timeZone.currentOffsetMinutes,
          history(accessory),
          eve,
          this.log,
        ),
      );
    }
  }

  private registerSwitches(
    location: Location,
    client: EvohomeClient,
    poller: PollingCoordinator,
    config: EvohomeConfig,
  ): void {
    for (const mode of SWITCHABLE_MODES) {
      if (!config.showSwitches[mode]) {
        continue;
      }
      // Only offer what the system supports; a switch for an unsupported mode
      // would just produce an error when pressed.
      if (!location.system.allowedSystemModes.includes(mode)) {
        this.log.debug(
          `System mode ${mode} is not supported by this system; no switch created.`,
        );
        continue;
      }

      const name = `${config.name} ${SWITCH_LABELS[mode]}`;
      const accessory = this.accessoryFor(
        `mode:${location.system.systemId}:${mode}`,
        name,
        location.locationId,
      );
      this.switchHandlers.add(
        new SystemModeAccessory(
          this.api,
          accessory,
          location.system.systemId,
          mode,
          name,
          client,
          poller,
          this.log,
        ),
      );
    }
  }

  private registerDhw(
    dhwId: string,
    location: Location,
    client: EvohomeClient,
    poller: PollingCoordinator,
    schedules: ScheduleCache,
    config: EvohomeConfig,
  ): void {
    const name = `${config.name} Hot Water`;
    const accessory = this.accessoryFor(
      `dhw:${dhwId}`,
      name,
      location.locationId,
    );
    this.dhwHandler = new DomesticHotWaterAccessory(
      this.api,
      accessory,
      dhwId,
      name,
      client,
      poller,
      schedules,
      config,
      location.timeZone.currentOffsetMinutes,
      this.log,
    );
  }

  private distribute(status: LocationStatus): void {
    for (const zone of status.zones) {
      this.zoneHandlers.get(zone.zoneId)?.update(zone);
    }
    for (const handler of this.switchHandlers) {
      handler.update(status.systemModeStatus);
    }
    if (status.dhw !== undefined) {
      this.dhwHandler?.update(status.dhw);
    }
  }

  /**
   * Fetches an accessory from the cache or creates it.
   *
   * The UUID is built from a stable identifier, no longer from
   * `systemId + ":" + array index` as in 0.11.2, where a single new zone at
   * Honeywell shifted every following ID.
   */
  private accessoryFor(
    key: string,
    displayName: string,
    locationId: string,
  ): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`evohome:${key}`);
    this.claimed.add(uuid);

    const cached = this.cachedAccessories.get(uuid);
    if (cached !== undefined) {
      cached.displayName = displayName;
      // Records which location an accessory belongs to; see
      // `platformsPerBridge` and `removeStaleAccessories`.
      cached.context["locationId"] = locationId;
      this.api.updatePlatformAccessories([cached]);
      return cached;
    }

    this.log.info(`New accessory: ${displayName}`);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    accessory.context["key"] = key;
    accessory.context["locationId"] = locationId;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
    this.cachedAccessories.set(uuid, accessory);
    return accessory;
  }

  /**
   * Removes accessories that no longer exist at Honeywell.
   *
   * With another block on the same bridge the cache also holds accessories of
   * that block's location. They are not stale, they are simply not ours, and
   * deleting them would make both blocks fight over the cache on every start.
   */
  private removeStaleAccessories(locationId: string): void {
    const shared = this.siblings().length > 0;
    const stale = [...this.cachedAccessories.entries()].filter(
      ([uuid, accessory]) => {
        if (this.claimed.has(uuid)) {
          return false;
        }
        const owner: unknown = accessory.context["locationId"];
        if (shared && typeof owner === "string" && owner !== locationId) {
          this.log.debug(
            `Keeping ${accessory.displayName}: it belongs to location ${owner}.`,
          );
          return false;
        }
        return true;
      },
    );
    if (stale.length === 0) {
      return;
    }

    for (const [uuid, accessory] of stale) {
      this.log.info(`Removed accessory: ${accessory.displayName}`);
      this.cachedAccessories.delete(uuid);
    }
    this.api.unregisterPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      stale.map(([, accessory]) => accessory),
    );
  }
}
