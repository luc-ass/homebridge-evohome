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

/** Liest den Formularkörper des letzten fetch-Aufrufs. */
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

  it("meldet sich mit Benutzername und Passwort an", async () => {
    fetchMock.mockResolvedValue(jsonResponse(tokenBody("aaa", "bbb")));
    const store = new TokenStore("user@example.com", "geheim", undefined);

    expect(await store.authorization()).toBe("bearer aaa");

    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("Username")).toBe("user@example.com");
    expect(body.get("Password")).toBe("geheim");
  });

  it("kodiert Sonderzeichen im Passwort korrekt", async () => {
    // Das README warnt bis heute, das Passwort dürfe kein "&" enthalten.
    // URLSearchParams kodiert es korrekt — die Einschränkung ist damit weg.
    fetchMock.mockResolvedValue(jsonResponse(tokenBody("aaa", "bbb")));
    const store = new TokenStore("user@example.com", "a&b=c+d%e", undefined);
    await store.authorization();

    expect(bodyOf(fetchMock.mock.calls[0]!).get("Password")).toBe("a&b=c+d%e");
  });

  it("verwendet einen gültigen Token weiter, ohne erneut anzufragen", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );
    const store = new TokenStore("u", "p", undefined);

    await store.authorization();
    await store.authorization();
    await store.authorization();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("erneuert den Token kurz vor dem Ablauf per refresh_token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...(tokenBody("aaa", "bbb") as object), expires_in: 30 }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("ccc", "ddd")));

    const store = new TokenStore("u", "p", undefined);
    expect(await store.authorization()).toBe("bearer aaa");
    // expires_in 30 s liegt innerhalb der Sicherheitsmarge von 60 s.
    expect(await store.authorization()).toBe("bearer ccc");

    expect(bodyOf(fetchMock.mock.calls[1]!).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(bodyOf(fetchMock.mock.calls[1]!).get("refresh_token")).toBe("bbb");
  });

  it("meldet sich neu an, wenn der Refresh-Token verbraucht ist", async () => {
    // Der Fall aus Issue #136: 0.11.2 gab hier auf und war bis zum Neustart
    // tot, weil der Fehlerpfad nur geloggt hat (Befund S12).
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

  it("gibt bei falschen Zugangsdaten auf, statt in den Rate-Limiter zu laufen", async () => {
    // Ein Response-Objekt lässt sich nur einmal auslesen, daher pro Aufruf ein
    // frisches erzeugen.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_grant", error_description: "Bad credentials" },
          { status: 400 },
        ),
      ),
    );

    const store = new TokenStore("u", "falsch", undefined);
    await expect(store.authorization()).rejects.toThrowError(EvohomeAuthError);

    try {
      await store.authorization();
      expect.unreachable("hätte werfen müssen");
    } catch (error) {
      expect((error as EvohomeAuthError).retryable).toBe(false);
      expect((error as Error).message).toContain("Bad credentials");
      expect((error as Error).message).toContain("config.json");
    }
  });

  it("wertet einen Fehler auch dann aus, wenn er mit HTTP 200 kommt", async () => {
    // Die TCC-API quittiert manche Anmeldefehler mit Status 200 und einem
    // error-Feld im Body.
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }));

    const store = new TokenStore("u", "p", undefined);
    await expect(store.authorization()).rejects.toThrowError(EvohomeAuthError);
  });

  it("behandelt Serverfehler als vorübergehend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("<html>502</html>", { status: 502 }),
    );

    const store = new TokenStore("u", "p", undefined);
    await expect(store.authorization()).rejects.toSatisfy(
      (error: unknown) => error instanceof EvohomeAuthError && error.retryable,
    );
  });

  it("verpackt Netzwerkfehler statt sie durchzureichen", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const store = new TokenStore("u", "p", undefined);
    await expect(store.authorization()).rejects.toThrowError(
      EvohomeNetworkError,
    );
  });

  it("bündelt gleichzeitige Aufrufe zu einer einzigen Anmeldung", async () => {
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

  it("nimmt einen zwischengespeicherten Token über den Neustart mit", async () => {
    const cache = memoryCache();
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );

    await new TokenStore("u", "p", cache).authorization();
    expect(cache.value?.accessToken).toBe("aaa");

    // Zweite Instanz, wie nach einem Homebridge-Neustart: der gecachte Token
    // ist noch gültig, es darf keine neue Anmeldung geben.
    fetchMock.mockClear();
    const restored = new TokenStore("u", "p", cache);
    expect(await restored.authorization()).toBe("bearer aaa");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verwirft den Token bei invalidate und meldet sich neu an", async () => {
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

  it("legt die Zugangsdaten nicht offen (S10)", async () => {
    // 0.11.2 legte Benutzername und Passwort in einer modulglobalen Map ab,
    // die nie gelesen und nie geleert wurde. Hier liegen sie in
    // ES-Private-Feldern und tauchen damit in keinem Objekt-Dump auf —
    // relevant, weil Homebridge im Fehlerfall ganze Objekte protokolliert.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(tokenBody("aaa", "bbb"))),
    );
    const store = new TokenStore("user@example.com", "geheim", undefined);
    await store.authorization();

    expect(JSON.stringify(store)).not.toContain("geheim");
    expect(Object.keys(store)).not.toContain("password");
    expect(Object.keys(store)).not.toContain("username");
    expect(Object.getOwnPropertyNames(store)).not.toContain("password");

    // Und das Modul selbst hält keinen Zustand über Instanzen hinweg.
    const second = new TokenStore("anderer@example.com", "anders", undefined);
    expect(second.current).toBeUndefined();
  });
});
