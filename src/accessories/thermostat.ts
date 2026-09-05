import { REFRESH_DELAY_MS } from "../settings.js";
import { batteryLevel, faultKey, summarizeFaults } from "../util/faults.js";
import { nextSwitchpoint } from "../util/schedule.js";
import { decideOverride, needsSwitchpoint } from "../util/setpoint.js";

import type { ScheduleCache } from "../api/scheduleCache.js";
import type { HistoryService } from "../history.js";
import type { EvohomeClient } from "../api/client.js";
import type { SetpointCapabilities, Zone, ZoneStatus } from "../api/types.js";
import type { EvohomeConfig } from "../config.js";
import type { EveCharacteristics } from "../characteristics/eve.js";
import type { PollingCoordinator } from "../polling.js";
import type { CurrentOverride } from "../util/setpoint.js";
import type {
  API,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from "homebridge";

/**
 * A heating zone exposed as a HomeKit thermostat.
 *
 * Key differences to 0.11.2:
 *
 * - Values come from the {@link PollingCoordinator} cache; the HomeKit read path
 *   no longer performs an API request.
 * - Setpoints are clamped to `setpointCapabilities`. 0.11.2 wrote a flat 5 °C to
 *   turn a zone off, which triggered the warning from issue #94 on a zone with
 *   `minHeatSetpoint: 10`.
 * - "Off" is expressed through `TargetHeatingCoolingState`, not through a
 *   setpoint below the allowed range.
 * - `updateValue()` instead of `getValue()`, which HAP 2.x removed.
 */

/** Clamps a setpoint into the range the system allows. */
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
  // Rounding can overshoot the bound slightly.
  const clamped = Math.min(maxHeatSetpoint, Math.max(minHeatSetpoint, stepped));
  // Avoid floating point residue such as 20.500000000000004.
  return Math.round(clamped * 100) / 100;
};

export class ThermostatAccessory {
  private readonly service: Service;
  private readonly battery: Service;
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
    /**
     * Current UTC offset of the location, asked for on every use.
     *
     * A number captured at startup was an hour wrong from the next daylight
     * saving change until Homebridge restarted, and every override end time
     * with it (issue #217).
     */
    private readonly offsetMinutes: () => number,
    /** Eve history, if enabled and available. */
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

    // CurrentTemperature deliberately keeps the HAP defaults: 0.11.2 set 1–50 °C
    // with the valve's step size here, which rejected legitimate readings
    // outside that window.
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

    // `activeFaults` used to end up in the log only, where nobody looks. A lost
    // radio link to an actuator now reaches the Home app as well.
    //
    // StatusFault is not among the thermostat service's optional
    // characteristics, so it has to be registered explicitly — as with the Eve
    // characteristic below, getCharacteristic() would add it by itself but write
    // an "Adding anyway" warning into the log while doing so.
    this.service.addOptionalCharacteristic(Characteristic.StatusFault);
    this.service
      .getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.statusFault());

    // Every zone gets a battery service, including the mains-powered ones
    // (`ZoneValves`, `ElectricHeat`). Those simply never report a battery
    // fault, which costs nothing; leaving out the service would need a
    // zone-type allowlist that goes stale the moment Resideo adds a model.
    //
    // `BatteryLevel` carries the two levels from batteryLevel(): beta.1 left it
    // out, and clients showed the missing value as "0 %, Charged" (#205).
    // `ChargingState` never changes — an HR92 runs on AA cells.
    this.battery =
      this.accessory.getService(Service.Battery) ??
      this.accessory.addService(Service.Battery, `${this.zone.name} Battery`);
    this.battery
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.statusLowBattery());
    this.battery
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.batteryLevel());
    this.battery
      .getCharacteristic(Characteristic.ChargingState)
      .updateValue(Characteristic.ChargingState.NOT_CHARGEABLE);

    // Eve shows the valve position in its history. The value is derived; the API
    // reports no real valve position.
    //
    // Register it as optional first: getCharacteristic() would add an unknown
    // characteristic by itself, but writes an "Adding anyway" warning into
    // every user's log while doing so.
    this.service.addOptionalCharacteristic(eve.ValvePosition);
    this.service
      .getCharacteristic(eve.ValvePosition)
      .onGet(() => this.valvePosition());
  }

  /** Takes a freshly read status and pushes the changes to HomeKit. */
  update(status: ZoneStatus): void {
    const previous = this.status;
    this.status = status;
    const { Characteristic } = this.api.hap;

    this.logFaultChange(previous?.activeFaults, status.activeFaults);

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
    this.service
      .getCharacteristic(Characteristic.StatusFault)
      .updateValue(this.statusFault());
    this.battery
      .getCharacteristic(Characteristic.StatusLowBattery)
      .updateValue(this.statusLowBattery());
    this.battery
      .getCharacteristic(Characteristic.BatteryLevel)
      .updateValue(this.batteryLevel());

    this.recordHistory(status);
  }

  /**
   * Logs faults whenever the set of them changes.
   *
   * The earlier condition was `previous?.activeFaults.length === 0`, which is
   * never true on the first update because `previous` is undefined then: a zone
   * whose battery was already flat when Homebridge started stayed silent
   * forever. Recovery was never reported either.
   */
  private logFaultChange(
    previous: readonly string[] | undefined,
    current: readonly string[],
  ): void {
    if (faultKey(previous ?? []) === faultKey(current)) {
      return;
    }
    if (current.length === 0) {
      this.log.info(`${this.zone.name}: no active faults any more.`);
      return;
    }
    this.log.warn(`${this.zone.name}: ${current.join(", ")}.`);
  }

  /**
   * Fault state for HomeKit.
   *
   * Unlike the other getters this one does not throw before the first poll.
   * `StatusFault` has no "unknown" value, and answering NO_FAULT is the honest
   * option — reporting a fault the system never mentioned would be a false
   * alarm, and an error would make the whole accessory look unreachable.
   */
  private statusFault(): number {
    const { StatusFault } = this.api.hap.Characteristic;
    return summarizeFaults(this.status?.activeFaults ?? []).fault
      ? StatusFault.GENERAL_FAULT
      : StatusFault.NO_FAULT;
  }

  private statusLowBattery(): number {
    const { StatusLowBattery } = this.api.hap.Characteristic;
    return summarizeFaults(this.status?.activeFaults ?? []).lowBattery
      ? StatusLowBattery.BATTERY_LEVEL_LOW
      : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private batteryLevel(): number {
    return batteryLevel(
      summarizeFaults(this.status?.activeFaults ?? []).lowBattery,
    );
  }

  /**
   * Writes a sample into the Eve history.
   *
   * Only with a real reading: 0.11.2 wrote an entry even when the zone reported no
   * temperature at all, producing gaps or zeroes in the graph.
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
   * Logs changes of the measured temperature, when asked for.
   *
   * Issue #146: while trimming the log this line was moved to `debug`. It is
   * useful for working out after the fact why it was cold in the morning, but
   * not for everyone.
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
    const direction = current > previous ? "rose" : "fell";
    this.log.info(
      `${this.zone.name}: temperature ${direction} from ${String(previous)} °C to ${String(current)} °C.`,
    );
  }

  /** The last known status. */
  get lastStatus(): ZoneStatus | undefined {
    return this.status;
  }

  private required(): ZoneStatus {
    if (this.status === undefined) {
      // HomeKit gets a clean error rather than an invented value.
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return this.status;
  }

  private currentTemperature(): number {
    const temperature = this.required().temperatureStatus.temperature;
    if (temperature === undefined) {
      // The zone reports no reading, e.g. on an empty battery. 0.11.2 passed
      // undefined through, which HomeKit turned into "received NaN" (#94).
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

  /** Is the zone currently calling for heat? */
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
   * What the user has selected.
   *
   * `AUTO` means "follows the schedule", `HEAT` means an override is active and
   * `OFF` means the setpoint sits at the system minimum.
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
      // In 0.11.2 this option was never passed to the accessory and therefore had
      // no effect at all.
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

    // Issue #149: if a temporary override is already running, the default
    // `keepExistingUntil` adopts its end time instead of replacing it with the
    // next switchpoint.
    const current = this.required().setpointStatus;
    const decision = decideOverride(
      this.config.setpointMode,
      current,
      await this.nextSwitchpoint(now, current),
      now,
    );

    this.log.info(
      `${this.zone.name}: target temperature ${String(target)} °C, ${decision.reason}.`,
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
   * Next switchpoint in this zone's schedule.
   *
   * Fetched only when the decision can still use it; otherwise the call would
   * be pure load on Honeywell's servers. See {@link needsSwitchpoint}.
   */
  private async nextSwitchpoint(
    now: Date,
    current: CurrentOverride,
  ): Promise<Date | undefined> {
    if (!needsSwitchpoint(this.config.setpointMode, current, now)) {
      return undefined;
    }
    const schedule = await this.schedules.zone(this.zone.zoneId);
    return nextSwitchpoint(schedule, now, this.offsetMinutes())?.at;
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const { TargetHeatingCoolingState } = this.api.hap.Characteristic;
    const { minHeatSetpoint } = this.zone.setpointCapabilities;

    if (value === TargetHeatingCoolingState.OFF) {
      // To the system minimum rather than a fixed 5 °C (#94).
      this.log.info(
        `${this.zone.name}: off (target ${String(minHeatSetpoint)} °C).`,
      );
      await this.client.setHeatSetpoint(
        this.zone.zoneId,
        "PermanentOverride",
        minHeatSetpoint,
        undefined,
      );
    } else if (value === TargetHeatingCoolingState.AUTO) {
      this.log.info(`${this.zone.name}: following the schedule again.`);
      await this.client.setHeatSetpoint(
        this.zone.zoneId,
        "FollowSchedule",
        undefined,
        undefined,
      );
    } else {
      // HEAT while an override is already active means: change nothing. Only
      // coming out of the off state cancels the override.
      if (this.targetState() !== TargetHeatingCoolingState.OFF) {
        return;
      }
      this.log.info(`${this.zone.name}: heating on again, override cancelled.`);
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
