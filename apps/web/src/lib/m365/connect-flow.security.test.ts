import { describe, expect, it, vi } from "vitest";
import { resolveM365Credentials } from "./config";
import { completeM365Callback, readOAuthCookie, startM365Connect } from "./connect-flow";
import { createFakeGraphClient } from "./graph/fake";
import { M365_ERROR_MESSAGES } from "./messages";
import { signState } from "./oauth";
import { ForbiddenScopeError, assertScopesForPhase, isForbiddenScope } from "./scopes";

/**
 * QA (Fase M1) — segurança do fluxo de conexão: state × cookie × sessão,
 * tenant, conta de outro usuário, issuers multi-locatário e escopos.
 * Tudo com fakes; nenhuma chamada à Microsoft.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { clientId: "client-1", clientSecret: "s3cret-do-app", tenantId: TENANT };
const REDIRECT = "https://flow.example.com/api/integrations/m365/callback";
const SECRET = "state-secret";
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function tokenFetch(overrides: Record<string, unknown> = {}, status = 200) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(
      JSON.stringify({
        access_token: "AT-SECRETO",
        refresh_token: "RT-SECRETO",
        expires_in: 3600,
        scope: "openid profile offline_access User.Read Calendars.Read",
        id_token: jwt({ tid: TENANT, oid: "oid-1" }),
        ...overrides,
      }),
      { status },
    ),
  );
  return fetch;
}

function begin(userId = "user-1", nowMs = NOW) {
  const start = startM365Connect({
    userId,
    userEmail: "ana@jump.com.br",
    credentials: creds,
    redirectUri: REDIRECT,
    stateSecret: SECRET,
    nowMs,
  });
  const url = new URL(start.authorizeUrl);
  return { start, url, state: url.searchParams.get("state")!, cookie: readOAuthCookie(start.cookieValue) };
}

function graph(mail: string | null = "ana@jump.com.br", upn: string | null = "ana@jump.com.br") {
  return vi.fn(() => createFakeGraphClient({ me: { id: "graph-ana", mail, userPrincipalName: upn } }));
}

function input(over: Partial<Parameters<typeof completeM365Callback>[0]> = {}) {
  const { state, cookie } = begin();
  return {
    code: "CODE",
    state,
    error: null,
    cookie,
    userId: "user-1",
    userEmail: "ana@jump.com.br",
    credentials: creds,
    redirectUri: REDIRECT,
    stateSecret: SECRET,
    ...over,
  };
}

describe("callback — state × cookie × sessão", () => {
  it("cookie e state do usuário B usados na sessão do usuário A → invalid_state, sem trocar o code", async () => {
    const b = begin("user-2");
    const fetch = tokenFetch();
    const r = await completeM365Callback(input({ state: b.state, cookie: b.cookie }), {
      fetch,
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r).toEqual({ ok: false, code: "invalid_state" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("state válido de A com cookie de B (mesmo nonce forjado não é possível) → invalid_state", async () => {
    const a = begin("user-1");
    const b = begin("user-2");
    // Cookie de B com o nonce de A: userId do cookie ≠ sessão.
    const forgedCookie = { ...b.cookie!, nonce: a.cookie!.nonce };
    const fetch = tokenFetch();
    const r = await completeM365Callback(input({ state: a.state, cookie: forgedCookie }), {
      fetch,
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r).toEqual({ ok: false, code: "invalid_state" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("state assinado com outro segredo (forjado) → invalid_state", async () => {
    const { cookie } = begin();
    const forged = signState({ u: "user-1", n: cookie!.nonce, e: NOW / 1000 + 600 }, "segredo-do-atacante");
    const fetch = tokenFetch();
    const r = await completeM365Callback(input({ state: forged, cookie }), { fetch, nowMs: NOW, graphWithToken: graph() });
    expect(r).toEqual({ ok: false, code: "invalid_state" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cookie vencido (mesmo com state ainda válido) → invalid_state", async () => {
    const { state, cookie } = begin();
    const expiredCookie = { ...cookie!, exp: NOW / 1000 - 1 };
    const r = await completeM365Callback(input({ state, cookie: expiredCookie }), {
      fetch: tokenFetch(),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r).toEqual({ ok: false, code: "invalid_state" });
  });

  it("sem code ou sem state → invalid_state", async () => {
    const d = { fetch: tokenFetch(), nowMs: NOW, graphWithToken: graph() };
    expect(await completeM365Callback(input({ code: null }), d)).toEqual({ ok: false, code: "invalid_state" });
    expect(await completeM365Callback(input({ state: null }), d)).toEqual({ ok: false, code: "invalid_state" });
    expect(await completeM365Callback(input({ state: "a.b.c" }), d)).toEqual({ ok: false, code: "invalid_state" });
  });

  it("cookie cifrado adulterado ou de outro campo (AAD) não é aceito", () => {
    const { start } = begin();
    const tampered = `${start.cookieValue.slice(0, -4)}AAAA`;
    expect(readOAuthCookie(tampered)).toBeNull();
    expect(readOAuthCookie("")).toBeNull();
    expect(readOAuthCookie(undefined)).toBeNull();
  });

  it("erro da Microsoft (access_denied) encerra antes de qualquer chamada", async () => {
    const fetch = tokenFetch();
    const g = graph();
    const r = await completeM365Callback(input({ error: "access_denied", code: "CODE" }), { fetch, nowMs: NOW, graphWithToken: g });
    expect(r).toEqual({ ok: false, code: "consent_denied" });
    expect(fetch).not.toHaveBeenCalled();
    expect(g).not.toHaveBeenCalled();
  });
});

describe("callback — tenant (tid)", () => {
  it("sem tid no id_token nem no access token → tenant_mismatch", async () => {
    const r = await completeM365Callback(input(), {
      fetch: tokenFetch({ id_token: jwt({ oid: "x" }) }),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r).toEqual({ ok: false, code: "tenant_mismatch" });
  });

  it("tid só no access token (JWT) é aceito quando confere", async () => {
    const r = await completeM365Callback(input(), {
      fetch: tokenFetch({ id_token: undefined, access_token: jwt({ tid: TENANT }) }),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r.ok).toBe(true);
  });

  it("tid de conta pessoal (tenant consumers 9188040d-…) → tenant_mismatch", async () => {
    const r = await completeM365Callback(input(), {
      fetch: tokenFetch({ id_token: jwt({ tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }) }),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r).toEqual({ ok: false, code: "tenant_mismatch" });
  });

  it("tid que difere só por maiúsculas é aceito (GUID)", async () => {
    const r = await completeM365Callback(input(), {
      fetch: tokenFetch({ id_token: jwt({ tid: TENANT.toUpperCase() }) }),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r.ok).toBe(true);
  });

  it("tenant mismatch não consulta /me", async () => {
    const g = graph();
    await completeM365Callback(input(), { fetch: tokenFetch({ id_token: jwt({ tid: "outro" }) }), nowMs: NOW, graphWithToken: g });
    expect(g).not.toHaveBeenCalled();
  });
});

describe("callback — conta de outro usuário (mailbox)", () => {
  it.each([
    ["mail e UPN de outra pessoa", "bruno@jump.com.br", "bruno@jump.com.br"],
    ["sem mail e UPN de outra pessoa", null, "bruno@jump.com.br"],
    ["e-mail parecido (prefixo)", "ana@jump.com.br.evil.com", "ana@jump.com.br.evil.com"],
    ["mesmo usuário em outro domínio", "ana@outra.com.br", "ana@outra.com.br"],
  ])("%s → account_mismatch", async (_label, mail, upn) => {
    const r = await completeM365Callback(input(), { fetch: tokenFetch(), nowMs: NOW, graphWithToken: graph(mail, upn) });
    expect(r).toEqual({ ok: false, code: "account_mismatch" });
  });

  it("comparação ignora caixa e espaços, e a caixa gravada é a do usuário logado", async () => {
    const r = await completeM365Callback(input({ userEmail: "  ANA@jump.com.br " }), {
      fetch: tokenFetch(),
      nowMs: NOW,
      graphWithToken: graph(" Ana@Jump.Com.Br ", null),
    });
    expect(r).toMatchObject({ ok: true, account: { mailbox: "ana@jump.com.br" } });
  });

  it("/me sem mail nem UPN → account_mismatch", async () => {
    const r = await completeM365Callback(input(), { fetch: tokenFetch(), nowMs: NOW, graphWithToken: graph(null, null) });
    expect(r).toEqual({ ok: false, code: "account_mismatch" });
  });

  it("/me é consultado com o access token recém-emitido", async () => {
    const g = graph();
    await completeM365Callback(input(), { fetch: tokenFetch(), nowMs: NOW, graphWithToken: g });
    expect(g).toHaveBeenCalledWith("AT-SECRETO");
  });
});

describe("callback — tokens e escopos", () => {
  it("token response sem refresh_token → token_exchange_failed (sem offline_access não conecta)", async () => {
    const r = await completeM365Callback(input(), { fetch: tokenFetch({ refresh_token: undefined }), nowMs: NOW, graphWithToken: graph() });
    expect(r).toEqual({ ok: false, code: "token_exchange_failed" });
  });

  it("falha de rede no token endpoint → token_exchange_failed", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await completeM365Callback(input(), { fetch, nowMs: NOW, graphWithToken: graph() });
    expect(r).toEqual({ ok: false, code: "token_exchange_failed" });
  });

  it.each([
    "openid Calendars.Read\tChat.Read",
    "openid Calendars.Read\nMail.ReadWrite",
    "openid https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Calendars.ReadWrite",
    "openid Calendars.Read User.Read.All",
    "openid Calendars.Read MAIL.SEND",
  ])("escopo proibido concedido escondido em %j → forbidden_scope", async (scope) => {
    const r = await completeM365Callback(input(), { fetch: tokenFetch({ scope }), nowMs: NOW, graphWithToken: graph() });
    expect(r).toEqual({ ok: false, code: "forbidden_scope" });
  });

  it("escopo concedido com prefixo do recurso Graph é aceito", async () => {
    const r = await completeM365Callback(input(), {
      fetch: tokenFetch({ scope: "https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read" }),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(r.ok).toBe(true);
  });

  it("troca do code pede só os escopos da M1 e envia o code_verifier (nunca o state)", async () => {
    const fetch = tokenFetch();
    const i = input();
    await completeM365Callback(i, { fetch, nowMs: NOW, graphWithToken: graph() });
    const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
    expect(body.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
    expect(body.get("code_verifier")).toBe(i.cookie!.verifier);
    expect(body.has("state")).toBe(false);
    expect(fetch.mock.calls[0][0]).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  });

  it("resultado de falha só carrega o código (nunca token, e-mail ou detalhe)", async () => {
    const r = await completeM365Callback(input(), {
      fetch: tokenFetch({ error: "invalid_grant", error_description: "RT-SECRETO expirou" }, 400),
      nowMs: NOW,
      graphWithToken: graph(),
    });
    expect(Object.keys(r).sort()).toEqual(["code", "ok"]);
    expect(JSON.stringify(r)).not.toContain("SECRETO");
    expect(Object.keys(M365_ERROR_MESSAGES)).toContain((r as { code: string }).code);
  });
});

describe("início — URL de autorização", () => {
  it("não vaza client_secret, verifier ou e-mail além do login_hint; state não contém o verifier", () => {
    const { url, cookie } = begin();
    const raw = url.toString();
    expect(raw).not.toContain(creds.clientSecret);
    expect(raw).not.toContain(cookie!.verifier);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
    const statePayload = Buffer.from(url.searchParams.get("state")!.split(".")[0], "base64url").toString("utf8");
    expect(statePayload).not.toContain(cookie!.verifier);
    expect(JSON.parse(statePayload)).toMatchObject({ u: "user-1", n: cookie!.nonce });
  });

  it("cada início gera nonce e verifier novos", () => {
    const a = begin();
    const b = begin();
    expect(a.cookie!.nonce).not.toBe(b.cookie!.nonce);
    expect(a.cookie!.verifier).not.toBe(b.cookie!.verifier);
  });
});

describe("issuers multi-locatário e escopos proibidos", () => {
  it.each(["common", "organizations", "consumers", " Consumers ", "COMMON"])(
    "tenant %j é recusado também pelo fallback do login",
    (tenant) => {
      expect(
        resolveM365Credentials({
          AUTH_MICROSOFT_ENTRA_ID_ID: "a",
          AUTH_MICROSOFT_ENTRA_ID_SECRET: "b",
          AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: tenant,
        } as unknown as NodeJS.ProcessEnv),
      ).toEqual({ ok: false, reason: "forbidden_tenant" });
    },
  );

  it.each([
    "Mail.ReadWrite.Shared",
    "Chat.ReadBasic",
    "ChatMessage.Read",
    "ChannelMessage.Read.All",
    "Sites.Read.All",
    "Directory.Read.All",
    "User.ReadWrite",
    "Calendars.ReadWrite.Shared",
    "https://graph.microsoft.com/Mail.Send",
    "api://outro-app/.default",
  ])("%s é recusado em qualquer fase", (scope) => {
    expect(() => assertScopesForPhase(["openid", "Calendars.Read", scope], "M1")).toThrow(ForbiddenScopeError);
  });

  it("escopos de fases futuras (Mail.Read, OnlineMeetings.Read) ficam fora da M1, inclusive com tab/newline", () => {
    expect(() => assertScopesForPhase("openid\tMail.Read", "M1")).toThrow(ForbiddenScopeError);
    expect(() => assertScopesForPhase("openid\nOnlineMeetings.Read", "M1")).toThrow(ForbiddenScopeError);
    expect(() => assertScopesForPhase(["Calendars.Read.Shared"], "M1")).toThrow(ForbiddenScopeError);
  });

  it("qualquer Chat* (ChatMessage.*, ChatMember.*) é proibido (correção M1)", () => {
    expect(isForbiddenScope("ChatMessage.Read")).toBe(true);
    expect(isForbiddenScope("ChatMember.Read")).toBe(true);
    expect(isForbiddenScope("https://graph.microsoft.com/ChatMessage.Send")).toBe(true);
  });
});
