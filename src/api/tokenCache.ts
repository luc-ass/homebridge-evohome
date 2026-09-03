import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TokenCache } from "./auth.js";
import type { Tokens } from "./types.js";
import type { Logging } from "homebridge";

/**
 * Legt die Sitzung im Homebridge-Storage ab, damit ein Neustart nicht jedes Mal
 * eine neue Anmeldung auslöst.
 *
 * Das spart nicht nur eine Anfrage: wer Homebridge während der Fehlersuche
 * mehrfach neu startet, läuft sonst leicht in den Rate-Limiter der
 * Honeywell-Server (siehe Risiko-Tabelle in docs/MIGRATION-HB2.md).
 *
 * Gespeichert wird ausschließlich das Token-Paar — **niemals** Benutzername
 * oder Passwort. Der Dateiname enthält nur einen Hash des Benutzernamens,
 * damit mehrere Konten nebeneinander laufen können, ohne dass die Adresse im
 * Dateisystem steht.
 */
export class FileTokenCache implements TokenCache {
  private readonly file: string;

  constructor(
    storagePath: string,
    username: string,
    private readonly log: Logging,
  ) {
    const fingerprint = createHash("sha256")
      .update(username.toLowerCase())
      .digest("hex")
      .slice(0, 12);
    this.file = join(storagePath, `evohome-session-${fingerprint}.json`);
  }

  async read(): Promise<Tokens | undefined> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return this.validate(raw);
    } catch (error) {
      // Fehlt die Datei oder ist sie unbrauchbar, wird eben neu angemeldet —
      // das ist kein Grund, den Start abzubrechen.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.debug(
          `Gespeicherte Sitzung konnte nicht gelesen werden: ${String(error)}`,
        );
      }
      return undefined;
    }
  }

  async write(tokens: Tokens | undefined): Promise<void> {
    try {
      if (tokens === undefined) {
        await unlink(this.file);
        return;
      }
      // 0o600: nur der Homebridge-Benutzer darf den Token lesen.
      await writeFile(this.file, JSON.stringify(tokens), { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.debug(
          `Sitzung konnte nicht gespeichert werden: ${String(error)}`,
        );
      }
    }
  }

  private validate(raw: unknown): Tokens | undefined {
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    const candidate = raw as Partial<Tokens>;
    const usable =
      typeof candidate.accessToken === "string" &&
      typeof candidate.refreshToken === "string" &&
      typeof candidate.expiresAt === "number";
    return usable ? (candidate as Tokens) : undefined;
  }
}
