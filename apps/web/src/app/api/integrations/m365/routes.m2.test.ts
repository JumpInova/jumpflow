import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase M2 — "Ativar atas por e-mail" pelas rotas reais (connect/callback) com
 * fetch global stubado (nenhuma chamada à Microsoft) e persistência mockada.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";

const h = vi.hoisted(() => ({
  currentUser: null as null | { id: string; name: string; email: string; roles: string[] },
  dbUser: null as null | { id: string; name: string; email: string },
  cookieValue: undefined as string | undefined,
  logM365Event: vi.fn<(e: unknown) => Promise<void>>(async () => {}),
  upsertM365Connection: vi.fn<(i: { scopes: string[] }) => Promise<{ id: string; created: boolean }>>(async () => ({
    id: "conn-1",
    created: false,
  })),
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

function stubMicrosoft(scope: string) {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("login.microsoftonline.com")) {
      return new Response(
        JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope, id_token: jwt({ tid: TENANT }) }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
      return new Response(JSON.stringify({ id: "g1", mail: "gestor@jump.com.br", userPrincipalName: "gestor@jump.com.br" }), { status: 200 });
    }
    throw new Error(`URL inesperada: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
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

async function startM2() {
  const res = await connect.GET(new Request("https://flow.example.com/api/integrations/m365/connect?fase=M2"));
  const location = new URL(res.headers.get("location")!, "https://flow.example.com");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookieValue = decodeURIComponent(/m365_oauth=([^;]+)/.exec(setCookie)?.[1] ?? "");
  return { location, cookieValue, state: location.searchParams.get("state") };
}

function callbackReq(state: string) {
  const url = new URL("https://flow.example.com/api/integrations/m365/callback");
  url.searchParams.set("code", "CODE");
  url.searchParams.set("state", state);
  return new Request(url);
}

beforeEach(() => {
  enable();
  h.currentUser = { id: "user-1", name: "Gestor", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] };
  h.dbUser = { id: "user-1", name: "Gestor", email: "gestor@jump.com.br" };
  h.cookieValue = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Ativar atas por e-mail (consentimento incremental)", () => {
  it("consultor não pede Mail.Read: volta com mail_not_allowed, sem cookie nem Microsoft", async () => {
    h.currentUser = { id: "user-2", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] };
    const fetch = stubMicrosoft("openid");
    const { location, cookieValue } = await startM2();
    expect(location.pathname).toBe("/app/conta/microsoft-365");
    expect(location.searchParams.get("erro")).toBe("mail_not_allowed");
    expect(cookieValue).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gestor: pede M1 + Mail.Read e grava Mail.Read após o callback", async () => {
    stubMicrosoft("openid profile offline_access User.Read Calendars.Read Mail.Read");
    const { location, cookieValue, state } = await startM2();
    expect(location.hostname).toBe("login.microsoftonline.com");
    expect(location.searchParams.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read Mail.Read");
    h.cookieValue = cookieValue;
    const res = await callback.GET(callbackReq(state!));
    expect(new URL(res.headers.get("location")!).searchParams.get("status")).toBe("atas_ativadas");
    expect(h.upsertM365Connection.mock.calls[0][0].scopes).toContain("Mail.Read");
  });

  it("Mail.Read negado: agenda conectada, aviso mail_scope_missing e nada de Mail.Read gravado", async () => {
    stubMicrosoft("openid profile offline_access User.Read Calendars.Read");
    const { cookieValue, state } = await startM2();
    h.cookieValue = cookieValue;
    const res = await callback.GET(callbackReq(state!));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("mail_scope_missing");
    expect(h.upsertM365Connection).toHaveBeenCalledTimes(1);
    expect(h.upsertM365Connection.mock.calls[0][0].scopes).not.toContain("Mail.Read");
  });

  it("fase desconhecida na URL = M1 (nunca pede escopo além)", async () => {
    stubMicrosoft("openid");
    // M3 passou a existir (transcrições do Teams): o desconhecido agora é M9.
    const res = await connect.GET(new Request("https://flow.example.com/api/integrations/m365/connect?fase=M9"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
  });
});
