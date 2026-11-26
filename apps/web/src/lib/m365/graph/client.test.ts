import { describe, expect, it, vi } from "vitest";
import { assertGraphUrl, createHttpGraphClient, parseRetryAfter } from "./client";
import { GraphError } from "./errors";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function tokens() {
  let n = 0;
  return {
    get: vi.fn(async () => "T0"),
    refresh: vi.fn(async () => `T${++n}`),
  };
}

describe("cliente Graph HTTP", () => {
  it("envia Prefer UTC e Bearer; pagina o delta", async () => {
    const seen: RequestInit[] = [];
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(init!);
      return json(200, { value: [{ id: "a" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" });
    });
    const client = createHttpGraphClient({ tokens: tokens(), fetch });
    const page = await client.calendarViewDelta({ startDateTime: "2026-01-01T00:00:00Z", endDateTime: "2026-02-01T00:00:00Z" });
    expect(page).toEqual({ value: [{ id: "a" }], nextLink: "https://graph.microsoft.com/v1.0/next", deltaLink: null });
    const headers = seen[0].headers as Record<string, string>;
    expect(headers.Prefer).toContain('outlook.timezone="UTC"');
    expect(headers.Authorization).toBe("Bearer T0");
    expect(fetch.mock.calls[0][0]).toContain("/me/calendarView/delta?startDateTime=2026-01-01T00%3A00%3A00Z");
  });

  it("429 respeita Retry-After e tenta de novo", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: { code: "TooManyRequests" } }, { "retry-after": "3" }))
      .mockResolvedValueOnce(json(503, {}, {}))
      .mockResolvedValueOnce(json(200, { id: "me", mail: "a@b.com" }));
    const client = createHttpGraphClient({ tokens: tokens(), fetch, sleep });
    await expect(client.getMe()).resolves.toMatchObject({ id: "me" });
    expect(sleep).toHaveBeenNthCalledWith(1, 3000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("throttling esgotado → GraphError throttled", async () => {
    const fetch = vi.fn(async () => json(429, {}, { "retry-after": "1" }));
    const client = createHttpGraphClient({ tokens: tokens(), fetch, sleep: async () => {}, maxRetries: 2 });
    await expect(client.getMe()).rejects.toMatchObject({ kind: "throttled", status: 429 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("espera que não cabe no prazo da rodada → throttled por deadline (sem dormir)", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn(async () => json(429, {}, { "retry-after": "20" }));
    const client = createHttpGraphClient({ tokens: tokens(), fetch, sleep, now: () => 1000, deadline: 5000 });
    await expect(client.getMe()).rejects.toMatchObject({ kind: "throttled", localCause: "deadline" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("401 força UM refresh; persistindo → reauth", async () => {
    const t = tokens();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { id: "me" }));
    const client = createHttpGraphClient({ tokens: t, fetch });
    await expect(client.getMe()).resolves.toMatchObject({ id: "me" });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer T1" });

    const always401 = vi.fn(async () => json(401, { error: { code: "InvalidAuthenticationToken" } }));
    const client2 = createHttpGraphClient({ tokens: tokens(), fetch: always401 });
    await expect(client2.getMe()).rejects.toMatchObject({ kind: "reauth" });
    expect(always401).toHaveBeenCalledTimes(2);
  });

  it("410 do delta → resync; 403 → forbidden; 404 → not_found", async () => {
    const mk = (status: number, code?: string) =>
      createHttpGraphClient({ tokens: tokens(), fetch: vi.fn(async () => json(status, { error: { code } })) });
    await expect(mk(410, "syncStateNotFound").calendarViewDelta({ link: "https://graph.microsoft.com/v1.0/x" })).rejects.toMatchObject({ kind: "resync" });
    await expect(mk(403).getMe()).rejects.toMatchObject({ kind: "forbidden" });
    await expect(mk(404).getMe()).rejects.toMatchObject({ kind: "not_found" });
  });

  it("timeout por chamada vira GraphError http/timeout", async () => {
    const fetch = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const client = createHttpGraphClient({ tokens: tokens(), fetch, timeoutMs: 10 });
    const error = await client.getMe().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).toMatchObject({ kind: "http", localCause: "timeout" });
  });

  it("nunca segue link fora do host do Graph (token não vaza)", async () => {
    const fetch = vi.fn();
    const client = createHttpGraphClient({ tokens: tokens(), fetch });
    await expect(client.calendarViewDelta({ link: "https://evil.example.com/delta" })).rejects.toMatchObject({ code: "invalid_link" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => assertGraphUrl("http://graph.microsoft.com/v1.0/x")).toThrow();
  });

  it("parseRetryAfter aceita segundos e data HTTP", () => {
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
