import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EvohomeClient } from "../../src/api/client.js";
import {
  EvohomeApiError,
  EvohomeNetworkError,
  EvohomeRateLimitError,
  EvohomeResponseError,
  isRetryable,
} from "../../src/api/errors.js";
import { fixture, jsonResponse } from "../helpers.js";

import type { TokenStore } from "../../src/api/auth.js";

/** TokenStore-Attrappe, die zählt, wie oft invalidiert wurde. */
const stubTokens = (): TokenStore & { invalidated: number } => {
  const store = {
    invalidated: 0,
    authorization: () => Promise.resolve("bearer test-token"),
    invalidate() {
      store.invalidated++;
      return Promise.resolve();
    },
  };
  return store as unknown as TokenStore & { invalidated: number };
};

const urlOf = (call: unknown[]): string => String(call[0]);
const initOf = (call: unknown[]): RequestInit => call[1] as RequestInit;

describe("EvohomeClient", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let tokens: TokenStore & { invalidated: number };
  let client: EvohomeClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    tokens = stubTokens();
    client = new EvohomeClient(tokens);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Lesen", () => {
    it("hängt den Authorization-Header an jede Anfrage", async () => {
      fetchMock.mockResolvedValue(jsonResponse(fixture("userAccount.json")));
      await client.getUserAccount();

      const headers = initOf(fetchMock.mock.calls[0]!).headers as Record<
        string,
        string
      >;
      expect(headers["Authorization"]).toBe("bearer test-token");
    });

    it("spricht die Resideo-Domain und den EMEA-Pfad an", async () => {
      fetchMock.mockResolvedValue(jsonResponse(fixture("userAccount.json")));
      await client.getUserAccount();

      expect(urlOf(fetchMock.mock.calls[0]!)).toBe(
        "https://tccna.resideo.com/WebAPI/emea/api/v1/userAccount",
      );
    });

    it("holt Zonen, Systemmodus und Warmwasser mit einer Anfrage (S13)", async () => {
      fetchMock.mockResolvedValue(jsonResponse(fixture("locationStatus.json")));
      const status = await client.getLocationStatus("9876543");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(status.zones).toHaveLength(4);
      expect(status.systemModeStatus.mode).toBe("AutoWithEco");
      expect(status.dhw?.state).toBe("On");
    });

    it("kodiert IDs in der URL", async () => {
      fetchMock.mockResolvedValue(jsonResponse(fixture("scheduleZone.json")));
      await client.getZoneSchedule("30 01/x");

      expect(urlOf(fetchMock.mock.calls[0]!)).toContain(
        "/temperatureZone/30%2001%2Fx/schedule",
      );
    });
  });

  describe("Schreiben", () => {
    it("setzt einen befristeten Override mit Endzeitpunkt", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "1234567890" }));
      const until = new Date("2026-09-03T18:30:00Z");
      const task = await client.setHeatSetpoint(
        "3001",
        "TemporaryOverride",
        21.5,
        until,
      );

      expect(task.id).toBe("1234567890");
      const init = initOf(fetchMock.mock.calls[0]!);
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({
        HeatSetpointValue: 21.5,
        SetpointMode: "TemporaryOverride",
        TimeUntil: "2026-09-03T18:30:00Z",
      });
    });

    it("setzt einen dauerhaften Override ohne Endzeitpunkt", async () => {
      // Der von Issue #149 gewünschte Modus, den 0.11.2 nie erzeugte.
      fetchMock.mockResolvedValue(jsonResponse({ id: "1" }));
      await client.setHeatSetpoint("3001", "PermanentOverride", 21, undefined);

      expect(
        JSON.parse(initOf(fetchMock.mock.calls[0]!).body as string),
      ).toEqual({
        HeatSetpointValue: 21,
        SetpointMode: "PermanentOverride",
        TimeUntil: null,
      });
    });

    it("hebt einen Override mit FollowSchedule auf", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "1" }));
      await client.setHeatSetpoint(
        "3001",
        "FollowSchedule",
        undefined,
        undefined,
      );

      expect(
        JSON.parse(initOf(fetchMock.mock.calls[0]!).body as string),
      ).toEqual({
        HeatSetpointValue: 0,
        SetpointMode: "FollowSchedule",
        TimeUntil: null,
      });
    });

    it("setzt den Systemmodus dauerhaft oder befristet", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "1" }));
      await client.setSystemMode("444001", "Away", undefined);
      expect(
        JSON.parse(initOf(fetchMock.mock.calls[0]!).body as string),
      ).toEqual({ SystemMode: "Away", TimeUntil: null, Permanent: true });

      fetchMock.mockResolvedValue(jsonResponse({ id: "2" }));
      await client.setSystemMode(
        "444001",
        "DayOff",
        new Date("2026-09-04T00:00:00Z"),
      );
      expect(
        JSON.parse(initOf(fetchMock.mock.calls[1]!).body as string),
      ).toEqual({
        SystemMode: "DayOff",
        TimeUntil: "2026-09-04T00:00:00Z",
        Permanent: false,
      });
    });

    it("schaltet Warmwasser bis zum nächsten Schaltpunkt", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: "1" }));
      await client.setDhwState(
        "2001",
        "TemporaryOverride",
        "On",
        new Date("2026-09-03T20:00:00Z"),
      );

      expect(
        JSON.parse(initOf(fetchMock.mock.calls[0]!).body as string),
      ).toEqual({
        Mode: "TemporaryOverride",
        State: "On",
        UntilTime: "2026-09-03T20:00:00Z",
      });
    });

    it("verträgt eine leere Quittung auf eine Schreiboperation", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 201 }));
      await expect(
        client.setSystemMode("444001", "Auto", undefined),
      ).resolves.toEqual({ id: undefined });
    });
  });

  describe("Fehlerbehandlung", () => {
    it("erneuert den Token einmal bei HTTP 401 und wiederholt", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ message: "Unauthorized" }, { status: 401 }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(fixture("locationStatus.json")),
      );

      const status = await client.getLocationStatus("9876543");

      expect(tokens.invalidated).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(status.systemId).toBe("444001");
    });

    it("gibt nach dem zweiten 401 auf, statt endlos zu wiederholen", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ message: "Unauthorized" }, { status: 401 }),
        ),
      );

      await expect(client.getLocationStatus("9876543")).rejects.toThrowError(
        EvohomeApiError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("meldet ein Rate-Limit mit der Wartezeit aus Retry-After", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse("rate limited", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
      );

      try {
        await client.getLocationStatus("9876543");
        expect.unreachable("hätte werfen müssen");
      } catch (error) {
        expect(error).toBeInstanceOf(EvohomeRateLimitError);
        expect((error as EvohomeRateLimitError).retryAfterMs).toBe(120_000);
        expect(isRetryable(error)).toBe(true);
      }
    });

    it("kennzeichnet Serverfehler als wiederholbar, Clientfehler nicht", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse("boom", { status: 503 }));
      const serverError = await client
        .getLocationStatus("9876543")
        .catch((error: unknown) => error);
      expect(isRetryable(serverError)).toBe(true);

      fetchMock.mockResolvedValueOnce(jsonResponse("nope", { status: 404 }));
      const clientError = await client
        .getLocationStatus("9876543")
        .catch((error: unknown) => error);
      expect(isRetryable(clientError)).toBe(false);
    });

    it("verpackt Timeouts als Netzwerkfehler", async () => {
      fetchMock.mockRejectedValue(
        new DOMException("The operation was aborted", "TimeoutError"),
      );

      const error = await client
        .getLocationStatus("9876543")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EvohomeNetworkError);
      expect(isRetryable(error)).toBe(true);
    });

    it("meldet einen leeren Body bei einer Leseanfrage als Formatfehler", async () => {
      // 0.11.2 lief hier in einen JSON.parse-Fehler ohne Kontext und
      // protokollierte das komplette Response-Objekt.
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));

      await expect(client.getLocationStatus("9876543")).rejects.toThrowError(
        EvohomeResponseError,
      );
    });

    it("meldet HTML statt JSON als Formatfehler mit Pfadangabe", async () => {
      // Kommt vor, wenn ein Proxy oder eine Wartungsseite antwortet.
      fetchMock.mockResolvedValue(
        new Response("<html><body>503</body></html>", { status: 200 }),
      );

      const error = await client
        .getZoneSchedule("3001")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EvohomeResponseError);
      expect((error as EvohomeResponseError).path).toContain(
        "/temperatureZone/3001/schedule",
      );
    });

    it("setzt AbortSignal.timeout auf jede Anfrage", async () => {
      fetchMock.mockResolvedValue(jsonResponse(fixture("userAccount.json")));
      await client.getUserAccount();

      expect(initOf(fetchMock.mock.calls[0]!).signal).toBeInstanceOf(
        AbortSignal,
      );
    });
  });

  it("respektiert eine abweichende Basis-URL", async () => {
    // Beim Wechsel von honeywell.com auf resideo.com war das der Fix, der
    // ein Release erzwang. Konfigurierbar erspart das beim nächsten Mal.
    const custom = new EvohomeClient(tokens, {
      baseUrl: "https://tccna.example.test",
    });
    fetchMock.mockResolvedValue(jsonResponse(fixture("userAccount.json")));
    await custom.getUserAccount();

    expect(urlOf(fetchMock.mock.calls[0]!)).toBe(
      "https://tccna.example.test/WebAPI/emea/api/v1/userAccount",
    );
  });
});
