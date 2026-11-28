import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase M3 — "Ativar transcrições do Teams" pelas rotas reais (connect/callback)
 * com fetch global stubado (nenhuma chamada à Microsoft) e persistência mockada.
 * Consentimento por CONJUNTO de capacidades: o pedido soma Teams ao que já foi
 * consentido (e-mail continua), e M1+Teams sem e-mail é válido.
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
  granted: [] as string[],
}));

vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser: vi.fn(async () => h.currentUser) }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => h.dbUser) }));
vi.mock("@/lib/db/m365", () => ({
  logM365Event: h.logM365Event,
  upsertM365Connection: h.upsertM365Connection,
  // M3: escopos já consentidos (o connect soma a capacidade pedida a eles).
  getM365GrantedScopes: vi.fn(async () => h.granted),
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

async function start(fase: string) {
  const res = await connect.GET(new Request(`https://flow.example.com/api/integrations/m365/connect?fase=${fase}`));
  const location = new URL(res.headers.get("location")!, "https://flow.example.com");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookieValue = decodeURIComponent(/m365_oauth=([^;]+)/.exec(setCookie)?.[1] ?? "");
  return { location, cookieValue, state: location.searchParams.get("state") };
}

function callbackReq(state: string, error?: string) {
  const url = new URL("https://flow.example.com/api/integrations/m365/callback");
  if (error) url.searchParams.set("error", error);
  else url.searchParams.set("code", "CODE");
  url.searchParams.set("state", state);
  return new Request(url);
}

const BASE = "openid profile offline_access User.Read Calendars.Read";
const TEAMS = "OnlineMeetings.Read OnlineMeetingTranscript.Read.All";

beforeEach(() => {
  enable();
  h.currentUser = { id: "user-1", name: "Gestor", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] };
  h.dbUser = { id: "user-1", name: "Gestor", email: "gestor@jump.com.br" };
  h.cookieValue = undefined;
  h.granted = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Ativar transcrições do Teams (consentimento incremental por capacidades)", () => {
  it("consultor não pede escopos do Teams: teams_not_allowed, sem cookie nem Microsoft", async () => {
    h.currentUser = { id: "user-2", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] };
    const fetch = stubMicrosoft("openid");
    const { location, cookieValue } = await start("M3");
    expect(location.searchParams.get("erro")).toBe("teams_not_allowed");
    expect(cookieValue).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gestor sem e-mail: pede M1 + Teams (sem Mail.Read) e grava os dois escopos do Teams", async () => {
    stubMicrosoft(`${BASE} ${TEAMS}`);
    const { location, cookieValue, state } = await start("M3");
    expect(location.searchParams.get("scope")).toBe(`${BASE} ${TEAMS}`);
    h.cookieValue = cookieValue;
    const res = await callback.GET(callbackReq(state!));
    expect(new URL(res.headers.get("location")!).searchParams.get("status")).toBe("transcricoes_ativadas");
    const scopes = h.upsertM365Connection.mock.calls[0][0].scopes;
    expect(scopes).toEqual(expect.arrayContaining(["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]));
    expect(scopes).not.toContain("Mail.Read");
  });

  it("gestor com e-mail já ativo: pede M1 + e-mail + Teams (o e-mail não se perde)", async () => {
    h.granted = [...BASE.split(" "), "Mail.Read"];
    stubMicrosoft(`${BASE} Mail.Read ${TEAMS}`);
    const { location, cookieValue, state } = await start("M3");
    expect(location.searchParams.get("scope")).toBe(`${BASE} Mail.Read ${TEAMS}`);
    h.cookieValue = cookieValue;
    await callback.GET(callbackReq(state!));
    expect(h.upsertM365Connection.mock.calls[0][0].scopes).toEqual([...BASE.split(" "), "Mail.Read", ...TEAMS.split(" ")]);
  });

  it("reconectar (M1) mantém e-mail/Teams já consentidos", async () => {
    h.granted = [...BASE.split(" "), "Mail.Read", ...TEAMS.split(" ")];
    stubMicrosoft("openid");
    const { location } = await start("M1");
    expect(location.searchParams.get("scope")).toBe(`${BASE} Mail.Read ${TEAMS}`);
  });

  it("sem consentimento de admin (escopos do Teams não vêm): resto conecta e aviso teams_scope_missing", async () => {
    stubMicrosoft(BASE);
    const { cookieValue, state } = await start("M3");
    h.cookieValue = cookieValue;
    const res = await callback.GET(callbackReq(state!));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("teams_scope_missing");
    expect(h.upsertM365Connection).toHaveBeenCalledTimes(1);
    expect(h.upsertM365Connection.mock.calls[0][0].scopes.join(" ")).not.toContain("OnlineMeeting");
  });

  it("Microsoft recusa (admin não aprovou) → teams_consent_denied, nada gravado", async () => {
    stubMicrosoft(BASE);
    const { cookieValue, state } = await start("M3");
    h.cookieValue = cookieValue;
    const res = await callback.GET(callbackReq(state!, "access_denied"));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("teams_consent_denied");
    expect(h.upsertM365Connection).not.toHaveBeenCalled();
  });

  it("escopo proibido concedido junto (OnlineMeetings.ReadWrite / Chat.Read) → forbidden_scope, nada gravado", async () => {
    stubMicrosoft(`${BASE} ${TEAMS} OnlineMeetings.ReadWrite Chat.Read`);
    const { cookieValue, state } = await start("M3");
    h.cookieValue = cookieValue;
    const res = await callback.GET(callbackReq(state!));
    expect(new URL(res.headers.get("location")!).searchParams.get("erro")).toBe("forbidden_scope");
    expect(h.upsertM365Connection).not.toHaveBeenCalled();
  });
});
