import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { M365Credentials } from "./config";
import { isForbiddenTenant } from "./config";
import { assertScopesForPhase, splitScopes, type M365Phase } from "./scopes";

/**
 * Microsoft 365 — OAuth 2.0 authorization code + PKCE (S256), delegado.
 *
 * - `state` assinado com HMAC-SHA256 (userId + nonce + expiração). O nonce
 *   também vai no cookie httpOnly cifrado: o callback exige state válido, do
 *   MESMO usuário logado e com o MESMO nonce do cookie.
 * - `code_verifier` só existe no cookie cifrado (field-encryption) com path
 *   restrito a `/api/integrations/m365`.
 * - Token endpoint por `fetch` injetável (testes usam fake, nunca a Microsoft).
 * - O `id_token` vem DIRETO do token endpoint (TLS + client secret), então o
 *   payload é lido sem verificar assinatura — apenas para `tid`/`oid`. A
 *   identidade final é conferida contra `/me` do Graph.
 */

export const M365_OAUTH_COOKIE = "m365_oauth";
export const M365_OAUTH_COOKIE_PATH = "/api/integrations/m365";
export const STATE_TTL_SECONDS = 600;

const AUTHORITY = "https://login.microsoftonline.com";

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ── state assinado ───────────────────────────────────────────────────────────

export interface StatePayload {
  /** User.id do usuário logado que iniciou o fluxo. */
  u: string;
  /** Nonce aleatório (também no cookie). */
  n: string;
  /** Expiração (epoch seconds). */
  e: number;
}

const DEV_STATE_SECRET = "jumpflow-dev-m365-state-secret";

/**
 * Segredo do HMAC do state: `M365_STATE_SECRET` → `AUTH_SECRET`. Em produção sem
 * nenhum dos dois = null (erro de configuração); fora de produção, um segredo
 * fixo de desenvolvimento.
 */
export function resolveStateSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = env.M365_STATE_SECRET?.trim() || env.AUTH_SECRET?.trim() || "";
  if (secret) return secret;
  return env.NODE_ENV === "production" ? null : DEV_STATE_SECRET;
}

function hmac(secret: string, data: string): string {
  return base64url(createHmac("sha256", secret).update(data).digest());
}

export function createNonce(): string {
  return base64url(randomBytes(16));
}

export function signState(payload: StatePayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${hmac(secret, body)}`;
}

export type StateCheck =
  | { ok: true; payload: StatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyState(
  state: string,
  secret: string,
  nowMs: number = Date.now(),
): StateCheck {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [body, sig] = parts;
  const expected = Buffer.from(hmac(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.u !== "string" ||
    typeof payload?.n !== "string" ||
    typeof payload?.e !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.e * 1000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** Conteúdo (antes de cifrar) do cookie do fluxo. */
export interface OAuthCookiePayload {
  nonce: string;
  verifier: string;
  userId: string;
  exp: number;
}

// ── authorize URL ────────────────────────────────────────────────────────────

export interface AuthorizeUrlInput {
  credentials: M365Credentials;
  redirectUri: string;
  /** Escopos pedidos (array e/ou string separada por espaço). */
  scopes: string | readonly string[];
  phase: M365Phase;
  state: string;
  codeChallenge: string;
  loginHint?: string;
}

/**
 * Monta a URL de consentimento. Recusa (throw ForbiddenScopeError) qualquer
 * escopo proibido ou fora da fase — inclusive escondido numa string com espaços.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  if (isForbiddenTenant(input.credentials.tenantId)) {
    throw new Error("Tenant multi-locatário não é aceito.");
  }
  const scopes = assertScopesForPhase(input.scopes, input.phase);
  const url = new URL(
    `${AUTHORITY}/${encodeURIComponent(input.credentials.tenantId)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", input.credentials.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

// ── token endpoint ───────────────────────────────────────────────────────────

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface TokenSet {
  accessToken: string;
  /** Pode faltar no refresh (Microsoft nem sempre rotaciona). */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
  idTokenClaims: Record<string, unknown> | null;
}

/** Falha do token endpoint. `reauth` = o usuário precisa reconectar. */
export class OAuthTokenError extends Error {
  readonly code: string;
  readonly reauth: boolean;
  readonly status: number | null;
  constructor(code: string, status: number | null) {
    super(`Falha no token endpoint (${code}).`);
    this.name = "OAuthTokenError";
    this.code = code;
    this.status = status;
    this.reauth = REAUTH_CODES.has(code);
  }
}

const REAUTH_CODES = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
  "login_required",
]);

/** Lê o payload de um JWT (sem verificar assinatura — ver nota do módulo). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface TokenRequestDeps {
  credentials: M365Credentials;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

async function postToken(
  deps: TokenRequestDeps,
  form: Record<string, string>,
): Promise<TokenSet> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const url = `${AUTHORITY}/${encodeURIComponent(deps.credentials.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: deps.credentials.clientId,
    client_secret: deps.credentials.clientSecret,
    ...form,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch {
    throw new OAuthTokenError("network_error", null);
  } finally {
    clearTimeout(timer);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    throw new OAuthTokenError(code, res.status);
  }
  const accessToken = typeof json.access_token === "string" ? json.access_token : "";
  if (!accessToken) throw new OAuthTokenError("invalid_response", res.status);
  const expiresIn = Number(json.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: new Date(now() + ttl * 1000),
    scopes: typeof json.scope === "string" ? splitScopes(json.scope) : [],
    idTokenClaims:
      typeof json.id_token === "string" ? decodeJwtPayload(json.id_token) : null,
  };
}

export function exchangeAuthorizationCode(
  deps: TokenRequestDeps,
  input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    scopes: readonly string[];
  },
): Promise<TokenSet> {
  return postToken(deps, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(" "),
  });
}

export function refreshAccessToken(
  deps: TokenRequestDeps,
  input: { refreshToken: string; scopes: readonly string[] },
): Promise<TokenSet> {
  return postToken(deps, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    scope: input.scopes.join(" "),
  });
}

/** `tid` do token (id_token preferido; senão access token) — para conferir tenant. */
export function tenantIdFromTokenSet(tokens: TokenSet): string | null {
  const fromId = tokens.idTokenClaims?.tid;
  if (typeof fromId === "string" && fromId) return fromId;
  const fromAccess = decodeJwtPayload(tokens.accessToken)?.tid;
  return typeof fromAccess === "string" && fromAccess ? fromAccess : null;
}
