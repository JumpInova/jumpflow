import { describe, expect, it, vi } from "vitest";
import { ENCRYPTED_FIELDS, encryptField } from "@jumpflow/database/field-encryption";
import { completeM365Callback, readOAuthCookie, startM365Connect } from "./connect-flow";
import { createFakeGraphClient } from "./graph/fake";
import { buildAuthorizeUrl } from "./oauth";
import {
  ForbiddenScopeError,
  M1_SCOPES,
  M2_SCOPES,
  assertScopesForPhase,
  consentedPhase,
  phaseGrantedScopes,
} from "./scopes";
import { addConnection, createMemoryStore } from "./testing/memory-store";
import { createTokenProvider, encryptAccessToken, encryptRefreshToken, encryptTokenSet } from "./tokens";

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { clientId: "client-1", clientSecret: "s3cret", tenantId: TENANT };
const REDIRECT = "https://flow.example.com/api/integrations/m365/callback";
const SECRET = "state-secret";
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function tokenFetch(scope: string) {
  const bodies: URLSearchParams[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return new Response(
      JSON.stringify({
        access_token: "AT-1",
        refresh_token: "RT-1",
        expires_in: 3600,
        scope,
        id_token: jwt({ tid: TENANT }),
      }),
      { status: 200 },
    );
  });
  return { fetch, bodies };
}

function begin(phase?: "M1" | "M2") {
  const start = startM365Connect({
    userId: "user-1",
    userEmail: "gestor@jump.com.br",
    credentials: creds,
    redirectUri: REDIRECT,
    stateSecret: SECRET,
    nowMs: NOW,
    phase,
  });
  const url = new URL(start.authorizeUrl);
  return { url, state: url.searchParams.get("state")!, cookie: readOAuthCookie(start.cookieValue) };
}

const graph = () => createFakeGraphClient({ me: { id: "g1", mail: "gestor@jump.com.br", userPrincipalName: "gestor@jump.com.br" } });

describe("escopos da M2", () => {
  it("M2 = M1 + Mail.Read (só leitura); M1 não aceita Mail.Read", () => {
    expect(M2_SCOPES).toEqual([...M1_SCOPES, "Mail.Read"]);
    expect(() => assertScopesForPhase("openid Mail.Read", "M1")).toThrow(ForbiddenScopeError);
    expect(assertScopesForPhase(M2_SCOPES, "M2")).toEqual([...M2_SCOPES]);
  });

  it("proibidos continuam recusados na M2, inclusive escondidos em string com espaços", () => {
    for (const bad of [
      "openid Mail.Read Mail.Send",
      "Mail.Read\tMail.ReadWrite",
      "Mail.Read https://graph.microsoft.com/Mail.Send",
      "Mail.Read Chat.Read",
      "Mail.Read Mail.Read.Shared",
      "Mail.Read Mail.ReadBasic.All",
    ]) {
      expect(() =>
        buildAuthorizeUrl({
          credentials: creds,
          redirectUri: REDIRECT,
          scopes: bad,
          phase: "M2",
          state: "s",
          codeChallenge: "c",
        }),
      ).toThrow(ForbiddenScopeError);
    }
  });

  it("fase consentida vem dos escopos gravados", () => {
    expect(consentedPhase(["openid", "Calendars.Read"])).toBe("M1");
    expect(consentedPhase(["Calendars.Read", "https://graph.microsoft.com/Mail.Read"])).toBe("M2");
    expect(phaseGrantedScopes(["openid", "Calendars.Read", "Mail.Read", "Files.Read"], "M2")).toEqual([
      "openid",
      "Calendars.Read",
      "Mail.Read",
    ]);
  });
});

describe("consentimento incremental (Ativar atas por e-mail)", () => {
  it("início M2 pede M1 + Mail.Read e guarda a fase no cookie cifrado", () => {
    const { url, cookie } = begin("M2");
    expect(url.searchParams.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read Mail.Read");
    expect(cookie?.phase).toBe("M2");
    expect(begin().url.searchParams.get("scope")).not.toContain("Mail.Read");
  });

  it("cookie antigo sem fase = M1; fase desconhecida é recusada", () => {
    const legacy = encryptField(
      ENCRYPTED_FIELDS.m365OAuthCookie,
      JSON.stringify({ nonce: "n", verifier: "v", userId: "u", exp: 9_999_999_999 }),
    );
    expect(readOAuthCookie(legacy)?.phase).toBe("M1");
    const weird = encryptField(
      ENCRYPTED_FIELDS.m365OAuthCookie,
      JSON.stringify({ nonce: "n", verifier: "v", userId: "u", exp: 9_999_999_999, phase: "M9" }),
    );
    expect(readOAuthCookie(weird)).toBeNull();
  });

  it("callback M2: troca o code pedindo os escopos M2 e grava Mail.Read", async () => {
    const { state, cookie } = begin("M2");
    const tf = tokenFetch("openid profile offline_access User.Read Calendars.Read Mail.Read");
    const r = await completeM365Callback(
      { code: "C", state, error: null, cookie, userId: "user-1", userEmail: "gestor@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tf.fetch, nowMs: NOW + 1000, graphWithToken: graph },
    );
    expect(r).toMatchObject({ ok: true, account: { phase: "M2", mailScopeMissing: false } });
    expect(tf.bodies[0].get("scope")).toContain("Mail.Read");
    if (!r.ok) throw new Error();
    expect(encryptTokenSet(r.account.tokens, null, r.account.phase).scopes).toContain("Mail.Read");
  });

  it("callback M2 sem Mail.Read concedido: conecta a agenda e sinaliza (sem gravar Mail.Read)", async () => {
    const { state, cookie } = begin("M2");
    const tf = tokenFetch("openid profile offline_access User.Read Calendars.Read");
    const r = await completeM365Callback(
      { code: "C", state, error: null, cookie, userId: "user-1", userEmail: "gestor@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tf.fetch, nowMs: NOW + 1000, graphWithToken: graph },
    );
    expect(r).toMatchObject({ ok: true, account: { mailScopeMissing: true } });
    if (!r.ok) throw new Error();
    expect(encryptTokenSet(r.account.tokens, null, "M2").scopes).not.toContain("Mail.Read");
  });

  it("callback M2 recusa Mail.Send concedido (forbidden_scope, nada gravado)", async () => {
    const { state, cookie } = begin("M2");
    const tf = tokenFetch("openid Calendars.Read Mail.Read Mail.Send");
    const r = await completeM365Callback(
      { code: "C", state, error: null, cookie, userId: "user-1", userEmail: "gestor@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tf.fetch, nowMs: NOW + 1000, graphWithToken: graph },
    );
    expect(r).toEqual({ ok: false, code: "forbidden_scope" });
  });
});

describe("refresh pela fase EFETIVAMENTE consentida", () => {
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

  it("M2 consentida → pede M1 + Mail.Read (nunca além) e mantém Mail.Read", async () => {
    const { store, state } = setup([...M2_SCOPES]);
    const tf = tokenFetch("openid profile offline_access User.Read Calendars.Read Mail.Read OnlineMeetings.Read");
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch: tf.fetch, now: () => NOW });
    await provider.refresh();
    expect(tf.bodies[0].get("scope")).toBe("openid profile offline_access User.Read Calendars.Read Mail.Read");
    expect(state.connections.get("c1")!.scopes).toEqual([...M2_SCOPES]);
  });

  it("M1 consentida → refresh nunca pede Mail.Read", async () => {
    const { store } = setup(["openid", "Calendars.Read"]);
    const tf = tokenFetch("openid Calendars.Read");
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch: tf.fetch, now: () => NOW });
    await provider.refresh();
    expect(tf.bodies[0].get("scope")).not.toContain("Mail.Read");
  });

  it("Mail.Read retirado (consent_required) → recua para M1 uma vez; agenda continua", async () => {
    const { store, state } = setup([...M2_SCOPES]);
    const bodies: URLSearchParams[] = [];
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      bodies.push(body);
      if (body.get("scope")!.includes("Mail.Read")) {
        return new Response(JSON.stringify({ error: "consent_required" }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600, scope: "openid Calendars.Read" }), { status: 200 });
    });
    const provider = createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
    expect(await provider.refresh()).toBe("AT-2");
    expect(bodies).toHaveLength(2);
    expect(state.connections.get("c1")!.status).toBe("ACTIVE");
    expect(state.connections.get("c1")!.scopes).toEqual(["openid", "Calendars.Read"]);
  });
});
