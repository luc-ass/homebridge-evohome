import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { FileTokenCache } from "../../src/api/tokenCache.js";
import { createTestLog, type TestLog } from "../hapStub.js";

import type { Tokens } from "../../src/api/types.js";

const tokens: Tokens = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 1_800_000_000_000,
};

/** The single file the cache uses for this storage path and username. */
const onlyFile = async (storagePath: string): Promise<string> => {
  const entries = await readdir(storagePath);
  expect(entries).toHaveLength(1);
  return join(storagePath, entries[0]!);
};

describe("FileTokenCache", () => {
  let storagePath: string;
  let log: TestLog;
  let cache: FileTokenCache;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), "evohome-tokens-"));
    log = createTestLog();
    cache = new FileTokenCache(storagePath, "User@Example.com", log);
  });

  describe("file name", () => {
    it("keeps the username out of the file system", async () => {
      await cache.write(tokens);

      const file = await onlyFile(storagePath);
      expect(file).not.toContain("User");
      expect(file).not.toContain("example.com");
      expect(file).toMatch(/evohome-session-[0-9a-f]{12}\.json$/);
    });

    it("ignores the case of the username, so one account uses one file", async () => {
      await cache.write(tokens);
      await new FileTokenCache(storagePath, "user@example.com", log).write(
        tokens,
      );

      // Both wrote to the same file, otherwise there would be two.
      await onlyFile(storagePath);
    });

    it("gives a second account a file of its own", async () => {
      await cache.write(tokens);
      await new FileTokenCache(storagePath, "other@example.com", log).write(
        tokens,
      );

      expect(await readdir(storagePath)).toHaveLength(2);
    });
  });

  describe("read", () => {
    it("returns what was written", async () => {
      await cache.write(tokens);

      expect(await cache.read()).toEqual(tokens);
    });

    it("returns undefined without a stored session and stays quiet about it", async () => {
      expect(await cache.read()).toBeUndefined();
      // A missing file is the normal first start, not something to report.
      expect(log.debug).not.toHaveBeenCalled();
    });

    it("survives a truncated file", async () => {
      // The realistic case: the power goes on a Pi mid-write.
      await cache.write(tokens);
      writeFileSync(await onlyFile(storagePath), '{"accessToken":"acc');

      expect(await cache.read()).toBeUndefined();
      expect(log.debug).toHaveBeenCalled();
    });

    it.each([
      ["a missing refreshToken", { accessToken: "a", expiresAt: 1 }],
      ["a missing accessToken", { refreshToken: "r", expiresAt: 1 }],
      ["a missing expiresAt", { accessToken: "a", refreshToken: "r" }],
      [
        "an expiresAt that is not a number",
        { accessToken: "a", refreshToken: "r", expiresAt: "soon" },
      ],
      ["JSON that is not an object", "just a string"],
      ["null", null],
    ])("rejects a session with %s", async (_name, content) => {
      await cache.write(tokens);
      writeFileSync(await onlyFile(storagePath), JSON.stringify(content));

      // Half a token pair is worse than none: it would be sent to Honeywell,
      // rejected, and only then trigger a fresh login.
      expect(await cache.read()).toBeUndefined();
    });
  });

  describe("write", () => {
    it("stores the session readable only by the Homebridge user", async () => {
      await cache.write(tokens);

      const mode = statSync(await onlyFile(storagePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("deletes the session when given undefined", async () => {
      await cache.write(tokens);
      await cache.write(undefined);

      expect(await readdir(storagePath)).toHaveLength(0);
      expect(await cache.read()).toBeUndefined();
    });

    it("stays quiet when there is nothing to delete", async () => {
      await cache.write(undefined);

      expect(log.debug).not.toHaveBeenCalled();
    });

    it("does not throw when the storage path is gone", async () => {
      const broken = new FileTokenCache(
        join(storagePath, "does", "not", "exist"),
        "user@example.com",
        log,
      );

      // A failed write costs one extra login, nothing more; it must never take
      // the plugin down. But it has to be visible: a missing storage directory
      // raises ENOENT, which used to be swallowed along with the "nothing to
      // delete" case, so the session was silently never persisted.
      await expect(broken.write(tokens)).resolves.toBeUndefined();
      expect(log.debug).toHaveBeenCalled();
    });

    it("reports a failed delete that is not just a missing file", async () => {
      await cache.write(tokens);
      const file = await onlyFile(storagePath);
      rmSync(file);
      mkdirSync(file);

      await expect(cache.write(undefined)).resolves.toBeUndefined();
      expect(log.debug).toHaveBeenCalled();
    });

    it("reports a write that failed for any other reason", async () => {
      // A directory where the file belongs: EISDIR instead of ENOENT.
      await cache.write(tokens);
      const file = await onlyFile(storagePath);
      rmSync(file);
      mkdirSync(file);

      await expect(cache.write(tokens)).resolves.toBeUndefined();
      expect(log.debug).toHaveBeenCalled();
    });
  });
});
