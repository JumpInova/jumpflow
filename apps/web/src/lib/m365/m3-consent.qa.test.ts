import { describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl } from "./oauth";
import {
  ForbiddenScopeError,
  M1_SCOPES,
  assertScopesForPhase,
  consentedCapabilities,
  isForbiddenScope,
  requestedCapabilities,
  scopesForCapabilities,
} from "./scopes";
import { addConnection, createMemoryStore } from "./testing/memory-store";
import { createTokenProvider, encryptAccessToken, encryptRefreshToken } from "./tokens";

/**
 * M3 — QA do consentimento por conjunto de capacidades (testador). Token
 * endpoint mockado; nada real.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { clientId: "client-1", clientSecret: "s3cret", tenantId: TENANT };
const REDIRECT = "https://flow.example.com/api/integrations/m365/callback";
const NOW = 1_800_000_000_000;
const BASE = M1_SCOPES.join(" ");
const TEAMS = ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"];
const T = TEAMS.join(" ");

function setup(scopes: string[]) {
  const { store, state } = createMemoryStore();
  addConnection(state, {
    id: "c1",
    userId: "u1",
    accessTokenEncrypted: encryptAccessToken("AT-OLD"),
    refreshTokenEncrypted: encryptRefreshToken("RT-OLD"),
    expiresAt: new Date(NOW - 1),
    scopes,
  });
  return { store, state };
}

type Reply = { ok: true; scope: string } | { ok: false; body: Record<string, unknown> };
function endpoint(decide: (scope: string, n: number) => Reply) {
  const asked: string[] = [];
  const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
    const scope = new URLSearchParams(String(init?.body)).get("scope")!;
    asked.push(scope);
    const r = decide(scope, asked.length);
    return r.ok
      ? new Response(JSON.stringify({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600, scope: r.scope }), { status: 200 })
      : new Response(JSON.stringify(r.body), { status: 400 });
  });
  return { fetch, asked };
}
async function refresh(store: ReturnType<typeof setup>["store"], fetch: ReturnType<typeof endpoint>["fetch"]) {
  return (await createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW })).refresh();
}

describe("refresh por conjunto — recuo em cascata (complementos)", () => {
  it("só o e-mail foi retirado: recua até base + Teams e MANTÉM Teams e agenda", async () => {
    const { store, state } = setup([...M1_SCOPES, "Mail.Read", ...TEAMS]);
    const ep = endpoint((scope) => (scope.includes("Mail.Read") ? { ok: false, body: { error: "consent_required" } } : { ok: true, scope }));
    expect(await refresh(store, ep.fetch)).toBe("AT-2");
    expect(ep.asked).toEqual([`${BASE} Mail.Read ${T}`, `${BASE} Mail.Read`, `${BASE} ${T}`]);
    expect(state.connections.get("c1")!).toMatchObject({ status: "ACTIVE", scopes: [...M1_SCOPES, ...TEAMS] });
  });

  it("M1 + Teams com Teams retirado (AADSTS65001 só na descrição): recua para a base, agenda segue", async () => {
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint((scope) =>
      scope.includes("Online")
        ? { ok: false, body: { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented" } }
        : { ok: true, scope },
    );
    await refresh(store, ep.fetch);
    expect(ep.asked).toEqual([`${BASE} ${T}`, BASE]);
    expect(state.connections.get("c1")!).toMatchObject({ status: "ACTIVE", scopes: [...M1_SCOPES] });
    expect(consentedCapabilities(state.connections.get("c1")!.scopes)).toEqual([]);
  });

  it("invalid_grant real no MEIO da cascata → para ali e vai a REAUTH (sem tentar os demais)", async () => {
    const { store, state } = setup([...M1_SCOPES, "Mail.Read", ...TEAMS]);
    const ep = endpoint((_s, n) => (n === 1 ? { ok: false, body: { error: "invalid_scope" } } : { ok: false, body: { error: "invalid_grant" } }));
    await expect(refresh(store, ep.fetch)).rejects.toMatchObject({ kind: "reauth" });
    expect(ep.asked).toHaveLength(2);
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
  });

  it("invalid_grant com outro suberror (bad_token) não recua: REAUTH com 1 chamada", async () => {
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint(() => ({ ok: false, body: { error: "invalid_grant", suberror: "bad_token" } }));
    await expect(refresh(store, ep.fetch)).rejects.toMatchObject({ kind: "reauth" });
    expect(ep.asked).toHaveLength(1);
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
  });

  it("todos os conjuntos recusados com consent_required → no máximo 4 chamadas e REAUTH (sem laço)", async () => {
    const { store, state } = setup([...M1_SCOPES, "Mail.Read", ...TEAMS]);
    const ep = endpoint(() => ({ ok: false, body: { error: "consent_required" } }));
    await expect(refresh(store, ep.fetch)).rejects.toBeTruthy();
    expect(ep.asked).toHaveLength(4);
    expect(state.connections.get("c1")!.status).not.toBe("ACTIVE");
  });

  it("só UM escopo do Teams gravado: refresh pede só a base (nunca escopo solto do Teams)", async () => {
    const { store, state } = setup([...M1_SCOPES, "OnlineMeetings.Read"]);
    const ep = endpoint((scope) => ({ ok: true, scope }));
    await refresh(store, ep.fetch);
    expect(ep.asked).toEqual([BASE]);
    expect(state.connections.get("c1")!.scopes).toEqual([...M1_SCOPES]);
  });

  it("token devolve escopos além do pedido (Mail.Read, Chat.Read, OnlineMeetings.ReadWrite): nada disso é gravado", async () => {
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint(() => ({ ok: true, scope: `${BASE} ${T} Mail.Read Chat.Read OnlineMeetings.ReadWrite` }));
    await refresh(store, ep.fetch);
    expect(state.connections.get("c1")!.scopes).toEqual([...M1_SCOPES, ...TEAMS]);
  });

  it("escopo com prefixo do recurso/caixa diferente é gravado canônico (o job usa hasEvery dos nomes exatos)", async () => {
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint(() => ({
      ok: true,
      scope: `openid profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/calendars.read https://graph.microsoft.com/OnlineMeetings.Read https://graph.microsoft.com/onlinemeetingtranscript.read.all`,
    }));
    await refresh(store, ep.fetch);
    expect(state.connections.get("c1")!.scopes).toEqual([...M1_SCOPES, ...TEAMS]);
  });
});

describe("authorize: conjunto exato e escopos proibidos", () => {
  const input = (scopes: string | string[], phase: Parameters<typeof buildAuthorizeUrl>[0]["phase"]) => ({
    credentials: creds,
    redirectUri: REDIRECT,
    scopes,
    phase,
    state: "s",
    codeChallenge: "c",
  });

  it.each([
    "User.Read.All",
    "Calendars.Read.All",
    "OnlineMeetings.ReadWrite.All",
    "OnlineMeetingTranscript.ReadWrite.All",
    "https://graph.microsoft.com/Chat.ReadBasic",
    "ChannelMessage.Read.All",
    "Mail.Send.Shared",
    "MAIL.READWRITE",
    "api://outro/.default",
  ])("%s é proibido em qualquer conjunto", (bad) => {
    expect(isForbiddenScope(bad)).toBe(true);
    expect(() => buildAuthorizeUrl(input([...scopesForCapabilities(["MAIL", "TEAMS"]), bad], ["MAIL", "TEAMS"]))).toThrow(ForbiddenScopeError);
  });

  it("escopo de Teams com prefixo/caixa é aceito só dentro do conjunto Teams", () => {
    const scopes = `${BASE} https://graph.microsoft.com/onlinemeetings.read ONLINEMEETINGTRANSCRIPT.READ.ALL`;
    expect(() => buildAuthorizeUrl(input(scopes, ["TEAMS"]))).not.toThrow();
    expect(() => buildAuthorizeUrl(input(scopes, ["MAIL"]))).toThrow(ForbiddenScopeError);
    expect(() => assertScopesForPhase(scopes, "M2")).toThrow(ForbiddenScopeError);
  });

  it("separadores escondidos (tab, quebra de linha, espaços múltiplos) não contrabandeiam escopo", () => {
    expect(() => buildAuthorizeUrl(input(`${BASE}\n${T}\r\nChat.Read`, ["TEAMS"]))).toThrow(ForbiddenScopeError);
    expect(() => buildAuthorizeUrl(input([`${BASE}   ${T}`, "Mail.Read"], ["TEAMS"]))).toThrow(ForbiddenScopeError);
  });

  it("pedido incremental: Teams nunca entra sem pedido e capacidades desconhecidas não somam", () => {
    expect(requestedCapabilities("M2", [...M1_SCOPES])).toEqual(["MAIL"]);
    expect(requestedCapabilities("M1", [...M1_SCOPES, "OnlineMeetings.Read"])).toEqual([]);
    expect(requestedCapabilities("M1", [...M1_SCOPES, "Chat.Read", "Mail.Send"])).toEqual([]);
  });
});
