import { isRetryable } from "./api/errors.js";
import { backoffDelay, DEFAULT_BACKOFF } from "./util/backoff.js";

import type { EvohomeClient } from "./api/client.js";
import type { LocationStatus } from "./api/types.js";
import type { Logging } from "homebridge";

/**
 * Holt den Status der Location und verteilt ihn an alle Accessory-Handler.
 *
 * Ersetzt gleich vier Timer-Konstruktionen aus 0.11.2:
 *
 * - `periodicUpdate` alle 300 s mit drei API-Aufrufen (Befund S13)
 * - `periodicCheckSetTemperature` alle 5 s **pro Zone** (S11)
 * - `periodicCheckStatus` alle 60 s für das Warmwasser
 * - `renewSession` mit fest verdrahtetem Intervall (S12, jetzt im TokenStore)
 *
 * Entscheidend ist der Reentrancy-Schutz: 0.11.2 setzte sein `updating`-Flag
 * synchron am Ende der Funktion zurück — also lange bevor die Promise-Kette
 * fertig war. Der Schutz wirkte nie, Abfragen konnten sich überlappen und
 * stapeln (Befund S5, wahrscheinliche Ursache von Issue #172). Hier hält ein
 * `await` auf den laufenden Durchlauf die Nebenläufigkeit tatsächlich auf.
 */

export type StatusListener = (status: LocationStatus) => void;

export class PollingCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<LocationStatus | undefined> | undefined;
  private stopped = false;
  private consecutiveFailures = 0;

  private readonly listeners = new Set<StatusListener>();

  /** Zuletzt erfolgreich gelesener Status. */
  private lastStatus: LocationStatus | undefined;

  constructor(
    private readonly client: EvohomeClient,
    private readonly locationId: string,
    private readonly intervalSeconds: number,
    private readonly log: Logging,
  ) {}

  get status(): LocationStatus | undefined {
    return this.lastStatus;
  }

  /** Registriert einen Empfänger und liefert die Abmeldefunktion. */
  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Startet den Zyklus und führt sofort eine erste Abfrage aus. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.poll();
    this.schedule();
  }

  /**
   * Beendet den Zyklus.
   *
   * 0.11.2 hob seine Timer-Handles nie auf und konnte sie daher nicht
   * abräumen (Befund S11).
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * Stößt eine Aktualisierung an, **ohne** auf sie zu warten.
   *
   * Für den Schreibpfad aus HomeKit: sobald die API den Befehl quittiert hat,
   * ist der `onSet`-Handler fertig. Würde er zusätzlich auf die Nachkontrolle
   * warten, hinge HomeKit bei jedem Tastendruck mehrere Sekunden — und liefe
   * bei einer langsamen Antwort in denselben Timeout, der Issue #180
   * ausgelöst hat.
   */
  scheduleRefresh(delayMs = 0): void {
    if (this.stopped) {
      return;
    }
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.poll();
    }, delayMs);
    this.refreshTimer.unref();
  }

  /**
   * Erzwingt eine Abfrage außer der Reihe.
   *
   * Wird nach einem Schreibvorgang genutzt: die Honeywell-Server brauchen
   * einen Moment, bis eine Änderung im Status auftaucht.
   */
  async refresh(delayMs = 0): Promise<void> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!this.stopped) {
      await this.poll();
    }
  }

  /**
   * Führt eine Abfrage aus. Läuft bereits eine, wird auf sie gewartet, statt
   * eine zweite zu starten.
   */
  private async poll(): Promise<LocationStatus | undefined> {
    this.inFlight ??= this.fetchOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchOnce(): Promise<LocationStatus | undefined> {
    try {
      const status = await this.client.getLocationStatus(this.locationId);
      this.onSuccess(status);
      return status;
    } catch (error) {
      this.onFailure(error);
      return undefined;
    }
  }

  private onSuccess(status: LocationStatus): void {
    if (this.consecutiveFailures > 0) {
      this.log.info(
        `Verbindung zu Evohome nach ${String(this.consecutiveFailures)} Fehlversuch(en) wiederhergestellt.`,
      );
    }
    this.consecutiveFailures = 0;
    this.lastStatus = status;

    for (const listener of this.listeners) {
      // Ein Fehler in einem Handler darf die übrigen nicht mitreißen.
      try {
        listener(status);
      } catch (error) {
        this.log.error(`Fehler beim Verarbeiten des Status: ${String(error)}`);
      }
    }
  }

  /**
   * Protokolliert einen Fehlschlag.
   *
   * Der erste Fehler wird als Warnung gemeldet, jeder weitere nur noch im
   * Debug-Log — sonst füllt ein längerer Honeywell-Ausfall das Log mit
   * derselben Meldung (der Anlass für PR #204).
   */
  private onFailure(error: unknown): void {
    this.consecutiveFailures++;
    const message = error instanceof Error ? error.message : String(error);

    if (this.consecutiveFailures === 1) {
      this.log.warn(`Statusabfrage bei Evohome fehlgeschlagen: ${message}`);
    } else {
      this.log.debug(
        `Statusabfrage fehlgeschlagen (${String(this.consecutiveFailures)}. Versuch in Folge): ${message}`,
      );
    }

    if (!isRetryable(error) && this.consecutiveFailures === 1) {
      this.log.warn(
        "Dieser Fehler geht voraussichtlich nicht von selbst weg. Bitte Konfiguration und Log prüfen.",
      );
    }
  }

  /** Plant den nächsten Durchlauf; nach Fehlern mit wachsendem Abstand. */
  private schedule(): void {
    if (this.stopped) {
      return;
    }

    const regular = this.intervalSeconds * 1000;
    const delay =
      this.consecutiveFailures === 0
        ? regular
        : Math.max(
            regular,
            backoffDelay(this.consecutiveFailures, DEFAULT_BACKOFF),
          );

    this.timer = setTimeout(() => {
      void this.poll().finally(() => {
        this.schedule();
      });
    }, delay);
    // Ein offener Timer soll Node nicht am Beenden hindern.
    this.timer.unref();
  }
}
