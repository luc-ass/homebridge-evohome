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
 * A system mode (Away, Day Off, Eco, …) as a HomeKit switch.
 *
 * Switching off resets the system to `Auto`, the same behaviour as 0.11.2 —
 * but only from the mode that is actually active, see {@link setActive}. What
 * is new is that the switch state comes from the shared poller: previously each
 * switch accessory kept its own `active` field, updated only during
 * `periodicUpdate` and through an `else if` chain that reached at most one
 * switch per run.
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

  /**
   * Switching a mode on selects it, switching it off returns to `Auto`.
   *
   * The off case belongs to the active mode alone. HomeKit delivers a SET even
   * when the value does not change, so a scene or a Siri group command that
   * turns several mode switches off would otherwise send `Auto` from a switch
   * that was already off — a "Good night" scene silently cancelling Away.
   */
  private async setActive(value: CharacteristicValue): Promise<void> {
    if (value !== true && !this.active) {
      this.log.debug(
        `${this.name} is already off; the system mode is left alone.`,
      );
      return;
    }

    const target = value === true ? this.mode : "Auto";
    this.log.info(`System mode: ${target}.`);

    await this.client.setSystemMode(this.systemId, target, undefined);
    // Honeywell's servers need a moment before the new mode shows up in the
    // status; 0.11.2 waited three seconds here as well.
    this.poller.scheduleRefresh(REFRESH_DELAY_MS);
  }
}
