import type { API, Characteristic, WithUUID } from "homebridge";

/**
 * Zusatz-Characteristics der Elgato-Eve-App.
 *
 * Hier liegt der Absturz aus Issue #205 begraben. 0.11.2 baute diese Klassen
 * so:
 *
 * ```js
 * CustomCharacteristic.ValvePosition = function () {
 *   Characteristic.call(this, "Valve position", "E863F12E-…");
 *   this.setProps({ format: Characteristic.Formats.UINT8, … });
 * };
 * inherits(CustomCharacteristic.ValvePosition, Characteristic);
 * ```
 *
 * In HAP 2.x (Homebridge 2) ist `Characteristic` eine ES-Klasse. Sie lässt
 * sich nicht mehr als Funktion aufrufen — daher
 * `TypeError: Class constructor Characteristic cannot be invoked without 'new'`
 * (Befund B1). Zusätzlich sind die Statics `Characteristic.Formats`, `.Units`
 * und `.Perms` entfallen; sie liegen jetzt unter `api.hap` (Befund B2).
 *
 * Die Idee der Umsetzung stammt aus PR #207 von @MGMsystems.
 *
 * **Bewusst weggelassen:** 0.11.2 bot außerdem `ProgramCommand` und
 * `ProgramData` an. Beide waren nie implementiert — `ProgramData` lieferte
 * einen fest einkodierten Hex-Blob, der nicht zum tatsächlichen Zeitprogramm
 * gehörte. Der Eve-App ein erfundenes Programm zu melden ist schlechter, als
 * die Characteristics gar nicht erst anzubieten.
 */

/** UUID der Eve-Characteristic „Valve position". */
export const VALVE_POSITION_UUID = "E863F12E-079E-48FF-8F27-9C2605A29F52";

export interface EveCharacteristics {
  readonly ValvePosition: WithUUID<new () => Characteristic>;
}

/**
 * Erzeugt die Eve-Characteristics gegen die HAP-Instanz von Homebridge.
 *
 * Die Klassen können erst gebaut werden, wenn `api.hap` vorliegt — deshalb
 * eine Fabrik statt eines Moduls voller Klassen.
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
