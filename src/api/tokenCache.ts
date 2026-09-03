import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TokenCache } from "./auth.js";
import type { Tokens } from "./types.js";
import type { Logging } from "homebridge";

/**
 * Stores the session in the Homebridge storage directory so a restart does not
 * trigger a fresh login every time.
 *
 * That saves more than one request: restarting Homebridge repeatedly while
 * debugging otherwise runs straight into Honeywell's rate limit.
 *
 * Only the token pair is stored, **never** the username or password. The file
 * name contains a hash of the username so several accounts can coexist without
 * the address appearing in the file system.
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
      // A missing or unusable file just means logging in again; no reason to
      // abort startup.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.debug(`Could not read the stored session: ${String(error)}`);
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
      // 0o600: only the Homebridge user may read the token.
      await writeFile(this.file, JSON.stringify(tokens), { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.debug(`Could not store the session: ${String(error)}`);
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
