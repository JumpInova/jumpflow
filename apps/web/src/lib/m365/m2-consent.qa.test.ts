import { afterEach, describe, expect, it, vi } from "vitest";
import { completeM365Callback, readOAuthCookie, startM365Connect } from "./connect-flow";
import { createFakeGraphClient } from "./graph/fake";
import { M1_SCOPES, M2_SCOPES } from "./scopes";
import { addConnection, createMemoryStore } from "./testing/memory-store";
import { createTokenProvider, encryptAccessToken, encryptRefreshToken } from "./tokens";

/**
 * QA M2 — consentimento incremental e refresh pela fase consentida
 * (complementa `m2-consent.test.ts`). Nenhuma chamada real: token endpoint e
 * Graph são mocks. Os `it.fails` documentam achados.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const creds = { clientId: "client-1", clientSecret: "s3cret", tenantId: TENANT };
const REDIRECT = "https://flow.example.com/api/integrations/m365/callback";
const SECRET = "state-secret";
const NOW = 1_800_000_000_000;

const RT_OLD = "RT-OLD-segredo-refresh-0000";
const AT_NEW = "AT-NOVO-segredo-access-1111";
const RT_NEW = "RT-NOVO-segredo-refresh-2222";

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

type Reply = { status: number; body: Record<string, unknown> };

function tokenEndpoint(reply: (scope: string, n: number) => Reply) {
  const scopes: string[] = [];
  const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    scopes.push(body.get("scope") ?? "");
    const r = reply(body.get("scope") ?? "", scopes.length);
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { fetch, scopes };
}

const ok = (scope: string): Reply => ({
  status: 200,
  body: { access_token: AT_NEW, refresh_token: RT_NEW, expires_in: 3600, scope },
});

function conn(scopes: string[]) {
  const { store, state } = createMemoryStore();
  addConnection(state, {
    id: "c1",
    userId: "u1",
    accessTokenEncrypted: encryptAccessToken("AT-OLD"),
    refreshTokenEncrypted: encryptRefreshToken(RT_OLD),
    expiresAt: new Date(NOW - 1),
    scopes,
  });
  return { store, state };
}

async function provider(store: ReturnType<typeof conn>["store"], fetch: ReturnType<typeof tokenEndpoint>["fetch"]) {
  return createTokenProvider({ store, connection: (await store.getConnection("c1"))!, credentials: creds, fetch, now: () => NOW });
}

const M1_STR = M1_SCOPES.join(" ");
const M2_STR = M2_SCOPES.join(" ");

afterEach(() => vi.restoreAllMocks());

describe("refresh: escopo exatamente da fase consentida, nunca além", () => {
  it("escopos gravados com e-mail + Teams (M3 consentida) → pede exatamente esse conjunto", async () => {
    // Antes da M3 isso era "resíduo de fase futura"; agora é capacidade consentida.
    const { store } = conn([...M2_SCOPES, "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]);
    const te = tokenEndpoint(() => ok(M2_STR));
    await (await provider(store, te.fetch)).refresh();
    expect(te.scopes).toEqual([`${M2_STR} OnlineMeetings.Read OnlineMeetingTranscript.Read.All`]);
  });

  it("só UM dos escopos do Teams gravado → Teams não conta como consentido (pede só M2)", async () => {
    const { store } = conn([...M2_SCOPES, "OnlineMeetings.Read"]);
    const te = tokenEndpoint(() => ok(M2_STR));
    await (await provider(store, te.fetch)).refresh();
    expect(te.scopes).toEqual([M2_STR]);
  });

  it("resposta do token com escopo extra/proibido não entra em `scopes`", async () => {
    const { store, state } = conn([...M2_SCOPES]);
    const te = tokenEndpoint(() => ok(`${M2_STR} OnlineMeetings.Read Mail.ReadWrite Chat.Read`));
    await (await provider(store, te.fetch)).refresh();
    expect(state.connections.get("c1")!.scopes).toEqual([...M2_SCOPES]);
  });

  it("escopo devolvido com prefixo/caixa diferentes é gravado canônico (\"Mail.Read\" — o filtro Prisma do job usa `has: \"Mail.Read\"`)", async () => {
    const { store, state } = conn([...M2_SCOPES]);
    const te = tokenEndpoint(() => ok("openid profile offline_access https://graph.microsoft.com/user.read https://graph.microsoft.com/CALENDARS.READ https://graph.microsoft.com/mail.read"));
    await (await provider(store, te.fetch)).refresh();
    expect(state.connections.get("c1")!.scopes).toContain("Mail.Read");
    expect(state.connections.get("c1")!.scopes).toContain("Calendars.Read");
  });

  it("invalid_grant na M2 → REAUTH_REQUIRED direto (sem tentar recuar para M1)", async () => {
    const { store, state } = conn([...M2_SCOPES]);
    const te = tokenEndpoint(() => ({ status: 400, body: { error: "invalid_grant" } }));
    await expect((await provider(store, te.fetch)).refresh()).rejects.toMatchObject({ kind: "reauth" });
    expect(te.scopes).toEqual([M2_STR]);
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
  });

  it("recuo acontece UMA vez: M2 e M1 recusados → REAUTH_REQUIRED, 2 chamadas, sem laço", async () => {
    const { store, state } = conn([...M2_SCOPES]);
    const te = tokenEndpoint(() => ({ status: 400, body: { error: "consent_required" } }));
    await expect((await provider(store, te.fetch)).refresh()).rejects.toMatchObject({ kind: "reauth" });
    expect(te.scopes).toEqual([M2_STR, M1_STR]);
    expect(state.connections.get("c1")!.status).toBe("REAUTH_REQUIRED");
  });

  it("depois do recuo, o próximo refresh já pede só M1 (Mail.Read não volta sozinho)", async () => {
    const { store, state } = conn([...M2_SCOPES]);
    const first = tokenEndpoint((scope) =>
      scope.includes("Mail.Read") ? { status: 400, body: { error: "invalid_scope" } } : ok(M1_STR),
    );
    await (await provider(store, first.fetch)).refresh();
    expect(state.connections.get("c1")!.scopes).not.toContain("Mail.Read");
    const second = tokenEndpoint(() => ok(`${M1_STR} Mail.Read`));
    await (await provider(store, second.fetch)).refresh();
    expect(second.scopes).toEqual([M1_STR]);
    expect(state.connections.get("c1")!.scopes).not.toContain("Mail.Read");
  });

  // ACHADO (importante): o Entra devolve o consentimento retirado como
  // `{"error":"invalid_grant","suberror":"consent_required"}` (AADSTS65001).
  // `postToken` só lê `error`, então o recuo para M1 nunca acontece no mundo
  // real: a conexão inteira (agenda inclusive) cai em REAUTH_REQUIRED.
  it("Mail.Read retirado no formato real do Entra (invalid_grant + suberror consent_required) recua para M1", async () => {
    const { store, state } = conn([...M2_SCOPES]);
    const te = tokenEndpoint((scope) =>
      scope.includes("Mail.Read")
        ? { status: 400, body: { error: "invalid_grant", suberror: "consent_required", error_codes: [65001] } }
        : ok(M1_STR),
    );
    await (await provider(store, te.fetch)).refresh();
    expect(state.connections.get("c1")!.status).toBe("ACTIVE");
    expect(state.connections.get("c1")!.scopes).not.toContain("Mail.Read");
  });
});

describe("tokens nunca em log nem em claro", () => {
  function spyConsole() {
    return (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  }

  it("refresh com sucesso, recuo e falha: nenhum token em console, logs de integração ou campos em claro", async () => {
    const spies = spyConsole();
    const scenarios: Array<(scope: string) => Reply> = [
      () => ok(M2_STR),
      (scope) => (scope.includes("Mail.Read") ? { status: 400, body: { error: "consent_required" } } : ok(M1_STR)),
      () => ({ status: 400, body: { error: "invalid_grant", error_description: `token ${RT_OLD}` } }),
      () => ({ status: 500, body: {} }),
    ];
    for (const reply of scenarios) {
      const { store, state } = conn([...M2_SCOPES]);
      const te = tokenEndpoint(reply);
      await (await provider(store, te.fetch)).refresh().catch(() => undefined);
      const c = state.connections.get("c1")!;
      const persisted = JSON.stringify({ ...c, logs: state.logs });
      for (const secret of [RT_OLD, AT_NEW, RT_NEW]) expect(persisted).not.toContain(secret);
      expect(c.lastError ?? "").not.toContain("segredo");
    }
    const printed = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [RT_OLD, AT_NEW, RT_NEW]) expect(printed).not.toContain(secret);
  });
});

describe("consentimento M2: escopos proibidos e fase no cookie", () => {
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
  const graph = () =>
    createFakeGraphClient({ me: { id: "g1", mail: "gestor@jump.com.br", userPrincipalName: "gestor@jump.com.br" } });

  async function callback(granted: string, phase: "M1" | "M2" = "M2") {
    const { state, cookie } = begin(phase);
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: granted, id_token: jwt({ tid: TENANT }) }),
        { status: 200 },
      ),
    );
    return completeM365Callback(
      { code: "C", state, error: null, cookie, userId: "user-1", userEmail: "gestor@jump.com.br", credentials: creds, redirectUri: REDIRECT, stateSecret: SECRET },
      { fetch, nowMs: NOW + 1000, graphWithToken: graph },
    );
  }

  it("pedido M2 nunca inclui escopo de fase futura nem proibido", () => {
    const scope = begin("M2").url.searchParams.get("scope")!.split(" ");
    expect(scope).toEqual([...M2_SCOPES]);
    for (const bad of ["Mail.Send", "Mail.ReadWrite", "Chat.Read", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]) {
      expect(scope).not.toContain(bad);
    }
  });

  it.each(["Mail.ReadWrite", "Chat.Read", "Chat.ReadWrite", "Mail.ReadWrite.All", "Files.ReadWrite.All", "Mail.Read.All"])(
    "callback M2 com %s concedido → forbidden_scope (nada gravado)",
    async (bad) => {
      expect(await callback(`${M2_STR} ${bad}`)).toEqual({ ok: false, code: "forbidden_scope" });
    },
  );

  it("callback de fase M1 com Mail.Read já consentido antes: a conexão nasce SEM Mail.Read (não amplia sozinha)", async () => {
    const r = await callback(M2_STR, "M1");
    expect(r).toMatchObject({ ok: true, account: { phase: "M1", mailScopeMissing: false } });
  });

  it("cookie de fase não pode ser forjado em claro (só o cifrado é aceito)", () => {
    expect(readOAuthCookie(JSON.stringify({ nonce: "n", verifier: "v", userId: "user-1", exp: 9_999_999_999, phase: "M2" }))).toBeNull();
    expect(readOAuthCookie(Buffer.from(JSON.stringify({ phase: "M2" })).toString("base64url"))).toBeNull();
  });
});
