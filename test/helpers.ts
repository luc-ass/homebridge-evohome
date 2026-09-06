import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads a JSON file from the repository root. */
export const repoJson = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8"),
  );

/** Loads a fixture from `test/fixtures/`. */
export const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  );

/** Response for a `fetch` mock. */
export const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
