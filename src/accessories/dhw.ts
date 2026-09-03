import { REFRESH_DELAY_MS } from "../settings.js";
import { nextSwitchpoint } from "../util/schedule.js";
import { decideOverride } from "../util/setpoint.js";

import type { ScheduleCache } from "../api/scheduleCache.js";
import type { EvohomeClient } from "../api/client.js";
import type { DhwStatus } from "../api/types.js";
import type { EvohomeConfig } from "../config.js";
import type { PollingCoordinator } from "../polling.js";
import type {
  API,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from "homebridge";

/**
 * Warmwasserbereitung als Temperatursensor mit Schalter.
 *
 * Zwei Fehler aus 0.11.2 verschwinden hier strukturell:
 *
 * - `setHotWaterStatus` rief seinen Callback **nur im Fehlerfall** auf. Aus
 *   HomeKit-Sicht antwortete das Accessory bei Erfolg nie, was nach etwa 15 s
 *   in einen Timeout lief — das „Error Action Set Failed" aus Issue #180.
 *   Mit `onSet` erledigt das die Promise.
 * - `periodicCheckStatus` lief über `setInterval` ohne Argument, rief im
 *   Fehlerfall aber `callback(err)` und starb an
 *   `callback is not a function` (Befund S7). Der Status kommt jetzt aus dem
 *   gemeinsamen Poller, ganz ohne eigenen Timer.
 */
export class DomesticHotWaterAccessory {
  private readonly sensor: Service;
  private readonly toggle: Service;
  private status: DhwStatus | undefined;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly dhwId: string,
    private readonly name: string,
    private readonly client: EvohomeClient,
    private readonly poller: PollingCoordinator,
    private readonly schedules: ScheduleCache,
    private readonly config: EvohomeConfig,
    /** Aktueller UTC-Offset der Location, für die Schaltpunkte. */
    private readonly offsetMinutes: number,
    private readonly log: Logging,
  ) {
    const { Service, Characteristic } = this.api.hap;

    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Honeywell")
      .setCharacteristic(Characteristic.Model, "DomesticHotWater")
      .setCharacteristic(Characteristic.SerialNumber, this.dhwId);

    this.sensor =
      this.accessory.getService(Service.TemperatureSensor) ??
      this.accessory.addService(Service.TemperatureSensor, this.name);
    this.sensor.setPrimaryService(true);
    this.sensor
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.temperature());

    this.toggle =
      this.accessory.getService(Service.Switch) ??
      this.accessory.addService(Service.Switch, this.name, "dhw-toggle");
    this.toggle
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.isOn())
      .onSet((value) => this.setOn(value));
  }

  update(status: DhwStatus): void {
    this.status = status;
    const { Characteristic } = this.api.hap;

    const temperature = status.temperatureStatus.temperature;
    if (temperature !== undefined) {
      this.sensor
        .getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(temperature);
    }
    this.toggle
      .getCharacteristic(Characteristic.On)
      .updateValue(status.state === "On");
  }

  get lastStatus(): DhwStatus | undefined {
    return this.status;
  }

  private required(): DhwStatus {
    if (this.status === undefined) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return this.status;
  }

  private temperature(): number {
    const temperature = this.required().temperatureStatus.temperature;
    if (temperature === undefined) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return temperature;
  }

  private isOn(): boolean {
    return this.required().state === "On";
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const state = value === true ? "On" : "Off";
    const now = new Date();

    // Warmwasser folgt derselben Regel wie die Heizzonen (Issue #149).
    const decision = decideOverride(
      this.config.setpointMode,
      { setpointMode: this.required().mode, until: this.required().until },
      await this.nextSwitchpoint(now),
      now,
    );

    this.log.info(`Hot water: ${state}, ${decision.reason}.`);
    await this.client.setDhwState(
      this.dhwId,
      decision.mode,
      state,
      decision.until,
    );
    this.poller.scheduleRefresh(REFRESH_DELAY_MS);
  }

  private async nextSwitchpoint(now: Date): Promise<Date | undefined> {
    if (this.config.setpointMode === "permanent") {
      return undefined;
    }
    const schedule = await this.schedules.dhw(this.dhwId);
    return nextSwitchpoint(schedule, now, this.offsetMinutes)?.at;
  }
}
