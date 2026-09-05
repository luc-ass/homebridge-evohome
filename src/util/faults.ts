/**
 * Interprets the `activeFaults` that the API reports per zone and for the hot
 * water.
 *
 * Until now those strings only ever reached the log, so a flat HR92 battery was
 * invisible in the Home app — even though the API says so explicitly: a zone
 * reports `TempZoneActuatorLowBattery` long before it stops sending a
 * temperature at all.
 *
 * Fault types are matched by substring rather than against a list of known
 * names. Resideo adds new ones without announcing it
 * (`TempZoneSensorLowBattery`, `DHWSensorFailure`,
 * `BoilerCommunicationLost`, …), and a closed list would silently ignore
 * everything that is not on it.
 */

export interface FaultSummary {
  /** A fault other than a low battery, e.g. a lost radio link. */
  readonly fault: boolean;
  /** At least one component of this zone reports a low battery. */
  readonly lowBattery: boolean;
}

/** Does this fault type describe a low battery? */
export const isLowBattery = (faultType: string): boolean =>
  faultType.toLowerCase().includes("lowbattery");

/**
 * Splits the faults into the two things HomeKit can express.
 *
 * A low battery deliberately does **not** also raise `StatusFault`: an HR92
 * with a weak battery still reports and still heats. Only a genuine failure —
 * communication lost, sensor defective — makes the values untrustworthy, and
 * that is what `StatusFault` should mean.
 */
export const summarizeFaults = (faults: readonly string[]): FaultSummary => ({
  fault: faults.some((faultType) => !isLowBattery(faultType)),
  lowBattery: faults.some(isLowBattery),
});

/**
 * Comparable form of a fault list, for spotting a change.
 *
 * Sorted, because the API gives no guarantee about the order and a reordered
 * but otherwise identical list is not a change worth logging.
 */
export const faultKey = (faults: readonly string[]): string =>
  [...faults].sort().join(", ");

/**
 * Percentage for the `BatteryLevel` characteristic.
 *
 * The API only ever says *that* a battery is low, never how full it is, so
 * beta.1 published a battery service with `StatusLowBattery` alone — a made-up
 * percentage seemed worse than none. It is not: a client renders the missing
 * characteristic as zero, and the Homebridge UI showed every zone as "0 %,
 * Charged" (#205), which reads as a dead battery on hardware that is fine.
 *
 * Two coarse values are the smaller fiction. 10 is below the threshold every
 * client warns at, 100 is the "nothing reported" case.
 */
export const batteryLevel = (lowBattery: boolean): number =>
  lowBattery ? 10 : 100;
