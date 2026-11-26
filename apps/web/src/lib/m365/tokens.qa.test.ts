import { afterEach, describe, expect, it, vi } from "vitest";
import { ENCRYPTED_FIELDS, decryptField } from "@jumpflow/database/field-encryption";
import { syncCalendarConnection } from "./calendar/sync";
import { createHttpGraphClient } from "./graph/client";
import { addConnection, createMemoryStore } from "./testing/memory-store";
import { REFRESH_SKEW_MS, createTokenProvider, encryptAccessToken, encryptRefreshToken, needsRefresh } from "./tokens";

/**
 * QA (Fase M1) — tokens: limite de 5 min, 401 → refresh, rotação persistida,
 * invalid_grant/afins → REAUTH_REQUIRED, e tokens NUNCA em log, lastError ou
 * IntegrationEvent. Token endpoint e Graph são fakes (fetch injetado).
 */

const creds = { clientId: "c", clientSecret: "APP-SECRET", tenantId: "t" };
const NOW = 1_800_000_000_000;
const SECRETS = ["AT-OLD", "RT-OLD", "AT-NEW", "RT-NEW", "AT-NEWER", "RT-NEWER", "APP-SECRET"];

function setup(expiresInMs: number) {
  const { store, state } = createMemoryStore();
  state.users.set("u1", { user: { id: "u1", name: "U", email: "u1@jump.com.br", roles: ["CONSULTANT"] }, consultantId: null });
  addConnection(state, {
    id: "c1",
    userId: "u1",
    mailbox: "u1@jump.com.br",
    accessTokenEncrypted: encryptAccessToken("AT-OLD"),
    refreshTokenEncrypted: encryptRefreshToken("RT-OLD"),
    expiresAt: new Date(NOW + expiresInMs),
    scopes: ["openid", "offline_access", "Calendars.Read"],
  });
  return { store, state };
}

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** fetch único: token endpoint + Graph, com roteiro por URL. */
function scriptedFetch(script: {
  token: Array<() => Response>;
  graph: Array<(auth: string) => Response>;
}) {
  const calls: Array<{ url: string; auth: string | null; body: URLSearchParams | null }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? null;
    const isToken = url.includes("login.microsoftonline.com");
    calls.push({ url, auth, body: isToken ? new URLSearchParams(String(init?.body)) : null });
    const next = isToken ? script.token.shift() : script.graph.shift();
    if (!next) throw new Error(`sem resposta roteirizada para ${isToken ? "token" : "graph"}`);
    return isToken ? (next as () => Response)() : (next as (a: string) => Response)(auth ?? "");
  });
  return { fetch, calls };
}

const emptyDelta = () =>
  tokenResponse({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=x" });

describe("needsRefresh — limite de 5 minutos", () => {
  it("renova exatamente em expiresAt − 5 min; 1 ms antes do limite ainda não", () => {
    const conn = { accessTokenEncrypted: "x", expiresAt: new Date(NOW + REFRESH_SKEW_MS) };
    expect(needsRefresh(conn, NOW)).toBe(true);
    expect(needsRefresh(conn, NOW - 1)).toBe(false);
    expect(needsRefresh({ accessTokenEncrypted: null, expiresAt: new Date(NOW + 3_600_000) }, NOW)).toBe(true);
    expect(needsRefresh({ accessTokenEncrypted: "x", expiresAt: null }, NOW)).toBe(true);
  });
});

describe("refresh — rotação e reautorização", () => {
  it("refresh token rotacionado é usado no refresh seguinte (cadeia RT-OLD → RT-NEW → RT-NEWER)", async () => {
    const { store, state } = setup(0);
    const { fetch, calls } = scriptedFetch({
      token: [
        () => tokenResponse({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 }),
        () => tokenResponse({ access_token: "AT-NEWER", refresh_token: "RT-NEWER", expires_in: 3600 }),
      ],
      graph: [],
    });
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    expect(await provider.get()).toBe("AT-NEW");
    expect(await provider.refresh()).toBe("AT-NEWER");
    expect(calls.map((c) => c.body?.get("refresh_token"))).toEqual(["RT-OLD", "RT-NEW"]);
    const persisted = state.connections.get("c1")!;
    expect(decryptField(ENCRYPTED_FIELDS.m365RefreshToken, persisted.refreshTokenEncrypted!)).toBe("RT-NEWER");
    // Correção M1 (validador): o refresh pede SEMPRE os escopos da fase vigente.
    expect(calls[0].body?.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
  });

  it("401 do Graph com token ainda 'válido' força refresh, persiste a rotação e repete a chamada", async () => {
    const { store, state } = setup(3_600_000);
    const { fetch, calls } = scriptedFetch({
      token: [() => tokenResponse({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 })],
      graph: [() => tokenResponse({ error: { code: "InvalidAuthenticationToken" } }, 401), emptyDelta],
    });
    const conn = (await store.getConnection("c1"))!;
    const result = await syncCalendarConnection("c1", {
      store,
      owner: "t",
      now: () => new Date(NOW),
      internalDomains: [],
      graphFor: (c) =>
        createHttpGraphClient({ tokens: createTokenProvider({ store, connection: c, credentials: creds, fetch, now: () => NOW }), fetch }),
    });
    void conn;
    expect(result.status).toBe("ok");
    const graphCalls = calls.filter((c) => c.auth);
    expect(graphCalls.map((c) => c.auth)).toEqual(["Bearer AT-OLD", "Bearer AT-NEW"]);
    expect(decryptField(ENCRYPTED_FIELDS.m365RefreshToken, state.connections.get("c1")!.refreshTokenEncrypted!)).toBe("RT-NEW");
    expect(state.connections.get("c1")!.status).toBe("ACTIVE");
  });

  it.each(["invalid_grant", "interaction_required", "consent_required", "login_required"])(
    "%s no refresh → REAUTH_REQUIRED na conexão e resultado do sync",
    async (code) => {
      const { store, state } = setup(0);
      const { fetch } = scriptedFetch({
        token: [() => tokenResponse({ error: code, error_description: "AADSTS: RT-OLD revogado" }, 400)],
        graph: [],
      });
      const result = await syncCalendarConnection("c1", {
        store,
        owner: "t",
        now: () => new Date(NOW),
        internalDomains: [],
        graphFor: (c) =>
          createHttpGraphClient({ tokens: createTokenProvider({ store, connection: c, credentials: creds, fetch, now: () => NOW }), fetch }),
      });
      expect(result).toMatchObject({ status: "error", connectionStatus: "REAUTH_REQUIRED" });
      const conn = state.connections.get("c1")!;
      expect(conn.status).toBe("REAUTH_REQUIRED");
      expect(conn.leaseOwner).toBeNull();
      expect(JSON.stringify(state.logs)).not.toContain("RT-OLD");
      expect(conn.lastError ?? "").not.toContain("RT-OLD");
    },
  );

  it("401 persistente após o refresh → REAUTH_REQUIRED (não fica em loop)", async () => {
    const { store, state } = setup(3_600_000);
    const { fetch, calls } = scriptedFetch({
      token: [() => tokenResponse({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 })],
      graph: [
        () => tokenResponse({}, 401),
        () => tokenResponse({}, 401),
      ],
    });
    const result = await syncCalendarConnection("c1", {
      store,
      owner: "t",
      now: () => new Date(NOW),
      internalDomains: [],
      graphFor: (c) =>
        createHttpGraphClient({ tokens: createTokenProvider({ store, connection: c, credentials: creds, fetch, now: () => NOW }), fetch }),
    });
    expect(result).toMatchObject({ status: "error", connectionStatus: "REAUTH_REQUIRED" });
    expect(calls.filter((c) => c.auth)).toHaveLength(2);
    // A rotação obtida antes do 401 final continua persistida.
    expect(decryptField(ENCRYPTED_FIELDS.m365RefreshToken, state.connections.get("c1")!.refreshTokenEncrypted!)).toBe("RT-NEW");
  });

  it("sem refresh token guardado → REAUTH_REQUIRED sem chamar o token endpoint", async () => {
    const { store, state } = setup(0);
    state.connections.get("c1")!.refreshTokenEncrypted = null;
    const fetch = vi.fn();
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    await expect(provider.get()).rejects.toMatchObject({ kind: "reauth" });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
  });

  it("refresh token ilegível (cifra de outro campo) → REAUTH_REQUIRED", async () => {
    const { store, state } = setup(0);
    // Ciphertext do ACCESS token no lugar do refresh: AAD diferente → falha ao decifrar.
    state.connections.get("c1")!.refreshTokenEncrypted = encryptAccessToken("RT-OLD");
    const fetch = vi.fn();
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    await expect(provider.get()).rejects.toMatchObject({ kind: "reauth", code: "token_decrypt_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falha transitória (500/rede) no refresh não marca REAUTH", async () => {
    const { store, state } = setup(0);
    const fetch = vi.fn(async () => tokenResponse({ error: "temporarily_unavailable" }, 503));
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    await expect(provider.get()).rejects.toMatchObject({ kind: "http" });
    expect(state.connections.get("c1")!.status).toBe("ACTIVE");
  });
});

describe("tokens nunca aparecem em log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sync completo (refresh + 401 + 500) não escreve token em console, IntegrationEvent ou lastError", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { store, state } = setup(0);
    const { fetch } = scriptedFetch({
      token: [
        () => tokenResponse({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 }),
        () => tokenResponse({ access_token: "AT-NEWER", refresh_token: "RT-NEWER", expires_in: 3600 }),
      ],
      graph: [
        () => tokenResponse({}, 401),
        () => tokenResponse({ error: { code: "generalException", message: "Bearer AT-NEWER falhou" } }, 500),
      ],
    });
    await syncCalendarConnection("c1", {
      store,
      owner: "t",
      now: () => new Date(NOW),
      internalDomains: [],
      graphFor: (c) =>
        createHttpGraphClient({ tokens: createTokenProvider({ store, connection: c, credentials: creds, fetch, now: () => NOW }), fetch }),
    });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    const persisted = JSON.stringify({ logs: state.logs, lastError: state.connections.get("c1")!.lastError });
    for (const secret of SECRETS) {
      expect(logged).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(state.connections.get("c1")!.lastError).toBe("http:500:generalException");
    // Tokens persistidos estão cifrados (nunca em claro na conexão).
    const conn = state.connections.get("c1")!;
    for (const secret of SECRETS) {
      expect(conn.accessTokenEncrypted).not.toContain(secret);
      expect(conn.refreshTokenEncrypted).not.toContain(secret);
    }
  });

  it("mensagens de erro do token endpoint não carregam o refresh token", async () => {
    const { store } = setup(0);
    const fetch = vi.fn(async () => tokenResponse({ error: "invalid_grant", error_description: "RT-OLD" }, 400));
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    const error = (await provider.get().catch((e: unknown) => e)) as Error;
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("RT-OLD");
  });
});
