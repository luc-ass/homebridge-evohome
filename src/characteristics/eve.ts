import type { API, Characteristic, WithUUID } from "homebridge";

/**
 * Additional characteristics used by the Elgato Eve app.
 *
 * This is where the crash from issue #205 came from. 0.11.2 built these classes
 * like this:
 *
 * ```js
 * CustomCharacteristic.ValvePosition = function () {
 *   Characteristic.call(this, "Valve position", "E863F12E-…");
 *   this.setProps({ format: Characteristic.Formats.UINT8, … });
 * };
 * inherits(CustomCharacteristic.ValvePosition, Characteristic);
 * ```
 *
 * In HAP 2.x (Homebridge 2) `Characteristic` is an ES class and can no longer be
 * called as a function, hence
 * `TypeError: Class constructor Characteristic cannot be invoked without 'new'`.
 * The statics `Characteristic.Formats`, `.Units` and `.Perms` are gone too;
 * they now live on `api.hap`.
 *
 * The approach comes from PR #207 by @MGMsystems.
 *
 * **Deliberately dropped:** 0.11.2 also offered `ProgramCommand` and
 * `ProgramData`. Neither was implemented; `ProgramData` returned a hard-coded
 * hex blob unrelated to the real schedule. Reporting a made-up program to the
 * Eve app is worse than not offering the characteristics at all.
 */

/** UUID of the Eve "Valve position" characteristic. */
export const VALVE_POSITION_UUID = "E863F12E-079E-48FF-8F27-9C2605A29F52";

export interface EveCharacteristics {
  readonly ValvePosition: WithUUID<new () => Characteristic>;
}

/**
 * Builds the Eve characteristics against Homebridge's HAP instance.
 *
 * The classes can only be built once `api.hap` exists, hence a factory rather
 * than a module full of classes.
 */
export const createEveCharacteristics = (api: API): EveCharacteristics => {
  const { Characteristic, Formats, Perms, Units } = api.hap;

  class ValvePosition extends Characteristic {
    static readonly UUID: string = VALVE_POSITION_UUID;

    constructor() {
      super("Valve position", VALVE_POSITION_UUID, {
        format: Formats.UINT8,
        unit: Units.PERCENTAGE,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      });
      this.value = this.getDefaultValue();
    }
  }

  return { ValvePosition };
};
