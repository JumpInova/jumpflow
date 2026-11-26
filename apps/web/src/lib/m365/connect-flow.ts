import {
  ENCRYPTED_FIELDS,
  decryptField,
  encryptField,
} from "@jumpflow/database/field-encryption";
import type { M365Credentials } from "./config";
import type { GraphClient } from "./graph/client";
import type { M365ErrorCode } from "./messages";
import {
  STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  createNonce,
  createPkcePair,
  exchangeAuthorizationCode,
  signState,
  tenantIdFromTokenSet,
  verifyState,
  type FetchLike,
  type OAuthCookiePayload,
  type TokenSet,
} from "./oauth";
import {
  PHASE_CAPABILITY,
  grantedForbiddenScopes,
  hasCalendarScope,
  hasMailScope,
  hasTeamsScopes,
  isCapabilityList,
  isM365Phase,
  normalizeCapabilities,
  scopesForCapabilities,
  type M365Capability,
  type M365Phase,
} from "./scopes";

/**
 * Orquestração do consentimento (início e callback), sem I/O de framework:
 * as rotas Next só leem/escrevem cookie e redirecionam. Tudo aqui é testável
 * com `fetch`/Graph fakes.
 */

// ── início ───────────────────────────────────────────────────────────────────

export interface StartInput {
  userId: string;
  userEmail: string;
  credentials: M365Credentials;
  redirectUri: string;
  stateSecret: string;
  nowMs?: number;
  /**
   * Fase a consentir (padrão M1) — rótulo do pedido. M2 = consentimento
   * INCREMENTAL de `Mail.Read` ("Ativar atas por e-mail"); M3 = dos escopos do
   * Teams ("Ativar transcrições do Teams").
   */
  phase?: M365Phase;
  /**
   * Conjunto EXATO de capacidades pedido (o já consentido + o da fase). Sem
   * ele, só a capacidade da fase. Os escopos pedidos são exatamente
   * `scopesForCapabilities(capabilities)`.
   */
  capabilities?: readonly M365Capability[];
}

export interface StartOutput {
  authorizeUrl: string;
  /** Valor CIFRADO do cookie httpOnly (nonce + code_verifier). */
  cookieValue: string;
  maxAgeSeconds: number;
}

export function startM365Connect(input: StartInput): StartOutput {
  const nowMs = input.nowMs ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + STATE_TTL_SECONDS;
  const nonce = createNonce();
  const pkce = createPkcePair();
  const phase: M365Phase = input.phase ?? "M1";
  const extra = PHASE_CAPABILITY[phase];
  const caps = normalizeCapabilities([...(input.capabilities ?? []), ...(extra ? [extra] : [])]);
  const state = signState({ u: input.userId, n: nonce, e: exp }, input.stateSecret);
  const cookie: OAuthCookiePayload = { nonce, verifier: pkce.verifier, userId: input.userId, exp, phase, caps };
  return {
    authorizeUrl: buildAuthorizeUrl({
      credentials: input.credentials,
      redirectUri: input.redirectUri,
      scopes: scopesForCapabilities(caps),
      phase: caps,
      state,
      codeChallenge: pkce.challenge,
      loginHint: input.userEmail,
    }),
    cookieValue: encryptField(ENCRYPTED_FIELDS.m365OAuthCookie, JSON.stringify(cookie)),
    maxAgeSeconds: STATE_TTL_SECONDS,
  };
}

export function readOAuthCookie(value: string | undefined | null): OAuthCookiePayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decryptField(ENCRYPTED_FIELDS.m365OAuthCookie, value)) as OAuthCookiePayload;
    if (
      typeof parsed?.nonce !== "string" ||
      typeof parsed?.verifier !== "string" ||
      typeof parsed?.userId !== "string" ||
      typeof parsed?.exp !== "number"
    ) {
      return null;
    }
    // Cookie sem fase (fluxo iniciado antes da M2) = M1; valor estranho = recusa.
    if (parsed.phase !== undefined && !isM365Phase(parsed.phase)) return null;
    if (parsed.caps !== undefined && !isCapabilityList(parsed.caps)) return null;
    const phase = parsed.phase ?? "M1";
    // Sem `caps` (cookie de antes da M3): só a capacidade da fase.
    const extra = PHASE_CAPABILITY[phase];
    const caps = normalizeCapabilities(parsed.caps ?? (extra ? [extra] : []));
    return { ...parsed, phase, caps };
  } catch {
    return null;
  }
}

// ── callback ─────────────────────────────────────────────────────────────────

export interface CallbackInput {
  /** Query do callback. */
  code: string | null;
  state: string | null;
  error: string | null;
  /** Cookie já decifrado (readOAuthCookie). */
  cookie: OAuthCookiePayload | null;
  /** Usuário logado AGORA (User.id e e-mail). */
  userId: string;
  userEmail: string;
  credentials: M365Credentials;
  redirectUri: string;
  stateSecret: string;
}

export interface ConnectedAccount {
  tokens: TokenSet;
  tenantId: string;
  graphUserId: string;
  mailbox: string;
  /** Fase pedida neste consentimento (do cookie). */
  phase: M365Phase;
  /** Conjunto de capacidades pedido (do cookie). */
  capabilities: M365Capability[];
  /** Pediu e-mail mas `Mail.Read` não veio: a agenda conecta, as atas não. */
  mailScopeMissing: boolean;
  /**
   * Pediu Teams mas os dois escopos não vieram (o admin do tenant ainda não
   * consentiu `OnlineMeetingTranscript.Read.All`): o resto conecta.
   */
  teamsScopeMissing: boolean;
}

export interface CallbackDeps {
  fetch?: FetchLike;
  nowMs?: number;
  /** Cliente Graph com o access token recém-obtido (para /me). */
  graphWithToken: (accessToken: string) => GraphClient;
}

export type CallbackResult =
  | { ok: true; account: ConnectedAccount }
  | { ok: false; code: M365ErrorCode };

export async function completeM365Callback(
  input: CallbackInput,
  deps: CallbackDeps,
): Promise<CallbackResult> {
  const nowMs = deps.nowMs ?? Date.now();
  if (input.error) {
    // Transcrições do Teams: o erro mais comum é a falta do consentimento de
    // admin do tenant para `OnlineMeetingTranscript.Read.All` (mensagem própria).
    return { ok: false, code: input.cookie?.phase === "M3" ? "teams_consent_denied" : "consent_denied" };
  }
  if (!input.code || !input.state || !input.cookie) return { ok: false, code: "invalid_state" };

  const check = verifyState(input.state, input.stateSecret, nowMs);
  if (!check.ok) return { ok: false, code: "invalid_state" };
  const { payload } = check;
  if (
    payload.u !== input.userId ||
    input.cookie.userId !== input.userId ||
    payload.n !== input.cookie.nonce ||
    input.cookie.exp * 1000 < nowMs
  ) {
    return { ok: false, code: "invalid_state" };
  }

  const phase: M365Phase = input.cookie.phase ?? "M1";
  const caps = normalizeCapabilities(input.cookie.caps ?? []);
  let tokens: TokenSet;
  try {
    tokens = await exchangeAuthorizationCode(
      { credentials: input.credentials, fetch: deps.fetch, now: () => nowMs },
      {
        code: input.code,
        codeVerifier: input.cookie.verifier,
        redirectUri: input.redirectUri,
        scopes: scopesForCapabilities(caps),
      },
    );
  } catch {
    return { ok: false, code: "token_exchange_failed" };
  }
  if (!tokens.refreshToken) return { ok: false, code: "token_exchange_failed" };

  const tid = tenantIdFromTokenSet(tokens);
  if (!tid || tid.toLowerCase() !== input.credentials.tenantId.toLowerCase()) {
    return { ok: false, code: "tenant_mismatch" };
  }
  if (grantedForbiddenScopes(tokens.scopes).length > 0) {
    return { ok: false, code: "forbidden_scope" };
  }
  if (!hasCalendarScope(tokens.scopes)) return { ok: false, code: "scope_missing" };

  let me;
  try {
    me = await deps.graphWithToken(tokens.accessToken).getMe();
  } catch {
    return { ok: false, code: "graph_unavailable" };
  }
  const expected = input.userEmail.trim().toLowerCase();
  const candidates = [me.mail, me.userPrincipalName]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim().toLowerCase());
  const mailbox = candidates.find((c) => c === expected);
  if (!mailbox) return { ok: false, code: "account_mismatch" };

  return {
    ok: true,
    account: {
      tokens,
      tenantId: tid,
      graphUserId: me.id,
      mailbox,
      phase,
      capabilities: caps,
      mailScopeMissing: caps.includes("MAIL") && !hasMailScope(tokens.scopes),
      teamsScopeMissing: caps.includes("TEAMS") && !hasTeamsScopes(tokens.scopes),
    },
  };
}
