import { describe, expect, it, vi } from "vitest";
import { ENCRYPTED_FIELDS, decryptField } from "@jumpflow/database/field-encryption";
import { GraphError } from "./graph/errors";
import { addConnection, createMemoryStore } from "./testing/memory-store";
import { ConnectionChangedError } from "./store";
import { REFRESH_SKEW_MS, createTokenProvider, encryptAccessToken, encryptRefreshToken } from "./tokens";

const creds = { clientId: "c", clientSecret: "s", tenantId: "t" };
const NOW = 1_800_000_000_000;

function setup(expiresInMs: number) {
  const { store, state } = createMemoryStore();
  addConnection(state, {
    id: "c1",
    userId: "u1",
    accessTokenEncrypted: encryptAccessToken("AT-OLD"),
    refreshTokenEncrypted: encryptRefreshToken("RT-OLD"),
    expiresAt: new Date(NOW + expiresInMs),
    scopes: ["openid", "Calendars.Read"],
  });
  return { store, state };
}

function okFetch(body: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetch, calls };
}

describe("tokens cifrados + refresh", () => {
  it("usa o access token atual quando falta mais de 5 min para expirar", async () => {
    const { store, state } = setup(REFRESH_SKEW_MS + 60_000);
    const { fetch } = okFetch({});
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    expect(await provider.get()).toBe("AT-OLD");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.connections.get("c1")!.accessTokenEncrypted).not.toContain("AT-OLD");
  });

  it("renova 5 min antes de expirar e PERSISTE o refresh token rotacionado (cifrado)", async () => {
    const { store, state } = setup(REFRESH_SKEW_MS - 1);
    const { fetch, calls } = okFetch({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600, scope: "openid Calendars.Read" });
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    expect(await provider.get()).toBe("AT-NEW");
    expect(calls[0].get("grant_type")).toBe("refresh_token");
    expect(calls[0].get("refresh_token")).toBe("RT-OLD");
    const conn = state.connections.get("c1")!;
    expect(conn.refreshTokenEncrypted).not.toContain("RT-NEW");
    expect(decryptField(ENCRYPTED_FIELDS.m365RefreshToken, conn.refreshTokenEncrypted!)).toBe("RT-NEW");
    expect(decryptField(ENCRYPTED_FIELDS.m365AccessToken, conn.accessTokenEncrypted!)).toBe("AT-NEW");
    expect(conn.expiresAt!.getTime()).toBe(NOW + 3600_000);
  });

  it("sem refresh token novo na resposta, mantém o anterior", async () => {
    const { store, state } = setup(0);
    const { fetch } = okFetch({ access_token: "AT-NEW", expires_in: 3600 });
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    await provider.refresh();
    const conn = state.connections.get("c1")!;
    expect(decryptField(ENCRYPTED_FIELDS.m365RefreshToken, conn.refreshTokenEncrypted!)).toBe("RT-OLD");
    expect(conn.scopes).toEqual(["openid", "Calendars.Read"]);
  });

  it("invalid_grant → REAUTH_REQUIRED e GraphError reauth", async () => {
    const { store, state } = setup(0);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    await expect(provider.get()).rejects.toMatchObject({ kind: "reauth" });
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
    expect(state.connections.get("c1")!.lastError).toBe("invalid_grant");
  });

  it("invalid_client → erro de configuração (não pede reconexão ao usuário)", async () => {
    const { store, state } = setup(0);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    const error = await provider.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).kind).toBe("config");
    expect(state.connections.get("c1")!.status).toBe("ACTIVE");
  });
});

describe("correções M1 (validador) — escopos da fase e corrida com desconectar", () => {
  it("refresh pede SEMPRE os escopos da M1 e grava só os concedidos dentro da fase", async () => {
    const { store, state } = setup(0);
    state.connections.get("c1")!.scopes = ["openid", "Calendars.Read", "Mail.Read"];
    const { fetch, calls } = okFetch({
      access_token: "AT-NEW",
      refresh_token: "RT-NEW",
      expires_in: 3600,
      scope: "openid profile offline_access User.Read Calendars.Read Mail.Read",
    });
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    await provider.refresh();
    expect(calls[0].get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
    expect(state.connections.get("c1")!.scopes).toEqual(["openid", "profile", "offline_access", "User.Read", "Calendars.Read"]);
  });

  it("desconectado durante o refresh: tokens não ressuscitam", async () => {
    const { store, state } = setup(0);
    const conn = state.connections.get("c1")!;
    conn.leaseOwner = "rodada-1";
    const fetch = vi.fn(async () => {
      Object.assign(conn, { status: "DISCONNECTED", accessTokenEncrypted: null, refreshTokenEncrypted: null, leaseOwner: null });
      return new Response(JSON.stringify({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 }), { status: 200 });
    });
    const provider = createTokenProvider({
      store,
      connection: (await store.getConnection("c1"))!,
      credentials: creds,
      fetch,
      now: () => NOW,
      leaseOwner: "rodada-1",
    });
    await expect(provider.get()).rejects.toBeInstanceOf(ConnectionChangedError);
    expect(conn.status).toBe("DISCONNECTED");
    expect(conn.accessTokenEncrypted).toBeNull();
    expect(conn.refreshTokenEncrypted).toBeNull();
  });
});
