/**
 * Exponentieller Backoff mit Obergrenze und Jitter.
 *
 * Issue #136 fordert einen automatischen Neuversuch nach fehlgeschlagenem
 * Login, warnt aber ausdrücklich davor, dabei in den Rate-Limiter der
 * Honeywell-Server zu laufen. Der Jitter verhindert außerdem, dass viele
 * Homebridge-Instanzen nach einem Serverausfall im Gleichtakt zurückkommen.
 */

export interface BackoffOptions {
  /** Wartezeit nach dem ersten Fehlschlag, in Millisekunden. */
  readonly initialMs: number;
  /** Obergrenze der Wartezeit, in Millisekunden. */
  readonly maxMs: number;
  /** Faktor je weiterem Fehlschlag. */
  readonly factor: number;
  /** Anteil zufälliger Streuung, 0 bis 1. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 30_000,
  maxMs: 30 * 60_000,
  factor: 2,
  jitter: 0.2,
};

/**
 * Berechnet die Wartezeit vor dem Versuch mit der Nummer `attempt`.
 *
 * @param attempt Anzahl der bisherigen Fehlschläge, beginnend bei 1.
 * @param random Zufallsquelle, in Tests ersetzbar.
 */
export const backoffDelay = (
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    options.maxMs,
    options.initialMs * options.factor ** exponent,
  );
  // Streuung nach oben und unten um den Basiswert, aber nie negativ.
  const spread = base * options.jitter;
  const delay = base + (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(delay));
};

/** Wartet die angegebene Zeit ab. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
