/**
 * Erro de domínio do módulo Consultas. `code` vira status HTTP nas rotas e
 * mensagem amigável nas server actions. Nunca carrega SQL nem detalhes do banco.
 */
export type ConsultaErrorCode =
  | "INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "NO_DATABASE"
  | "FAILED";

export const CONSULTA_ERROR_STATUS: Record<ConsultaErrorCode, number> = {
  INVALID: 400,
  FORBIDDEN: 403,
  /** Visão/painel inexistente OU sem acesso (não distingue, para não vazar). */
  NOT_FOUND: 404,
  TIMEOUT: 504,
  NO_DATABASE: 503,
  FAILED: 500,
};

export class ConsultaError extends Error {
  readonly code: ConsultaErrorCode;

  constructor(code: ConsultaErrorCode, message: string) {
    super(message);
    this.name = "ConsultaError";
    this.code = code;
  }

  get status(): number {
    return CONSULTA_ERROR_STATUS[this.code];
  }
}

export function isConsultaError(error: unknown): error is ConsultaError {
  return error instanceof ConsultaError;
}
