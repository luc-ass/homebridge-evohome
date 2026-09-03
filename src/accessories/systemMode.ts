import { REFRESH_DELAY_MS } from "../settings.js";

import type { EvohomeClient } from "../api/client.js";
import type { SystemModeStatus } from "../api/types.js";
import type { SwitchableMode } from "../config.js";
import type { PollingCoordinator } from "../polling.js";
import type {
  API,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from "homebridge";

/**
 * Ein Systemmodus (Away, Day Off, Eco, …) als HomeKit-Schalter.
 *
 * Ausschalten setzt das System zurück auf `Auto` — dasselbe Verhalten wie in
 * 0.11.2. Neu ist, dass der Schalterzustand aus dem gemeinsamen Poller kommt:
 * vorher pflegte jedes Switch-Accessory ein eigenes `active`-Feld, das nur
 * beim Durchlauf von `periodicUpdate` nachgezogen wurde und dabei über eine
 * `else if`-Kette lief, die höchstens einen Schalter pro Durchlauf traf.
 */
export class SystemModeAccessory {
  private readonly service: Service;
  private active = false;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly systemId: string,
    private readonly mode: SwitchableMode,
    private readonly name: string,
    private readonly client: EvohomeClient,
    private readonly poller: PollingCoordinator,
    private readonly log: Logging,
  ) {
    const { Service, Characteristic } = this.api.hap;

    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Honeywell")
      .setCharacteristic(Characteristic.Model, "SystemMode")
      .setCharacteristic(
        Characteristic.SerialNumber,
        `${this.systemId}-${this.mode}`,
      );

    this.service =
      this.accessory.getService(Service.Switch) ??
      this.accessory.addService(Service.Switch);
    this.service.setCharacteristic(Characteristic.Name, this.name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.active)
      .onSet((value) => this.setActive(value));
  }

  update(status: SystemModeStatus): void {
    this.active = status.mode === this.mode;
    this.service
      .getCharacteristic(this.api.hap.Characteristic.On)
      .updateValue(this.active);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const target = value === true ? this.mode : "Auto";
    this.log.info(`Systemmodus: ${target}.`);

    await this.client.setSystemMode(this.systemId, target, undefined);
    // Die Honeywell-Server brauchen einen Moment, bis der neue Modus im
    // Status auftaucht — 0.11.2 wartete dafür ebenfalls drei Sekunden.
    this.poller.scheduleRefresh(REFRESH_DELAY_MS);
  }
}
