import {
  ENCRYPTED_FIELDS,
  decryptField,
  encryptField,
} from "@jumpflow/database/field-encryption";
import type { M365Credentials } from "./config";
import type { AccessTokenProvider } from "./graph/client";
import { GraphError } from "./graph/errors";
import {
  OAuthTokenError,
  refreshAccessToken,
  type FetchLike,
  type TokenSet,
} from "./oauth";
import { PHASE_SCOPES, consentedPhase, phaseGrantedScopes, type M365Phase } from "./scopes";
import {
  ConnectionChangedError,
  type ConnectionWriteGuard,
  type M365ConnectionRecord,
  type M365Store,
} from "./store";

/**
 * Tokens delegados: sempre cifrados (field-encryption, AAD por coluna), nunca
 * logados. Refresh 5 min antes de expirar ou após um 401; o refresh token
 * rotacionado é SEMPRE persistido. `invalid_grant` (e afins) → REAUTH_REQUIRED.
 */

export const REFRESH_SKEW_MS = 5 * 60_000;

export function encryptAccessToken(token: string): string {
  return encryptField(ENCRYPTED_FIELDS.m365AccessToken, token);
}
export function encryptRefreshToken(token: string): string {
  return encryptField(ENCRYPTED_FIELDS.m365RefreshToken, token);
}

/** Dados cifrados prontos para persistir a partir de um TokenSet. */
export function encryptTokenSet(
  tokens: TokenSet,
  previousRefreshEncrypted: string | null,
  phase: M365Phase = "M1",
): {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  expiresAt: Date;
  scopes: string[];
} {
  const refreshTokenEncrypted = tokens.refreshToken
    ? encryptRefreshToken(tokens.refreshToken)
    : previousRefreshEncrypted;
  if (!refreshTokenEncrypted) {
    throw new OAuthTokenError("missing_refresh_token", null);
  }
  return {
    accessTokenEncrypted: encryptAccessToken(tokens.accessToken),
    refreshTokenEncrypted,
    expiresAt: tokens.expiresAt,
    // Só o concedido DENTRO da fase pedida; extras nunca vão para `scopes`.
    scopes: phaseGrantedScopes(tokens.scopes, phase),
  };
}

export function needsRefresh(
  connection: Pick<M365ConnectionRecord, "accessTokenEncrypted" | "expiresAt">,
  nowMs: number,
): boolean {
  if (!connection.accessTokenEncrypted || !connection.expiresAt) return true;
  return connection.expiresAt.getTime() - REFRESH_SKEW_MS <= nowMs;
}

const CONFIG_CODES = new Set(["invalid_client", "unauthorized_client", "invalid_request"]);
/** Falhas do refresh M2 que indicam só o escopo de e-mail retirado. */
const DOWNGRADE_CODES = new Set(["consent_required", "invalid_scope"]);

export interface TokenProviderDeps {
  store: M365Store;
  connection: M365ConnectionRecord;
  credentials: M365Credentials;
  fetch?: FetchLike;
  now?: () => number;
  /**
   * Dono do lease da rodada. Toda escrita na conexão exige que a rodada ainda
   * seja dona do lease (e a conexão ACTIVE); sem lease, nunca sobre
   * DISCONNECTED/PAUSED.
   */
  leaseOwner?: string;
}

/**
 * {@link AccessTokenProvider} de uma conexão. O estado (tokens atuais) vive no
 * objeto `connection` desta rodada e é persistido a cada refresh — a rodada
 * roda sob o lease de sync, então não há dois refresh concorrentes da mesma
 * conexão vindos do job.
 */
export function createTokenProvider(deps: TokenProviderDeps): AccessTokenProvider {
  const now = deps.now ?? Date.now;
  const conn = deps.connection;
  const guard: ConnectionWriteGuard = deps.leaseOwner ? { leaseOwner: deps.leaseOwner } : null;

  async function refresh(): Promise<string> {
    if (!conn.refreshTokenEncrypted) {
      await deps.store.setStatus(conn.id, "REAUTH_REQUIRED", "missing_refresh_token", guard);
      throw new GraphError("reauth", "Sem refresh token.", { code: "missing_refresh_token" });
    }
    let refreshToken: string;
    try {
      refreshToken = decryptField(ENCRYPTED_FIELDS.m365RefreshToken, conn.refreshTokenEncrypted);
    } catch {
      await deps.store.setStatus(conn.id, "REAUTH_REQUIRED", "token_decrypt_failed", guard);
      throw new GraphError("reauth", "Refresh token ilegível.", { code: "token_decrypt_failed" });
    }
    // Fase EFETIVAMENTE consentida (M1, ou M2 se `Mail.Read` foi concedido):
    // pede exatamente os escopos dela (com offline_access), nunca além — nem
    // escopo de fase futura mesmo se consentido fora do app.
    let phase: M365Phase = consentedPhase(conn.scopes);
    let tokens: TokenSet;
    try {
      try {
        tokens = await refreshAccessToken(
          { credentials: deps.credentials, fetch: deps.fetch, now },
          { refreshToken, scopes: PHASE_SCOPES[phase] },
        );
      } catch (error) {
        // `Mail.Read` revogado (consentimento retirado só do e-mail): recua UMA
        // vez para a M1 — a agenda continua; `scopes` grava só o concedido.
        if (
          phase === "M2" &&
          error instanceof OAuthTokenError &&
          DOWNGRADE_CODES.has(error.code)
        ) {
          phase = "M1";
          tokens = await refreshAccessToken(
            { credentials: deps.credentials, fetch: deps.fetch, now },
            { refreshToken, scopes: PHASE_SCOPES.M1 },
          );
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof OAuthTokenError) {
        if (error.reauth) {
          await deps.store.setStatus(conn.id, "REAUTH_REQUIRED", error.code, guard);
          throw new GraphError("reauth", "Reautorização necessária.", { code: error.code });
        }
        if (CONFIG_CODES.has(error.code)) {
          throw new GraphError("config", "Credenciais do app inválidas.", { code: error.code });
        }
        throw new GraphError("http", "Falha ao renovar token.", { status: error.status, code: error.code });
      }
      throw error;
    }
    const encrypted = encryptTokenSet(tokens, conn.refreshTokenEncrypted, phase);
    if (encrypted.scopes.length === 0) encrypted.scopes = phaseGrantedScopes(conn.scopes, phase);
    // Desconectado/pausado/lease perdido no meio da rodada: não grava (nunca
    // ressuscita tokens) e encerra a rodada.
    if (!(await deps.store.saveTokens(conn.id, encrypted, guard))) {
      throw new ConnectionChangedError();
    }
    conn.accessTokenEncrypted = encrypted.accessTokenEncrypted;
    conn.refreshTokenEncrypted = encrypted.refreshTokenEncrypted;
    conn.expiresAt = encrypted.expiresAt;
    conn.scopes = encrypted.scopes;
    return tokens.accessToken;
  }

  return {
    async get() {
      if (needsRefresh(conn, now())) return refresh();
      try {
        return decryptField(ENCRYPTED_FIELDS.m365AccessToken, conn.accessTokenEncrypted!);
      } catch {
        return refresh();
      }
    },
    refresh,
  };
}
