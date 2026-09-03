import { DomesticHotWaterAccessory } from "./accessories/dhw.js";
import { SystemModeAccessory } from "./accessories/systemMode.js";
import { TokenStore } from "./api/auth.js";
import { EvohomeClient } from "./api/client.js";
import { ScheduleCache } from "./api/scheduleCache.js";
import { FileTokenCache } from "./api/tokenCache.js";
import { createEveCharacteristics } from "./characteristics/eve.js";
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
 * Die Evohome-Platform.
 *
 * Gegenüber 0.11.2 eine `DynamicPlatformPlugin` statt einer Static Platform.
 * Homebridge stellt zwischengespeicherte Accessories über
 * {@link configureAccessory} wieder her, statt sie bei jedem Start neu
 * anzulegen. Zusammen mit UUIDs, die aus der `zoneId` statt aus dem
 * Array-Index gebildet werden, bleiben Raumzuordnung, Szenen und
 * Automationen erhalten (Befund S1, Issue #61).
 */
export class EvohomePlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();

  /** UUIDs, die in diesem Lauf tatsächlich verwendet werden. */
  private readonly claimed = new Set<string>();

  /** Handler, die bei jedem Statusabruf beliefert werden. */
  private readonly zoneHandlers = new Map<string, ThermostatAccessory>();
  private readonly switchHandlers = new Set<SystemModeAccessory>();
  private dhwHandler: DomesticHotWaterAccessory | undefined;

  private poller: PollingCoordinator | undefined;

  constructor(
    private readonly log: Logging,
    private readonly platformConfig: PlatformConfig,
    private readonly api: API,
  ) {
    this.api.on("didFinishLaunching", () => {
      void this.start();
    });

    this.api.on("shutdown", () => {
      // 0.11.2 hob seine Timer-Handles nie auf (Befund S11).
      this.poller?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug("Accessory aus dem Cache geladen:", accessory.displayName);
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
        `Location "${location.name}" mit ${String(location.system.zones.length)} Zone(n).`,
      );

      this.poller = new PollingCoordinator(
        client,
        location.locationId,
        config.pollIntervalSeconds,
        this.log,
      );

      this.register(location, client, this.poller, config);
      await this.poller.start();
      this.removeStaleAccessories();
    } catch (error) {
      // Anders als 0.11.2 bleiben die Accessories aus dem Cache bestehen —
      // HomeKit meldet sie als „nicht erreichbar", statt sie zu verlieren.
      this.log.error(
        `Start fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.log.info(
        "Bereits bekannte Geräte bleiben erhalten. Beim nächsten erfolgreichen Abruf wird weitergearbeitet.",
      );
    }
  }

  /**
   * Wählt die Location: bevorzugt über `locationId`, sonst über den Index.
   *
   * Der Index ist die Position in der Antwort von Honeywell — sortiert der
   * Anbieter um, zeigt die Konfiguration plötzlich auf ein anderes Haus.
   * Deshalb ist die ID der bessere Weg (Entscheidung F5).
   */
  private async findLocation(
    client: EvohomeClient,
    config: EvohomeConfig,
  ): Promise<Location> {
    const account = await client.getUserAccount();
    const locations = await client.getLocations(account.userId);

    if (locations.length === 0) {
      throw new Error("Das Honeywell-Konto enthält keine Location.");
    }

    if (config.locationId !== undefined) {
      const match = locations.find(
        (location) => location.locationId === config.locationId,
      );
      if (match !== undefined) {
        return match;
      }
      this.log.warn(
        `Keine Location mit der ID "${config.locationId}" gefunden. Verfügbar: ${locations
          .map((l) => `${l.name} (${l.locationId})`)
          .join(
            ", ",
          )}. Weiche auf locationIndex ${String(config.locationIndex)} aus.`,
      );
    }

    const byIndex = locations[config.locationIndex];
    if (byIndex === undefined) {
      throw new Error(
        `locationIndex ${String(config.locationIndex)} existiert nicht — das Konto hat ${String(locations.length)} Location(s).`,
      );
    }

    if (locations.length > 1 && config.locationId === undefined) {
      this.log.info(
        `Das Konto hat ${String(locations.length)} Locations. Verwendet wird "${byIndex.name}" (locationId ${byIndex.locationId}). Zur stabilen Zuordnung "locationId" in der config.json setzen.`,
      );
    }
    return byIndex;
  }

  private register(
    location: Location,
    client: EvohomeClient,
    poller: PollingCoordinator,
    config: EvohomeConfig,
  ): void {
    const eve = createEveCharacteristics(this.api);
    const schedules = new ScheduleCache(client, this.log);

    this.registerZones(location, client, poller, schedules, config, eve);
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
    eve: ReturnType<typeof createEveCharacteristics>,
  ): void {
    for (const zone of location.system.zones) {
      if (zone.modelType === "Unknown") {
        this.log.warn(
          `Zone "${zone.name}" hat ein unbekanntes Modell und wird übersprungen.`,
        );
        continue;
      }
      if (zone.name.trim() === "") {
        // Namenlose Zonen sind in aller Regel die Warmwasserbereitung, die
        // ein eigenes Accessory bekommt.
        this.log.debug("Zone ohne Namen übersprungen.");
        continue;
      }

      const accessory = this.accessoryFor(
        `zone:${zone.zoneId}`,
        `${zone.name} Thermostat`,
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
      // Nur anbieten, was das System auch kann — ein Schalter für einen nicht
      // unterstützten Modus führt sonst zu einer Fehlermeldung beim Drücken.
      if (!location.system.allowedSystemModes.includes(mode)) {
        this.log.debug(
          `Systemmodus ${mode} wird vom System nicht unterstützt und bekommt keinen Schalter.`,
        );
        continue;
      }

      const name = `${config.name} ${SWITCH_LABELS[mode]}`;
      const accessory = this.accessoryFor(
        `mode:${location.system.systemId}:${mode}`,
        name,
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
    const accessory = this.accessoryFor(`dhw:${dhwId}`, name);
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
   * Holt ein Accessory aus dem Cache oder legt es an.
   *
   * Die UUID entsteht aus einer stabilen Kennung — nicht mehr aus
   * `systemId + ":" + Array-Index` wie in 0.11.2, wo schon eine neue Zone bei
   * Honeywell alle nachfolgenden IDs verschob (Befund S1).
   */
  private accessoryFor(key: string, displayName: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`evohome:${key}`);
    this.claimed.add(uuid);

    const cached = this.cachedAccessories.get(uuid);
    if (cached !== undefined) {
      cached.displayName = displayName;
      this.api.updatePlatformAccessories([cached]);
      return cached;
    }

    this.log.info(`Neues Gerät: ${displayName}`);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    accessory.context["key"] = key;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
    this.cachedAccessories.set(uuid, accessory);
    return accessory;
  }

  /** Entfernt Accessories, die es bei Honeywell nicht mehr gibt. */
  private removeStaleAccessories(): void {
    const stale = [...this.cachedAccessories.entries()].filter(
      ([uuid]) => !this.claimed.has(uuid),
    );
    if (stale.length === 0) {
      return;
    }

    for (const [uuid, accessory] of stale) {
      this.log.info(`Gerät entfernt: ${accessory.displayName}`);
      this.cachedAccessories.delete(uuid);
    }
    this.api.unregisterPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      stale.map(([, accessory]) => accessory),
    );
  }
}
