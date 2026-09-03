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
 * Gegenüber 0.11.2 ist das eine `DynamicPlatformPlugin` statt einer
 * Static Platform: Homebridge stellt zwischengespeicherte Accessories beim
 * Start über {@link configureAccessory} wieder her, statt sie bei jedem Start
 * neu anzulegen. Damit bleiben Raumzuordnung, Szenen und Automationen erhalten
 * (Befund S1, Issue #61).
 *
 * Phase 0 legt nur das Gerüst an. Discovery, Polling und die Accessory-Handler
 * entstehen in Phase 2 — siehe docs/MIGRATION-HB2.md.
 */
export class EvohomePlatform implements DynamicPlatformPlugin {
  /**
   * Von Homebridge aus dem Cache wiederhergestellte Accessories, indiziert
   * über ihre UUID.
   */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    this.log.debug("Evohome-Platform initialisiert:", this.config.name);

    this.api.on("didFinishLaunching", () => {
      // TODO(Phase 2): Login, Discovery und PollingCoordinator starten.
      this.log.info(
        "Phase-0-Gerüst geladen — es werden noch keine Accessories angelegt.",
      );
    });

    this.api.on("shutdown", () => {
      // TODO(Phase 2): Timer stoppen (Befund S11).
      this.log.debug("Evohome-Platform wird beendet.");
    });
  }

  /**
   * Wird von Homebridge für jedes zwischengespeicherte Accessory aufgerufen,
   * bevor `didFinishLaunching` feuert.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug("Accessory aus dem Cache geladen:", accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  /** Anzahl der aus dem Cache wiederhergestellten Accessories. */
  get cachedAccessoryCount(): number {
    return this.cachedAccessories.size;
  }
}
