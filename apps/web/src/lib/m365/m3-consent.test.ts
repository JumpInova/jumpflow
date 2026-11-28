import { describe, expect, it, vi } from "vitest";
import { ENCRYPTED_FIELDS, encryptField } from "@jumpflow/database/field-encryption";
import { readOAuthCookie, startM365Connect } from "./connect-flow";
import { buildAuthorizeUrl } from "./oauth";
import {
  ForbiddenScopeError,
  M1_SCOPES,
  assertScopesForPhase,
  consentedCapabilities,
  consentedPhase,
  refreshFallbacks,
  requestedCapabilities,
  scopesForCapabilities,
} from "./scopes";
import { addConnection, createMemoryStore } from "./testing/memory-store";
import { createTokenProvider, encryptAccessToken, encryptRefreshToken } from "./tokens";

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { clientId: "client-1", clientSecret: "s3cret", tenantId: TENANT };
const REDIRECT = "https://flow.example.com/api/integrations/m365/callback";
const NOW = 1_800_000_000_000;
const BASE = M1_SCOPES.join(" ");
const TEAMS = ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"];

describe("conjunto de capacidades consentidas (M1 / +e-mail / +Teams, independentes)", () => {
  it("escopos exatos por conjunto, ordem fixa", () => {
    expect(scopesForCapabilities([])).toEqual([...M1_SCOPES]);
    expect(scopesForCapabilities(["TEAMS"])).toEqual([...M1_SCOPES, ...TEAMS]);
    expect(scopesForCapabilities(["TEAMS", "MAIL", "MAIL"])).toEqual([...M1_SCOPES, "Mail.Read", ...TEAMS]);
  });

  it("capacidades a partir dos escopos gravados; Teams exige OS DOIS escopos", () => {
    expect(consentedCapabilities([...M1_SCOPES])).toEqual([]);
    expect(consentedCapabilities([...M1_SCOPES, ...TEAMS])).toEqual(["TEAMS"]);
    expect(consentedCapabilities([...M1_SCOPES, "Mail.Read", "https://graph.microsoft.com/OnlineMeetings.Read"])).toEqual(["MAIL"]);
    expect(consentedPhase([...M1_SCOPES, ...TEAMS])).toBe("M3");
  });

  it("pedido incremental soma a capacidade nova às consentidas", () => {
    expect(requestedCapabilities("M3", [...M1_SCOPES])).toEqual(["TEAMS"]);
    expect(requestedCapabilities("M3", [...M1_SCOPES, "Mail.Read"])).toEqual(["MAIL", "TEAMS"]);
    expect(requestedCapabilities("M2", [...M1_SCOPES, ...TEAMS])).toEqual(["MAIL", "TEAMS"]);
    expect(requestedCapabilities("M1", [...M1_SCOPES, ...TEAMS])).toEqual(["TEAMS"]);
  });

  it("recuo do refresh: conjunto → sem Teams → sem e-mail → base, sem repetir", () => {
    expect(refreshFallbacks(["MAIL", "TEAMS"])).toEqual([["MAIL", "TEAMS"], ["MAIL"], ["TEAMS"], []]);
    expect(refreshFallbacks(["TEAMS"])).toEqual([["TEAMS"], []]);
    expect(refreshFallbacks([])).toEqual([[]]);
  });
});

describe("buildAuthorizeUrl com Teams: só o conjunto, proibidos sempre recusados", () => {
  const input = (scopes: string | string[], phase: Parameters<typeof buildAuthorizeUrl>[0]["phase"]) => ({
    credentials: creds,
    redirectUri: REDIRECT,
    scopes,
    phase,
    state: "s",
    codeChallenge: "c",
  });

  it("aceita M1 + Teams; recusa Mail.Read fora do conjunto pedido", () => {
    const url = new URL(buildAuthorizeUrl(input(scopesForCapabilities(["TEAMS"]), ["TEAMS"])));
    expect(url.searchParams.get("scope")).toBe(`${BASE} ${TEAMS.join(" ")}`);
    expect(() => buildAuthorizeUrl(input(`${BASE} Mail.Read`, ["TEAMS"]))).toThrow(ForbiddenScopeError);
    expect(() => buildAuthorizeUrl(input(`${BASE} ${TEAMS.join(" ")}`, []))).toThrow(ForbiddenScopeError);
  });

  it.each([
    "OnlineMeetings.ReadWrite",
    "OnlineMeetingArtifact.Read.All",
    "OnlineMeetingRecording.Read.All",
    "Chat.Read",
    "ChatMessage.Read",
    "Mail.Send",
    "Mail.ReadWrite",
    "Calendars.ReadWrite",
    "https://graph.microsoft.com/.default",
  ])("recusa %s mesmo escondido numa string com espaços", (bad) => {
    expect(() => buildAuthorizeUrl(input(`${BASE} ${TEAMS.join(" ")}\t${bad}`, ["MAIL", "TEAMS"]))).toThrow(ForbiddenScopeError);
    expect(() => assertScopesForPhase(`openid ${bad}`, "M3")).toThrow(ForbiddenScopeError);
  });
});

describe("início/cookie do consentimento M3", () => {
  const begin = (capabilities?: Array<"MAIL" | "TEAMS">) =>
    startM365Connect({
      userId: "user-1",
      userEmail: "gestor@jump.com.br",
      credentials: creds,
      redirectUri: REDIRECT,
      stateSecret: "s",
      nowMs: NOW,
      phase: "M3",
      capabilities,
    });

  it("M3 sem e-mail pede só base + Teams; com e-mail consentido mantém Mail.Read; caps no cookie cifrado", () => {
    const a = begin();
    expect(new URL(a.authorizeUrl).searchParams.get("scope")).toBe(`${BASE} ${TEAMS.join(" ")}`);
    expect(readOAuthCookie(a.cookieValue)).toMatchObject({ phase: "M3", caps: ["TEAMS"] });
    const b = begin(["MAIL"]);
    expect(new URL(b.authorizeUrl).searchParams.get("scope")).toBe(`${BASE} Mail.Read ${TEAMS.join(" ")}`);
    expect(readOAuthCookie(b.cookieValue)?.caps).toEqual(["MAIL", "TEAMS"]);
  });

  it("cookie com capacidade desconhecida é recusado; cookie M2 antigo (sem caps) = [MAIL]", () => {
    const bad = encryptField(
      ENCRYPTED_FIELDS.m365OAuthCookie,
      JSON.stringify({ nonce: "n", verifier: "v", userId: "u", exp: 9_999_999_999, phase: "M3", caps: ["TEAMS", "CHAT"] }),
    );
    expect(readOAuthCookie(bad)).toBeNull();
    const legacy = encryptField(
      ENCRYPTED_FIELDS.m365OAuthCookie,
      JSON.stringify({ nonce: "n", verifier: "v", userId: "u", exp: 9_999_999_999, phase: "M2" }),
    );
    expect(readOAuthCookie(legacy)?.caps).toEqual(["MAIL"]);
  });
});

describe("refresh pelo conjunto consentido, recuo em consent_required sem derrubar o resto", () => {
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
  function endpoint(decide: (scope: string) => { ok: true; scope: string } | { ok: false; body: Record<string, unknown> }) {
    const asked: string[] = [];
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      const scope = new URLSearchParams(String(init?.body)).get("scope")!;
      asked.push(scope);
      const r = decide(scope);
      return r.ok
        ? new Response(JSON.stringify({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600, scope: r.scope }), { status: 200 })
        : new Response(JSON.stringify(r.body), { status: 400 });
    });
    return { fetch, asked };
  }
  const provider = async (store: ReturnType<typeof setup>["store"], fetch: ReturnType<typeof endpoint>["fetch"]) =>
    createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });

  it("M1 + Teams (sem e-mail): pede exatamente base + Teams, nunca Mail.Read", async () => {
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint((scope) => ({ ok: true, scope }));
    await (await provider(store, ep.fetch)).refresh();
    expect(ep.asked).toEqual([`${BASE} ${TEAMS.join(" ")}`]);
    expect(state.connections.get("c1")!.scopes).toEqual([...M1_SCOPES, ...TEAMS]);
  });

  it("admin retirou o consentimento do Teams (invalid_grant + suberror consent_required): recua sem Teams, e-mail e agenda seguem", async () => {
    const { store, state } = setup([...M1_SCOPES, "Mail.Read", ...TEAMS]);
    const ep = endpoint((scope) =>
      scope.includes("OnlineMeeting")
        ? { ok: false, body: { error: "invalid_grant", suberror: "consent_required", error_codes: [65001] } }
        : { ok: true, scope },
    );
    expect(await (await provider(store, ep.fetch)).refresh()).toBe("AT-2");
    expect(ep.asked).toEqual([`${BASE} Mail.Read ${TEAMS.join(" ")}`, `${BASE} Mail.Read`]);
    expect(state.connections.get("c1")!.status).toBe("ACTIVE");
    expect(state.connections.get("c1")!.scopes).toEqual([...M1_SCOPES, "Mail.Read"]);
  });

  it("só a base funciona: tenta cada conjunto UMA vez (4 chamadas, sem laço) e fica com a agenda", async () => {
    const { store, state } = setup([...M1_SCOPES, "Mail.Read", ...TEAMS]);
    const ep = endpoint((scope) => (scope === BASE ? { ok: true, scope } : { ok: false, body: { error: "invalid_scope" } }));
    await (await provider(store, ep.fetch)).refresh();
    expect(ep.asked).toEqual([
      `${BASE} Mail.Read ${TEAMS.join(" ")}`,
      `${BASE} Mail.Read`,
      `${BASE} ${TEAMS.join(" ")}`,
      BASE,
    ]);
    expect(state.connections.get("c1")!.scopes).toEqual([...M1_SCOPES]);
  });

  it("invalid_grant puro (refresh revogado) → REAUTH_REQUIRED sem recuo", async () => {
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint(() => ({ ok: false, body: { error: "invalid_grant" } }));
    await expect((await provider(store, ep.fetch)).refresh()).rejects.toMatchObject({ kind: "reauth" });
    expect(ep.asked).toHaveLength(1);
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
  });

  it("nenhum token aparece em logs/console durante o recuo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, state } = setup([...M1_SCOPES, ...TEAMS]);
    const ep = endpoint((scope) => (scope.includes("Online") ? { ok: false, body: { error: "consent_required" } } : { ok: true, scope }));
    await (await provider(store, ep.fetch)).refresh();
    const dump = JSON.stringify([state.logs, spy.mock.calls, state.connections.get("c1")!.lastError]);
    for (const secret of ["RT-OLD", "RT-2", "AT-2", "AT-OLD"]) expect(dump).not.toContain(secret);
    spy.mockRestore();
  });
});
