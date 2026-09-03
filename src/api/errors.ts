/**
 * Fehlertypen des Evohome-Clients.
 *
 * In 0.11.2 gab es keine: ein Ausfall der Honeywell-Server schlug als roher
 * `TypeError` durch, weil ungeprüft auf Felder der Antwort zugegriffen wurde
 * (Befund S8), und die Fehlerpfade verschluckten den Rest (S12). Jede Ursache
 * bekommt hier einen eigenen Typ, damit der Aufrufer entscheiden kann, ob er
 * erneut versucht, neu anmeldet oder aufgibt.
 */

/** Gemeinsame Basis aller Fehler, die dieser Client wirft. */
export class EvohomeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Die Anmeldung ist fehlgeschlagen oder die Sitzung lässt sich nicht erneuern.
 *
 * `retryable` unterscheidet den dauerhaften Fall (falsches Passwort — erneutes
 * Versuchen bringt nichts und läuft nur in den Rate-Limiter) vom vorübergehenden
 * (abgelaufener Refresh-Token, Serverfehler bei der Anmeldung).
 */
export class EvohomeAuthError extends EvohomeError {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Die API hat mit einem Status außerhalb von 2xx geantwortet. */
export class EvohomeApiError extends EvohomeError {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/**
 * Rate-Limit der Honeywell-Server erreicht (HTTP 429).
 *
 * `retryAfterMs` stammt aus dem `Retry-After`-Header, sofern gesetzt.
 */
export class EvohomeRateLimitError extends EvohomeApiError {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
    body?: string,
  ) {
    super(message, 429, body);
  }
}

/** Netzwerkfehler oder Timeout — die Anfrage hat den Server nicht erreicht. */
export class EvohomeNetworkError extends EvohomeError {}

/**
 * Die Antwort war syntaktisch JSON, entsprach aber nicht der erwarteten Form.
 *
 * Genau der Fall, der in 0.11.2 als
 * `Cannot read properties of undefined (reading 'temperature')` durchschlug
 * (Befund S8, Issue #205).
 */
export class EvohomeResponseError extends EvohomeError {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/**
 * Meldet, ob ein Fehler einen erneuten Versuch rechtfertigt.
 *
 * Falsche Zugangsdaten und kaputte Antwortformate sind dauerhaft — dagegen hilft
 * kein Wiederholen. Netzwerk-, Server- und Rate-Limit-Fehler gehen vorüber.
 */
export const isRetryable = (error: unknown): boolean => {
  if (error instanceof EvohomeAuthError) {
    return error.retryable;
  }
  if (error instanceof EvohomeRateLimitError) {
    return true;
  }
  if (error instanceof EvohomeApiError) {
    return error.status >= 500;
  }
  return error instanceof EvohomeNetworkError;
};
