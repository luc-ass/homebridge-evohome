import { EvohomeResponseError } from "./errors.js";

/**
 * Minimale Validierung für API-Antworten.
 *
 * Bewusst von Hand statt mit zod o. ä.: das Plugin soll keine
 * Laufzeitabhängigkeiten haben (Befund S14). Der Umfang reicht für die
 * flachen, gut bekannten Strukturen der TCC-EMEA-API.
 *
 * Jeder Fehler nennt den Pfad in der Antwort, damit im Log steht, *welches*
 * Feld fehlte — statt eines nackten `TypeError` wie in 0.11.2 (Befund S8).
 */

const describe = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "Array";
  }
  return typeof value;
};

const fail = (path: string, expected: string, value: unknown): never => {
  throw new EvohomeResponseError(
    `Unerwartete API-Antwort bei "${path}": ${expected} erwartet, ${describe(value)} erhalten.`,
    path,
  );
};

export const asRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "Objekt", value);
  }
  return value as Record<string, unknown>;
};

export const asArray = (value: unknown, path: string): unknown[] =>
  Array.isArray(value) ? value : fail(path, "Array", value);

export const asString = (value: unknown, path: string): string =>
  typeof value === "string" ? value : fail(path, "String", value);

export const asNumber = (value: unknown, path: string): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(path, "endliche Zahl", value);

export const asBoolean = (value: unknown, path: string): boolean =>
  typeof value === "boolean" ? value : fail(path, "Boolean", value);

/** Wie {@link asString}, akzeptiert aber auch Zahlen und wandelt sie um. */
export const asId = (value: unknown, path: string): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fail(path, "String oder Zahl", value);
};

/** Liest ein Feld, das fehlen darf. */
export const optional = <T>(
  value: unknown,
  path: string,
  read: (value: unknown, path: string) => T,
): T | undefined =>
  value === undefined || value === null ? undefined : read(value, path);

/**
 * Liest das erste Element eines Arrays.
 *
 * Die TCC-API verschachtelt alles in `gateways[0].temperatureControlSystems[0]`.
 * 0.11.2 griff darauf ungeprüft zu; hier gibt es stattdessen eine
 * Fehlermeldung, die den Pfad nennt.
 */
export const first = (value: unknown, path: string): unknown => {
  const items = asArray(value, path);
  if (items.length === 0) {
    throw new EvohomeResponseError(
      `Unerwartete API-Antwort bei "${path}": Array ist leer.`,
      path,
    );
  }
  return items[0];
};

/** Wandelt einen unbekannten Wert in einen der erlaubten String-Literale. */
export const asEnum = <T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T => {
  const text = asString(value, path);
  if ((allowed as readonly string[]).includes(text)) {
    return text as T;
  }
  throw new EvohomeResponseError(
    `Unerwartete API-Antwort bei "${path}": erwartet eines von ${allowed.join(", ")}, erhalten "${text}".`,
    path,
  );
};

/** Parst einen JSON-Text und meldet Syntaxfehler mit Kontext. */
export const parseJson = (text: string, path: string): unknown => {
  if (text.trim() === "") {
    throw new EvohomeResponseError(
      `Unerwartete API-Antwort bei "${path}": leerer Body.`,
      path,
    );
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new EvohomeResponseError(
      `Unerwartete API-Antwort bei "${path}": kein gültiges JSON (${String(cause)}).`,
      path,
    );
  }
};
