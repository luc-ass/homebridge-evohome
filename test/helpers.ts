import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Lädt eine JSON-Datei aus dem Projektwurzelverzeichnis. */
export const repoJson = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8"),
  );

/** Lädt eine Fixture aus `test/fixtures/`. */
export const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  );

/** Antwort für einen `fetch`-Mock. */
export const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
