import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isForbiddenTenant, resolveAppBaseUrl, resolveM365Credentials } from "./config";
import {
  buildAuthorizeUrl,
  createPkcePair,
  decodeJwtPayload,
  signState,
  verifyState,
} from "./oauth";
import {
  ForbiddenScopeError,
  M1_SCOPES,
  assertScopesForPhase,
  grantedForbiddenScopes,
  isForbiddenScope,
} from "./scopes";

const creds = { clientId: "client-1", clientSecret: "s3cret", tenantId: "11111111-2222-3333-4444-555555555555" };

describe("escopos por fase", () => {
  it("M1 aceita exatamente os escopos da fase", () => {
    expect(assertScopesForPhase(M1_SCOPES, "M1")).toEqual([...M1_SCOPES]);
  });

  it.each([
    "Mail.Send",
    "Mail.Send.Shared",
    "Mail.ReadWrite",
    "Chat.Read",
    "Calendars.ReadWrite",
    "Files.ReadWrite.All",
    "User.Read.All",
    "https://graph.microsoft.com/.default",
    ".default",
  ])("recusa %s", (scope) => {
    expect(isForbiddenScope(scope)).toBe(true);
    expect(() => assertScopesForPhase(["openid", scope], "M1")).toThrow(ForbiddenScopeError);
  });

  it("recusa escopo proibido escondido numa string separada por espaço", () => {
    expect(() => assertScopesForPhase("openid Calendars.Read   Mail.Send", "M1")).toThrow(ForbiddenScopeError);
    expect(() => assertScopesForPhase(["openid Mail.ReadWrite"], "M1")).toThrow(/Mail.ReadWrite/);
  });

  it("recusa escopo de fase futura (Mail.Read na M1)", () => {
    expect(() => assertScopesForPhase(["openid", "Mail.Read"], "M1")).toThrow(ForbiddenScopeError);
  });

  it("OnlineMeetingTranscript.Read.All não é proibido em si (fase M3), mas fica fora da M1", () => {
    expect(isForbiddenScope("OnlineMeetingTranscript.Read.All")).toBe(false);
    expect(() => assertScopesForPhase("OnlineMeetingTranscript.Read.All", "M1")).toThrow();
  });

  it("detecta escopos proibidos concedidos", () => {
    expect(grantedForbiddenScopes(["openid", "https://graph.microsoft.com/Mail.Send"])).toHaveLength(1);
  });
});

describe("buildAuthorizeUrl", () => {
  const base = {
    credentials: creds,
    redirectUri: "https://flow.example.com/api/integrations/m365/callback",
    phase: "M1" as const,
    state: "st",
    codeChallenge: "ch",
  };

  it("monta URL com PKCE S256, tenant específico e só escopos da M1", () => {
    const url = new URL(buildAuthorizeUrl({ ...base, scopes: M1_SCOPES, loginHint: "ana@jump.com.br" }));
    expect(url.origin + url.pathname).toBe(
      `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/authorize`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("scope")).toBe("openid profile offline_access User.Read Calendars.Read");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("login_hint")).toBe("ana@jump.com.br");
  });

  it("lança para escopo proibido, mesmo dentro de string com espaços", () => {
    expect(() => buildAuthorizeUrl({ ...base, scopes: "openid Calendars.Read Mail.Send" })).toThrow(ForbiddenScopeError);
  });

  it("recusa tenant common/organizations/consumers", () => {
    for (const t of ["common", "organizations", "consumers", "Common"]) {
      expect(isForbiddenTenant(t)).toBe(true);
      expect(() => buildAuthorizeUrl({ ...base, credentials: { ...creds, tenantId: t }, scopes: M1_SCOPES })).toThrow();
    }
  });
});

describe("PKCE e state", () => {
  it("challenge é SHA-256 base64url do verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("state assinado valida e detecta adulteração/expiração", () => {
    const now = 1_800_000_000_000;
    const state = signState({ u: "user-1", n: "nonce", e: now / 1000 + 600 }, "k");
    expect(verifyState(state, "k", now)).toEqual({ ok: true, payload: { u: "user-1", n: "nonce", e: now / 1000 + 600 } });
    expect(verifyState(state, "outra-chave", now)).toEqual({ ok: false, reason: "bad_signature" });
    const [body, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "user-2", n: "nonce", e: now / 1000 + 600 })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, "k", now).ok).toBe(false);
    expect(verifyState(`${body}.${sig}`, "k", now + 601_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyState("lixo", "k", now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("decodeJwtPayload lê o payload", () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ tid: "t1" })).toString("base64url")}.y`;
    expect(decodeJwtPayload(jwt)).toEqual({ tid: "t1" });
    expect(decodeJwtPayload("nope")).toBeNull();
  });
});

describe("configuração", () => {
  it("credenciais próprias com fallback para as do login", () => {
    expect(resolveM365Credentials({ M365_CLIENT_ID: "a", M365_CLIENT_SECRET: "b", M365_TENANT_ID: "t" } as unknown as NodeJS.ProcessEnv)).toEqual({
      ok: true,
      credentials: { clientId: "a", clientSecret: "b", tenantId: "t" },
    });
    expect(
      resolveM365Credentials({
        AUTH_MICROSOFT_ENTRA_ID_ID: "la",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "lb",
        AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: "lt",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ ok: true, credentials: { clientId: "la", clientSecret: "lb", tenantId: "lt" } });
    expect(resolveM365Credentials({} as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "missing_credentials" });
    expect(
      resolveM365Credentials({ M365_CLIENT_ID: "a", M365_CLIENT_SECRET: "b", M365_TENANT_ID: "organizations" } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ ok: false, reason: "forbidden_tenant" });
  });

  it("base do redirect: AUTH_URL; em produção sem ela = null (nunca o Host do cliente)", () => {
    expect(resolveAppBaseUrl("http://evil", { AUTH_URL: "https://flow.jump.tec.br/" } as unknown as NodeJS.ProcessEnv)).toBe("https://flow.jump.tec.br");
    expect(resolveAppBaseUrl("http://evil", { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveAppBaseUrl("http://localhost:3000", { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toBe("http://localhost:3000");
  });
});
