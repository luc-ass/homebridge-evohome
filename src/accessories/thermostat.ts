import { REFRESH_DELAY_MS } from "../settings.js";
import { nextSwitchpoint } from "../util/schedule.js";
import { decideOverride } from "../util/setpoint.js";

import type { ScheduleCache } from "../api/scheduleCache.js";
import type { HistoryService } from "../history.js";
import type { EvohomeClient } from "../api/client.js";
import type { SetpointCapabilities, Zone, ZoneStatus } from "../api/types.js";
import type { EvohomeConfig } from "../config.js";
import type { EveCharacteristics } from "../characteristics/eve.js";
import type { PollingCoordinator } from "../polling.js";
import type {
  API,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from "homebridge";

/**
 * Eine Heizzone als HomeKit-Thermostat.
 *
 * Wesentliche Unterschiede zu 0.11.2:
 *
 * - Werte kommen aus dem Cache des {@link PollingCoordinator}; im
 *   HomeKit-Lesepfad findet keine API-Anfrage mehr statt.
 * - Sollwerte werden auf `setpointCapabilities` geklemmt. 0.11.2 schrieb zum
 *   Ausschalten pauschal 5 °C, was bei einer Zone mit `minHeatSetpoint: 10`
 *   die Warnung aus Issue #94 auslöste (Befund B6).
 * - „Aus" wird über `TargetHeatingCoolingState` abgebildet, nicht über einen
 *   Sollwert unterhalb des erlaubten Bereichs.
 * - `updateValue()` statt des in HAP 2.x entfernten `getValue()` (Befund B3).
 */

/** Klemmt einen Sollwert in den vom System erlaubten Bereich. */
export const clampSetpoint = (
  value: number,
  capabilities: SetpointCapabilities,
): number => {
  const { minHeatSetpoint, maxHeatSetpoint, valueResolution } = capabilities;
  const bounded = Math.min(maxHeatSetpoint, Math.max(minHeatSetpoint, value));
  if (valueResolution <= 0) {
    return bounded;
  }
  const stepped = Math.round(bounded / valueResolution) * valueResolution;
  // Runden kann minimal über die Grenze schießen.
  const clamped = Math.min(maxHeatSetpoint, Math.max(minHeatSetpoint, stepped));
  // Gleitkommareste wie 20.500000000000004 vermeiden.
  return Math.round(clamped * 100) / 100;
};

export class ThermostatAccessory {
  private readonly service: Service;
  private readonly log: Logging;
  private status: ZoneStatus | undefined;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly zone: Zone,
    private readonly client: EvohomeClient,
    private readonly poller: PollingCoordinator,
    private readonly schedules: ScheduleCache,
    private readonly config: EvohomeConfig,
    /** Aktueller UTC-Offset der Location, für die Schaltpunkte. */
    private readonly offsetMinutes: number,
    /** Eve-Verlauf, falls aktiviert und verfügbar (Entscheidung F3). */
    private readonly history: HistoryService | undefined,
    eve: EveCharacteristics,
    log: Logging,
  ) {
    this.log = log;
    const { Service, Characteristic } = this.api.hap;

    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Honeywell")
      .setCharacteristic(Characteristic.Model, this.zone.modelType)
      .setCharacteristic(Characteristic.SerialNumber, this.zone.zoneId);

    this.service =
      this.accessory.getService(Service.Thermostat) ??
      this.accessory.addService(Service.Thermostat);

    this.service.setCharacteristic(Characteristic.Name, this.zone.name);

    // CurrentTemperature bewusst mit den HAP-Vorgaben: 0.11.2 setzte hier
    // 1–50 °C mit der Schrittweite des Ventils, wodurch legitime Messwerte
    // außerhalb dieses Fensters abgelehnt wurden.
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.currentTemperature());

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.zone.setpointCapabilities.minHeatSetpoint,
        maxValue: this.zone.setpointCapabilities.maxHeatSetpoint,
        minStep: this.zone.setpointCapabilities.valueResolution,
      })
      .onGet(() => this.targetTemperature())
      .onSet((value) => this.setTargetTemperature(value));

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => this.currentState());

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
          Characteristic.TargetHeatingCoolingState.AUTO,
        ],
      })
      .onGet(() => this.targetState())
      .onSet((value) => this.setTargetState(value));

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);

    // Eve zeigt die Ventilstellung im Verlauf an. Der Wert ist abgeleitet —
    // die API liefert keine echte Ventilposition.
    //
    // Erst als optional anmelden: getCharacteristic() legt eine unbekannte
    // Characteristic zwar selbst an, schreibt dabei aber eine Warnung
    // ("Adding anyway") ins Log jedes Nutzers.
    this.service.addOptionalCharacteristic(eve.ValvePosition);
    this.service
      .getCharacteristic(eve.ValvePosition)
      .onGet(() => this.valvePosition());
  }

  /** Übernimmt einen frisch gelesenen Status und meldet Änderungen an HomeKit. */
  update(status: ZoneStatus): void {
    const previous = this.status;
    this.status = status;
    const { Characteristic } = this.api.hap;

    if (status.activeFaults.length > 0 && previous?.activeFaults.length === 0) {
      this.log.warn(`${this.zone.name}: ${status.activeFaults.join(", ")}`);
    }

    const temperature = status.temperatureStatus.temperature;
    if (temperature !== undefined) {
      this.logTemperatureChange(
        previous?.temperatureStatus.temperature,
        temperature,
      );
      this.service
        .getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(temperature);
    }

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .updateValue(this.targetTemperature());
    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .updateValue(this.currentState());
    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(this.targetState());

    this.recordHistory(status);
  }

  /**
   * Schreibt einen Messpunkt in den Eve-Verlauf.
   *
   * Nur mit echtem Messwert: 0.11.2 schrieb auch dann einen Eintrag, wenn die
   * Zone gar keine Temperatur meldete, und erzeugte damit Lücken bzw. Nullen
   * in der Kurve.
   */
  private recordHistory(status: ZoneStatus): void {
    const currentTemp = status.temperatureStatus.temperature;
    if (this.history === undefined || currentTemp === undefined) {
      return;
    }
    this.history.addEntry({
      time: Math.floor(Date.now() / 1000),
      currentTemp,
      setTemp: status.setpointStatus.targetHeatTemperature,
      valvePosition: this.valvePosition(),
    });
  }

  /**
   * Protokolliert Änderungen der Ist-Temperatur, wenn gewünscht.
   *
   * Issue #146: Beim Entschlacken des Logs war diese Zeile auf `debug`
   * gerutscht. Sie ist nützlich, um im Nachhinein zu sehen, warum es morgens
   * kalt war — aber nicht für jeden.
   */
  private logTemperatureChange(
    previous: number | undefined,
    current: number,
  ): void {
    if (!this.config.logTemperatureChanges || previous === undefined) {
      return;
    }
    if (previous === current) {
      return;
    }
    const direction = current > previous ? "gestiegen" : "gefallen";
    this.log.info(
      `${this.zone.name}: Temperatur ${direction} von ${String(previous)} °C auf ${String(current)} °C.`,
    );
  }

  /** Der zuletzt bekannte Status — für die History in Phase 4. */
  get lastStatus(): ZoneStatus | undefined {
    return this.status;
  }

  private required(): ZoneStatus {
    if (this.status === undefined) {
      // HomeKit bekommt einen sauberen Fehler statt eines erfundenen Werts.
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return this.status;
  }

  private currentTemperature(): number {
    const temperature = this.required().temperatureStatus.temperature;
    if (temperature === undefined) {
      // Zone meldet keinen Messwert, etwa bei leerer Batterie. 0.11.2 reichte
      // hier undefined durch, woraus HomeKit "received NaN" machte (#94).
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return temperature;
  }

  private targetTemperature(): number {
    return clampSetpoint(
      this.required().setpointStatus.targetHeatTemperature,
      this.zone.setpointCapabilities,
    );
  }

  /** Heizt die Zone gerade? */
  private currentState(): number {
    const { CurrentHeatingCoolingState } = this.api.hap.Characteristic;
    const status = this.required();
    const current = status.temperatureStatus.temperature;
    const target = status.setpointStatus.targetHeatTemperature;

    if (current === undefined) {
      return CurrentHeatingCoolingState.OFF;
    }
    return current < target
      ? CurrentHeatingCoolingState.HEAT
      : CurrentHeatingCoolingState.OFF;
  }

  /**
   * Was der Nutzer eingestellt hat.
   *
   * `AUTO` steht für „folgt dem Zeitprogramm", `HEAT` für einen aktiven
   * Override, `OFF` für einen Sollwert auf dem Minimum des Systems.
   */
  private targetState(): number {
    const { TargetHeatingCoolingState } = this.api.hap.Characteristic;
    const status = this.required();
    const { minHeatSetpoint } = this.zone.setpointCapabilities;

    if (status.setpointStatus.targetHeatTemperature <= minHeatSetpoint) {
      return TargetHeatingCoolingState.OFF;
    }

    if (
      this.config.temperatureAboveAsOff &&
      status.temperatureStatus.temperature !== undefined &&
      status.setpointStatus.targetHeatTemperature <=
        status.temperatureStatus.temperature
    ) {
      // Befund S6: In 0.11.2 wurde diese Option nie an das Accessory
      // durchgereicht und war deshalb wirkungslos.
      return TargetHeatingCoolingState.OFF;
    }

    return status.setpointStatus.setpointMode === "FollowSchedule"
      ? TargetHeatingCoolingState.AUTO
      : TargetHeatingCoolingState.HEAT;
  }

  private valvePosition(): number {
    return this.currentState() ===
      this.api.hap.Characteristic.CurrentHeatingCoolingState.HEAT
      ? 100
      : 0;
  }

  private async setTargetTemperature(
    value: CharacteristicValue,
  ): Promise<void> {
    const target = clampSetpoint(Number(value), this.zone.setpointCapabilities);
    const now = new Date();

    // Issue #149: Läuft bereits ein befristeter Override, wird bei der
    // Voreinstellung `keepExistingUntil` dessen Endzeit übernommen, statt sie
    // durch den nächsten Schaltpunkt zu ersetzen.
    const decision = decideOverride(
      this.config.setpointMode,
      this.required().setpointStatus,
      await this.nextSwitchpoint(now),
      now,
    );

    this.log.info(
      `${this.zone.name}: Solltemperatur auf ${String(target)} °C, ${decision.reason}.`,
    );
    await this.client.setHeatSetpoint(
      this.zone.zoneId,
      decision.mode,
      target,
      decision.until,
    );
    this.poller.scheduleRefresh(REFRESH_DELAY_MS);
  }

  /**
   * Nächster Schaltpunkt des Zeitprogramms dieser Zone.
   *
   * Bei `permanent` wird das Zeitprogramm gar nicht erst abgefragt — der
   * Aufruf wäre reine Last auf den Honeywell-Servern.
   */
  private async nextSwitchpoint(now: Date): Promise<Date | undefined> {
    if (this.config.setpointMode === "permanent") {
      return undefined;
    }
    const schedule = await this.schedules.zone(this.zone.zoneId);
    return nextSwitchpoint(schedule, now, this.offsetMinutes)?.at;
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { TargetHeatingCoolingState } = this.api.hap.Characteristic;
    const { minHeatSetpoint } = this.zone.setpointCapabilities;

    if (value === TargetHeatingCoolingState.OFF) {
      // Auf das Minimum des Systems statt auf feste 5 °C (Befund B6, #94).
      this.log.info(
        `${this.zone.name}: aus (Sollwert ${String(minHeatSetpoint)} °C).`,
      );
      await this.client.setHeatSetpoint(
        this.zone.zoneId,
        "PermanentOverride",
        minHeatSetpoint,
        undefined,
      );
    } else if (value === TargetHeatingCoolingState.AUTO) {
      this.log.info(`${this.zone.name}: folgt wieder dem Zeitprogramm.`);
      await this.client.setHeatSetpoint(
        this.zone.zoneId,
        "FollowSchedule",
        undefined,
        undefined,
      );
    } else {
      // HEAT bei bereits aktivem Override bedeutet: nichts ändern. Nur aus
      // dem Aus-Zustand heraus wird der Override aufgehoben.
      if (this.targetState() !== TargetHeatingCoolingState.OFF) {
        return;
      }
      this.log.info(
        `${this.zone.name}: Heizen wieder aktiv, Override aufgehoben.`,
      );
      await this.client.setHeatSetpoint(
        this.zone.zoneId,
        "FollowSchedule",
        undefined,
        undefined,
      );
    }

    this.poller.scheduleRefresh(REFRESH_DELAY_MS);
  }
}
