"use server";

import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isConsultaError, type ConsultaErrorCode } from "@/lib/consultas/errors";
import type { ConsultaRunResult } from "@/lib/db/consultas";
import type { ConsultaSpec } from "@/lib/consultas/types";

export type ExecutarConsultaResult =
  | { ok: true; result: ConsultaRunResult }
  | { ok: false; code: ConsultaErrorCode; error: string };

/**
 * Executa a consulta do construtor. Recebe só a spec (AST) e a página; acesso,
 * validação, escopo de linha/coluna, timeout e auditoria ficam no servidor
 * (`runConsulta`). Nunca devolve detalhes do banco ao cliente.
 */
export async function executarConsulta(
  spec: unknown,
  page: unknown,
): Promise<ExecutarConsultaResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) {
    return {
      ok: false,
      code: "NO_DATABASE",
      error: "Banco de dados indisponível neste ambiente.",
    };
  }
  const pageNumber = typeof page === "number" && Number.isFinite(page) ? page : 1;
  try {
    const { runConsulta } = await import("@/lib/db/consultas");
    return { ok: true, result: await runConsulta(user, spec, pageNumber) };
  } catch (error) {
    if (isConsultaError(error)) {
      return { ok: false, code: error.code, error: error.message };
    }
    console.error("[consultas] erro inesperado", error);
    return {
      ok: false,
      code: "FAILED",
      error: "Não foi possível executar a consulta.",
    };
  }
}

export type GerarConsultaIAResult =
  | { ok: true; spec: ConsultaSpec; entityLabel: string; explanation: string[] }
  | { ok: false; code: string; error: string };

/**
 * Assistente de IA: pedido em linguagem natural → spec. Não executa nada: a
 * spec volta para o usuário conferir (explicação determinística) e só roda
 * depois de confirmada, pelo caminho normal (`executarConsulta`).
 */
export async function gerarConsultaComIA(request: unknown): Promise<GerarConsultaIAResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) {
    return {
      ok: false,
      code: "NO_DATABASE",
      error: "Banco de dados indisponível neste ambiente.",
    };
  }
  try {
    const { assistConsulta } = await import("@/lib/db/consultas-ai");
    return await assistConsulta(user, request);
  } catch (error) {
    if (isConsultaError(error)) {
      return { ok: false, code: error.code, error: error.message };
    }
    console.error("[consultas] erro inesperado no assistente", error);
    return {
      ok: false,
      code: "FAILED",
      error: "O assistente falhou. Use o construtor manual.",
    };
  }
}
