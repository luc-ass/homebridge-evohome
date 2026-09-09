import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenStore, type TokenCache } from "../../src/api/auth.js";
import { EvohomeAuthError, EvohomeNetworkError } from "../../src/api/errors.js";
import { jsonResponse } from "../helpers.js";

import type { Tokens } from "../../src/api/types.js";

const tokenBody = (accessToken: string, refreshToken: string): unknown => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  token_type: "bearer",
  expires_in: 1799,
});

/** Reads the form body of a fetch call. */
const bodyOf = (call: unknown[]): URLSearchParams =>
  new URLSearchParams((call[1] as { body: string }).body);

const memoryCache = (): TokenCache & { value: Tokens | undefined } => ({
  value: undefined,
  read() {
    return Promise.resolve(this.value);
  },
  write(tokens: Tokens | undefined) {
    this.value = tokens;
    return Promise.resolve();
  },
});

describe("TokenStore", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in with username and password", async () => {
    fetchMock.mockResolvedValue(jsonResponse(tokenBody("aaa", "bbb")));
    const store = new TokenStore("user@example.com", "geheim", undefined);

    expect(await store.authorization()).toBe("bearer aaa");

    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("Username")).toBe("user@example.com");
    expect(body.get("Password")).toBe("geheim");
  });

  it("encodes special characters in the password correctly", async () => {
    // The README warned that a password must not contain "&".
    // URLSearchParams encodes it correctly, so that limitation is gone.
    fetchMock.mockResolvedValue(jsonResponse(tokenBody("aaa", "bbb")));
    const store = new TokenStore("user@example.com", "a&b=c+d%e", undefined);
    await store.authorization();

    expect(bodyOf(fetchMock.mock.calls[0]!).get("Password")).toBe("a&b=c+d%e");
  });

  it("keeps using a valid token without asking again", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );
    const store = new TokenStore("u", "p", undefined);

    await store.authorization();
    await store.authorization();
    await store.authorization();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token shortly before expiry using refresh_token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...(tokenBody("aaa", "bbb") as object), expires_in: 30 }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("ccc", "ddd")));

    const store = new TokenStore("u", "p", undefined);
    expect(await store.authorization()).toBe("bearer aaa");
    // expires_in of 30s is inside the 60s safety margin.
    expect(await store.authorization()).toBe("bearer ccc");

    expect(bodyOf(fetchMock.mock.calls[1]!).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(bodyOf(fetchMock.mock.calls[1]!).get("refresh_token")).toBe("bbb");
  });

  it("logs in again when the refresh token is spent", async () => {
    // The case from issue #136: 0.11.2 gave up here and stayed dead until
    // restart, because the error path only logged.
    const cache = memoryCache();
    cache.value = {
      accessToken: "alt",
      refreshToken: "verbraucht",
      expiresAt: Date.now() - 1000,
    };

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, { status: 400 }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("neu", "frisch")));

    const store = new TokenStore("u", "p", cache);
    expect(await store.authorization()).toBe("bearer neu");

    expect(bodyOf(fetchMock.mock.calls[0]!).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(bodyOf(fetchMock.mock.calls[1]!).get("grant_type")).toBe("password");
  });

  it("logs in again when the refresh is refused without invalid_grant", async () => {
    // @PuzzledUser on #136: "Renewing Honeywell API authentication token
    // failed: HTTP error 400" every half hour for weeks, on 0.11.2. A 400 is
    // the endpoint judging this refresh token, whatever code it carries, so
    // repeating it is pointless — only a login gets out of that loop.
    const cache = memoryCache();
    cache.value = {
      accessToken: "alt",
      refreshToken: "abgelehnt",
      expiresAt: Date.now() - 1000,
    };

    fetchMock.mockResolvedValueOnce(
      jsonResponse("Bad Request", { status: 400 }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("neu", "frisch")));

    const store = new TokenStore("u", "p", cache);
    expect(await store.authorization()).toBe("bearer neu");

    expect(bodyOf(fetchMock.mock.calls[0]!).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(bodyOf(fetchMock.mock.calls[1]!).get("grant_type")).toBe("password");
  });

  it("logs in again when the refresh error arrives with HTTP 200", async () => {
    const cache = memoryCache();
    cache.value = {
      accessToken: "alt",
      refreshToken: "abgelehnt",
      expiresAt: Date.now() - 1000,
    };

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_request" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("neu", "frisch")));

    const store = new TokenStore("u", "p", cache);
    expect(await store.authorization()).toBe("bearer neu");
    expect(bodyOf(fetchMock.mock.calls[1]!).get("grant_type")).toBe("password");
  });

  it("keeps the refresh token when the endpoint is merely down", async () => {
    // The other half of the rule: a 5xx or a 429 says nothing about the token,
    // so spending a password login on it would only add rate-limit pressure.
    // The poller retries with backoff instead.
    const cache = memoryCache();
    const tokens = {
      accessToken: "alt",
      refreshToken: "gueltig",
      expiresAt: Date.now() - 1000,
    };
    cache.value = { ...tokens };

    fetchMock.mockResolvedValue(
      jsonResponse("<html>503</html>", { status: 503 }),
    );

    const store = new TokenStore("u", "p", cache);
    await expect(store.authorization()).rejects.toSatisfy(
      (error: unknown) => error instanceof EvohomeAuthError && error.retryable,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]!).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(cache.value).toEqual(tokens);
  });

  it("gives up on bad credentials instead of running into the rate limit", async () => {
    // A Response body can only be read once, so build a fresh one per call.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_grant", error_description: "Bad credentials" },
          { status: 400 },
        ),
      ),
    );

    const store = new TokenStore("u", "falsch", undefined);
    await expect(store.authorization()).rejects.toThrow(EvohomeAuthError);

    try {
      await store.authorization();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as EvohomeAuthError).retryable).toBe(false);
      expect((error as Error).message).toContain("Bad credentials");
      expect((error as Error).message).toContain("config.json");
    }
  });

  it("detects an error even when it arrives with HTTP 200", async () => {
    // The TCC API acknowledges some login errors with status 200 and an error
    // field in the body.
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }));

    const store = new TokenStore("u", "p", undefined);
    await expect(store.authorization()).rejects.toThrow(EvohomeAuthError);
  });

  it("treats server errors as temporary", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("<html>502</html>", { status: 502 }),
    );

    const store = new TokenStore("u", "p", undefined);
    await expect(store.authorization()).rejects.toSatisfy(
      (error: unknown) => error instanceof EvohomeAuthError && error.retryable,
    );
  });

  it("wraps network errors instead of passing them through", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const store = new TokenStore("u", "p", undefined);
    await expect(store.authorization()).rejects.toThrow(EvohomeNetworkError);
  });

  it("coalesces concurrent calls into a single login", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );
    const store = new TokenStore("u", "p", undefined);

    const results = await Promise.all([
      store.authorization(),
      store.authorization(),
      store.authorization(),
    ]);

    expect(results).toEqual(["bearer aaa", "bearer aaa", "bearer aaa"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries a cached token across a restart", async () => {
    const cache = memoryCache();
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );

    await new TokenStore("u", "p", cache).authorization();
    expect(cache.value?.accessToken).toBe("aaa");

    // A second instance, as after a Homebridge restart: the cached token is
    // still valid, so there must be no new login.
    fetchMock.mockClear();
    const restored = new TokenStore("u", "p", cache);
    expect(await restored.authorization()).toBe("bearer aaa");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the token on invalidate and logs in again", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("aaa", "bbb")));
    const cache = memoryCache();
    const store = new TokenStore("u", "p", cache);

    await store.authorization();
    await store.invalidate();
    expect(store.current).toBeUndefined();
    expect(cache.value).toBeUndefined();

    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("neu", "frisch")));
    expect(await store.authorization()).toBe("bearer neu");
  });

  it("keeps a token another request obtained in the meantime (#218)", async () => {
    // A poll and a write can be in flight at once. If the write's 401 comes in
    // after the poll has already logged in again, invalidating unconditionally
    // throws that fresh token away and forces a second full password login —
    // exactly the rate-limit pressure the backoff exists to avoid.
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("alt", "bbb")));
    const cache = memoryCache();
    const store = new TokenStore("u", "p", cache);
    await store.authorization();

    // The other request notices the 401 first and logs in again.
    await store.invalidate("bearer alt");
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("neu", "frisch")));
    expect(await store.authorization()).toBe("bearer neu");

    // The late 401 carries the old header and must change nothing.
    await store.invalidate("bearer alt");
    expect(store.current?.accessToken).toBe("neu");
    expect(cache.value?.accessToken).toBe("neu");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose the credentials", async () => {
    // 0.11.2 kept username and password in a module-level map that was never
    // read and never cleared. Here they live in ES private fields and so appear
    // in no object dump — relevant because Homebridge logs whole objects on
    // failure.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );
    const store = new TokenStore("user@example.com", "geheim", undefined);
    await store.authorization();

    expect(JSON.stringify(store)).not.toContain("geheim");
    expect(Object.keys(store)).not.toContain("password");
    expect(Object.keys(store)).not.toContain("username");
    expect(Object.getOwnPropertyNames(store)).not.toContain("password");

    // And the module itself keeps no state across instances.
    const second = new TokenStore("anderer@example.com", "anders", undefined);
    expect(second.current).toBeUndefined();
  });
});
