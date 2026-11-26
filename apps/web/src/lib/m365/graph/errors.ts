/**
 * Erros tipados do Microsoft Graph. Quem chama decide o efeito pela `kind`:
 *  - `reauth`    → conexão REAUTH_REQUIRED (token revogado/expirado, consentimento retirado).
 *  - `config`    → conexão ERROR (credenciais do app/tenant inválidos).
 *  - `throttled` → tentar na próxima rodada (429/503/504 esgotados ou espera longa).
 *  - `resync`    → cursor delta inválido (410 / syncStateNotFound): recomeçar a janela.
 *  - `not_found` → recurso inexistente (404).
 *  - `forbidden` → permissão negada (403).
 *  - `http`      → demais falhas (5xx, rede, timeout, resposta inesperada).
 *
 * As mensagens nunca contêm token nem conteúdo pessoal (só status/código).
 */
export type GraphErrorKind =
  | "reauth"
  | "config"
  | "throttled"
  | "resync"
  | "not_found"
  | "forbidden"
  | "http";

/** Origem local: fim do prazo da rodada ou timeout da chamada. */
export type GraphErrorCause = "deadline" | "timeout";

export class GraphError extends Error {
  readonly kind: GraphErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAfterMs: number | null;
  readonly localCause: GraphErrorCause | null;

  constructor(
    kind: GraphErrorKind,
    message: string,
    opts: {
      status?: number | null;
      code?: string | null;
      retryAfterMs?: number | null;
      cause?: GraphErrorCause | null;
    } = {},
  ) {
    super(message);
    this.name = "GraphError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.localCause = opts.cause ?? null;
  }
}

export function isGraphError(error: unknown): error is GraphError {
  return error instanceof GraphError;
}

/**
 * Interrupção que não deve virar erro persistente da conexão: throttling, fim
 * do prazo da rodada ou timeout — a próxima rodada continua do cursor.
 */
export function isInterruption(error: unknown): boolean {
  return (
    isGraphError(error) &&
    (error.kind === "throttled" ||
      error.localCause === "deadline" ||
      error.localCause === "timeout")
  );
}

/** Código curto e seguro para `lastError`/IntegrationEvent (sem PII/tokens). */
export function errorCode(error: unknown): string {
  if (isGraphError(error)) {
    const parts: string[] = [error.kind];
    if (error.status) parts.push(String(error.status));
    if (error.code) parts.push(error.code.slice(0, 60));
    if (error.localCause) parts.push(error.localCause);
    return parts.join(":");
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 60);
  return "unknown";
}

/** Mapeia status HTTP + código de erro do Graph para a `kind`. */
export function kindForStatus(status: number, code: string | null): GraphErrorKind {
  const c = (code ?? "").toLowerCase();
  if (status === 410 || c === "syncstatenotfound" || c === "resyncrequired" || c === "syncstateinvalid") {
    return "resync";
  }
  if (status === 401) return "reauth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429 || status === 503 || status === 504) return "throttled";
  if (status === 400 && c === "invalidauthenticationtoken") return "reauth";
  return "http";
}
