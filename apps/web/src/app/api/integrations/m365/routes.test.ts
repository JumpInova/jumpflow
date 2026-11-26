import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptField, ENCRYPTED_FIELDS } from "@jumpflow/database/field-encryption";

/**
 * QA (Fase M1) — rotas de conexão (connect/callback) ponta a ponta com fetch
 * global stubado (token endpoint e /me falsos; nenhuma chamada real à
 * Microsoft) e persistência mockada. Cobre: flag desligada → 404, sem sessão →
 * /login, state × sessão, conta de outro usuário, tokens só cifrados, URL de
 * retorno só com código, cookie limpo.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";

const h = vi.hoisted(() => ({
  currentUser: null as null | { id: string; name: string; email: string; roles: string[] },
  dbUser: null as null | { id: string; name: string; email: string },
  cookieValue: undefined as string | undefined,
  logM365Event: vi.fn<(e: unknown) => Promise<void>>(async () => {}),
  upsertM365Connection: vi.fn<(i: unknown) => Promise<{ id: string; created: boolean }>>(async () => ({ id: "conn-1", created: true })),
  recordAuditEvent: vi.fn<(i: unknown) => Promise<void>>(async () => {}),
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => h.currentUser) }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => h.dbUser) }));
vi.mock("@/lib/db/m365", () => ({
  logM365Event: h.logM365Event,
  upsertM365Connection: h.upsertM365Connection,
  // M3: escopos já consentidos (o connect soma a capacidade pedida a eles).
  getM365GrantedScopes: vi.fn(async () => [] as string[]),
}));
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: h.recordAuditEvent }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "m365_oauth" && h.cookieValue ? { name, value: h.cookieValue } : undefined) }),
}));

import * as callback from "./callback/route";
import * as connect from "./connect/route";

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function stubMicrosoft(opts: { me?: { mail: string | null; userPrincipalName: string | null }; tid?: string; scope?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("login.microsoftonline.com")) {
      return new Response(
        JSON.stringify({
          access_token: "AT-SECRETO",
          refresh_token: "RT-SECRETO",
          expires_in: 3600,
          scope: opts.scope ?? "openid profile offline_access User.Read Calendars.Read",
          id_token: jwt({ tid: opts.tid ?? TENANT }),
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
      return new Response(JSON.stringify({ id: "graph-ana", ...(opts.me ?? { mail: "ana@jump.com.br", userPrincipalName: "ana@jump.com.br" }) }), { status: 200 });
    }
    throw new Error(`URL inesperada: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

function enable() {
  vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgresql://fake");
  vi.stubEnv("M365_CLIENT_ID", "client-1");
  vi.stubEnv("M365_CLIENT_SECRET", "APP-SECRET");
  vi.stubEnv("M365_TENANT_ID", TENANT);
  vi.stubEnv("AUTH_URL", "https://flow.example.com");
  vi.stubEnv("M365_STATE_SECRET", "state-secret");
}

async function startFlow() {
  const res = await connect.GET(new Request("https://flow.example.com/api/integrations/m365/connect"));
  const location = new URL(res.headers.get("location")!);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookieValue = decodeURIComponent(/m365_oauth=([^;]+)/.exec(setCookie)?.[1] ?? "");
  return { res, location, setCookie, cookieValue, state: location.searchParams.get("state")! };
}

function callbackReq(params: Record<string, string>) {
  const url = new URL("https://flow.example.com/api/integrations/m365/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

beforeEach(() => {
  h.currentUser = { id: "user-1", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] };
  h.dbUser = { id: "user-1", name: "Ana", email: "ana@jump.com.br" };
  h.cookieValue = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("flag desligada", () => {
  it.each(["", "false", "TRUE", "yes"])("M365_INTEGRATION_ENABLED=%j → connect e callback 404, sem sessão nem fetch", async (flag) => {
    enable();
    vi.stubEnv("M365_INTEGRATION_ENABLED", flag);
    const { fetch } = stubMicrosoft();
    const { getCurrentUser } = await import("@/lib/auth/current-user");
    expect((await connect.GET(new Request("https://flow.example.com/api/integrations/m365/connect"))).status).toBe(404);
    expect((await callback.GET(callbackReq({ code: "c", state: "s" }))).status).toBe(404);
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.upsertM365Connection).not.toHaveBeenCalled();
  });
});

describe("connect", () => {
  it("sem sessão → /login", async () => {
    enable();
    h.currentUser = null;
    const res = await connect.GET(new Request("https://flow.example.com/api/integrations/m365/connect"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("redireciona para o tenant específico com PKCE S256 e cookie httpOnly cifrado com path restrito", async () => {
    enable();
    const { location, setCookie, cookieValue } = await startFlow();
    expect(location.origin + location.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(location.searchParams.get("redirect_uri")).toBe("https://flow.example.com/api/integrations/m365/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/integrations\/m365/i);
    expect(cookieValue.startsWith("enc:v1:")).toBe(true);
    expect(location.toString()).not.toContain("APP-SECRET");
  });

  it.each(["common", "organizations", "consumers"])("tenant %s configurado → not_configured, sem ir à Microsoft", async (tenant) => {
    enable();
    vi.stubEnv("M365_TENANT_ID", tenant);
    const res = await connect.GET(new Request("https://flow.example.com/api/integrations/m365/connect"));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("flow.example.com");
    expect(loc.searchParams.get("erro")).toBe("not_configured");
  });

  it("produção sem AUTH_URL → not_configured (nunca usa o Host do cliente no redirect_uri)", async () => {
    enable();
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await connect.GET(new Request("https://evil.example.com/api/integrations/m365/connect"));
    // Falha fechado: Location RELATIVO, sem ecoar o Host recebido (correção M1).
    const raw = res.headers.get("location")!;
    expect(raw.startsWith("/app/conta/microsoft-365?")).toBe(true);
    expect(raw).not.toContain("evil.example.com");
    const loc = new URL(raw, "https://base.invalid");
    expect(loc.searchParams.get("erro")).toBe("not_configured");
  });
});

describe("callback", () => {
  it("fluxo feliz: grava tokens CIFRADOS, audita sem token, URL só com status e cookie limpo", async () => {
    enable();
    const { cookieValue, state } = await startFlow();
    h.cookieValue = cookieValue;
    const { calls } = stubMicrosoft();
    const res = await callback.GET(callbackReq({ code: "CODE", state }));
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/app/conta/microsoft-365");
    expect([...loc.searchParams.keys()]).toEqual(["status"]);
    expect(res.headers.get("set-cookie")).toMatch(/m365_oauth=;.*Max-Age=0/i);

    const saved = h.upsertM365Connection.mock.calls[0][0] as Record<string, unknown>;
    expect(saved).toMatchObject({ userId: "user-1", tenantId: TENANT, graphUserId: "graph-ana", mailbox: "ana@jump.com.br" });
    expect(String(saved.accessTokenEncrypted)).not.toContain("AT-SECRETO");
    expect(String(saved.refreshTokenEncrypted)).not.toContain("RT-SECRETO");
    const everythingLogged = JSON.stringify([h.logM365Event.mock.calls, h.recordAuditEvent.mock.calls]);
    expect(everythingLogged).not.toMatch(/AT-SECRETO|RT-SECRETO|APP-SECRET|ana@jump/);

    // /me foi chamado com o token novo e Prefer UTC; token endpoint com o verifier.
    const me = calls.find((c) => c.url.includes("graph.microsoft.com"))!;
    expect((me.init?.headers as Record<string, string>).Authorization).toBe("Bearer AT-SECRETO");
    const tokenBody = new URLSearchParams(String(calls[0].init?.body));
    expect(tokenBody.get("code_verifier")).toBeTruthy();
    expect(tokenBody.get("redirect_uri")).toBe("https://flow.example.com/api/integrations/m365/callback");
  });

  it("sessão trocada entre connect e callback (outro usuário logado) → invalid_state, nada gravado", async () => {
    enable();
    const { cookieValue, state } = await startFlow();
    h.cookieValue = cookieValue;
    h.currentUser = { id: "user-2", name: "Bruno", email: "bruno@jump.com.br", roles: ["CONSULTANT"] };
    h.dbUser = { id: "user-2", name: "Bruno", email: "bruno@jump.com.br" };
    const { fetch } = stubMicrosoft();
    const res = await callback.GET(callbackReq({ code: "CODE", state }));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("invalid_state");
    expect(fetch).not.toHaveBeenCalled();
    expect(h.upsertM365Connection).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("sem cookie (outro navegador / CSRF de login) → invalid_state", async () => {
    enable();
    const { state } = await startFlow();
    h.cookieValue = undefined;
    const { fetch } = stubMicrosoft();
    const res = await callback.GET(callbackReq({ code: "CODE", state }));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("invalid_state");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cookie forjado (cifrado com o AAD de outro campo) → invalid_state", async () => {
    enable();
    const { state } = await startFlow();
    h.cookieValue = encryptField(
      ENCRYPTED_FIELDS.m365AccessToken,
      JSON.stringify({ nonce: "n", verifier: "v", userId: "user-1", exp: 9_999_999_999 }),
    );
    stubMicrosoft();
    const res = await callback.GET(callbackReq({ code: "CODE", state }));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("invalid_state");
  });

  it("conta Microsoft de outra pessoa → account_mismatch, nada gravado, log sem e-mail", async () => {
    enable();
    const { cookieValue, state } = await startFlow();
    h.cookieValue = cookieValue;
    stubMicrosoft({ me: { mail: "chefe@jump.com.br", userPrincipalName: "chefe@jump.com.br" } });
    const res = await callback.GET(callbackReq({ code: "CODE", state }));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("account_mismatch");
    expect(h.upsertM365Connection).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logM365Event.mock.calls)).not.toMatch(/chefe|AT-SECRETO/);
  });

  it("tid de outro tenant → tenant_mismatch", async () => {
    enable();
    const { cookieValue, state } = await startFlow();
    h.cookieValue = cookieValue;
    stubMicrosoft({ tid: "99999999-0000-0000-0000-000000000000" });
    const res = await callback.GET(callbackReq({ code: "CODE", state }));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("tenant_mismatch");
    expect(h.upsertM365Connection).not.toHaveBeenCalled();
  });

  it("erro da Microsoft com descrição na query: a URL de volta só leva o código", async () => {
    enable();
    const { cookieValue, state } = await startFlow();
    h.cookieValue = cookieValue;
    stubMicrosoft();
    const res = await callback.GET(
      callbackReq({ error: "access_denied", error_description: "<script>alert(1)</script> AADSTS", state }),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("erro")).toBe("consent_denied");
    expect(loc.toString()).not.toMatch(/script|AADSTS/);
  });
});
