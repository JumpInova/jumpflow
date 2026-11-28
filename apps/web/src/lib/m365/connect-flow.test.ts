import { describe, expect, it } from "vitest";
import { completeM365Callback, readOAuthCookie, startM365Connect } from "./connect-flow";
import { createFakeGraphClient } from "./graph/fake";
import { GraphError } from "./graph/errors";

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { clientId: "client-1", clientSecret: "s3cret", tenantId: TENANT };
const REDIRECT = "https://flow.example.com/api/integrations/m365/callback";
const SECRET = "state-secret";
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function tokenFetch(overrides: Record<string, unknown> = {}, status = 200) {
  const bodies: URLSearchParams[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return new Response(
      JSON.stringify({
        access_token: "AT-1",
        refresh_token: "RT-1",
        expires_in: 3600,
        scope: "openid profile offline_access User.Read Calendars.Read",
        id_token: jwt({ tid: TENANT, oid: "oid-1" }),
        ...overrides,
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, bodies };
}

function begin(userId = "user-1") {
  const start = startM365Connect({
    userId,
    userEmail: "ana@jump.com.br",
    credentials: creds,
    redirectUri: REDIRECT,
    stateSecret: SECRET,
    nowMs: NOW,
  });
  const url = new URL(start.authorizeUrl);
  return { start, state: url.searchParams.get("state")!, cookie: readOAuthCookie(start.cookieValue) };
}

function graph(mail = "ana@jump.com.br", upn = "ana@jump.com.br") {
  return () => createFakeGraphClient({ me: { id: "graph-ana", mail, userPrincipalName: upn } });
}

describe("startM365Connect", () => {
  it("guarda nonce + verifier SÓ no cookie cifrado (não em claro)", () => {
    const { start, cookie } = begin();
    expect(start.cookieValue.startsWith("enc:v1:")).toBe(true);
    expect(start.cookieValue).not.toContain(cookie!.verifier);
    expect(start.authorizeUrl).not.toContain(cookie!.verifier);
    expect(cookie).toMatchObject({ userId: "user-1" });
    expect(readOAuthCookie("adulterado")).toBeNull();
  });
});

describe("completeM365Callback", () => {
  it("fluxo feliz: troca o code com o code_verifier e confere tenant e /me", async () => {
    const { state, cookie } = begin();
    const tf = tokenFetch();
    const result = await completeM365Callback(
      { code: "CODE", state, error: null, cookie, userId: "user-1", userEmail: "Ana@Jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tf.fetch, nowMs: NOW + 1000, graphWithToken: graph() },
    );
    expect(result).toMatchObject({ ok: true, account: { tenantId: TENANT, graphUserId: "graph-ana", mailbox: "ana@jump.com.br" } });
    expect(tf.bodies[0].get("code_verifier")).toBe(cookie!.verifier);
    expect(tf.bodies[0].get("grant_type")).toBe("authorization_code");
    expect(tf.bodies[0].get("redirect_uri")).toBe(REDIRECT);
  });

  it("consentimento negado pela Microsoft", async () => {
    const { state, cookie } = begin();
    const r = await completeM365Callback(
      { code: null, state, error: "access_denied", cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tokenFetch().fetch, nowMs: NOW, graphWithToken: graph() },
    );
    expect(r).toEqual({ ok: false, code: "consent_denied" });
  });

  it("state de OUTRO usuário (sessão trocada) é recusado", async () => {
    const { state, cookie } = begin("user-1");
    const tf = tokenFetch();
    const r = await completeM365Callback(
      { code: "CODE", state, error: null, cookie, userId: "user-2", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tf.fetch, nowMs: NOW, graphWithToken: graph() },
    );
    expect(r).toEqual({ ok: false, code: "invalid_state" });
    expect(tf.bodies).toHaveLength(0);
  });

  it("nonce do cookie diferente do state é recusado (cookie de outro fluxo)", async () => {
    const a = begin();
    const b = begin();
    const r = await completeM365Callback(
      { code: "CODE", state: a.state, error: null, cookie: b.cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tokenFetch().fetch, nowMs: NOW, graphWithToken: graph() },
    );
    expect(r).toEqual({ ok: false, code: "invalid_state" });
  });

  it("sem cookie, state adulterado ou expirado → invalid_state", async () => {
    const { state, cookie } = begin();
    const input = { code: "CODE", error: null, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET };
    const d = { fetch: tokenFetch().fetch, graphWithToken: graph() };
    expect(await completeM365Callback({ ...input, state, cookie: null }, { ...d, nowMs: NOW })).toEqual({ ok: false, code: "invalid_state" });
    expect(await completeM365Callback({ ...input, state: `${state}x`, cookie }, { ...d, nowMs: NOW })).toEqual({ ok: false, code: "invalid_state" });
    expect(await completeM365Callback({ ...input, state, cookie }, { ...d, nowMs: NOW + 11 * 60_000 })).toEqual({ ok: false, code: "invalid_state" });
  });

  it("tid de outro tenant → tenant_mismatch", async () => {
    const { state, cookie } = begin();
    const r = await completeM365Callback(
      { code: "CODE", state, error: null, cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tokenFetch({ id_token: jwt({ tid: "outro-tenant" }) }).fetch, nowMs: NOW, graphWithToken: graph() },
    );
    expect(r).toEqual({ ok: false, code: "tenant_mismatch" });
  });

  it("conta Microsoft diferente do usuário logado → account_mismatch", async () => {
    const { state, cookie } = begin();
    const r = await completeM365Callback(
      { code: "CODE", state, error: null, cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tokenFetch().fetch, nowMs: NOW, graphWithToken: graph("bruno@jump.com.br", "bruno@jump.com.br") },
    );
    expect(r).toEqual({ ok: false, code: "account_mismatch" });
  });

  it("aceita quando só o userPrincipalName casa", async () => {
    const { state, cookie } = begin();
    const r = await completeM365Callback(
      { code: "CODE", state, error: null, cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch: tokenFetch().fetch, nowMs: NOW, graphWithToken: graph("", "ana@jump.com.br") },
    );
    expect(r.ok).toBe(true);
  });

  it("escopo proibido concedido → forbidden_scope; sem Calendars.Read → scope_missing", async () => {
    const run = async (scope: string) => {
      const { state, cookie } = begin();
      return completeM365Callback(
        { code: "CODE", state, error: null, cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
        { fetch: tokenFetch({ scope }).fetch, nowMs: NOW, graphWithToken: graph() },
      );
    };
    expect(await run("openid Calendars.Read Mail.Send")).toEqual({ ok: false, code: "forbidden_scope" });
    expect(await run("openid User.Read")).toEqual({ ok: false, code: "scope_missing" });
  });

  it("falha no token endpoint ou /me → códigos mapeados", async () => {
    const { state, cookie } = begin();
    const input = { code: "CODE", state, error: null, cookie, userId: "user-1", userEmail: "ana@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET };
    expect(
      await completeM365Callback(input, { fetch: tokenFetch({ error: "invalid_grant" }, 400).fetch, nowMs: NOW, graphWithToken: graph() }),
    ).toEqual({ ok: false, code: "token_exchange_failed" });
    const failing = () => {
      const g = createFakeGraphClient();
      g.failNext(new GraphError("http", "500", { status: 500 }));
      return g;
    };
    expect(await completeM365Callback(input, { fetch: tokenFetch().fetch, nowMs: NOW, graphWithToken: failing })).toEqual({
      ok: false,
      code: "graph_unavailable",
    });
  });
});
