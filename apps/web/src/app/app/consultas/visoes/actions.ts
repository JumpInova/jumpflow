"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isConsultaError, type ConsultaErrorCode } from "@/lib/consultas/errors";
import type { ConsultaRunResult } from "@/lib/db/consultas";

/**
 * Server actions de visões salvas e painéis. Recebem só identificadores e
 * dados de formulário; a spec de uma visão salva é SEMPRE lida no servidor e
 * executada com a permissão de quem chama (lib/db/consultas-saved.ts).
 */

type Failure = { ok: false; code: ConsultaErrorCode; error: string };

export type SavedActionResult<T = null> = { ok: true; data: T } | Failure;

const NO_DATABASE: Failure = {
  ok: false,
  code: "NO_DATABASE",
  error: "Banco de dados indisponível neste ambiente.",
};

function failure(error: unknown, fallback: string): Failure {
  if (isConsultaError(error)) return { ok: false, code: error.code, error: error.message };
  console.error("[consultas] erro inesperado em visões/painéis", error);
  return { ok: false, code: "FAILED", error: fallback };
}

function asId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

const INVALID_ID: Failure = { ok: false, code: "NOT_FOUND", error: "Registro não encontrado." };

/** Executa a visão salva (página de 100) com a permissão de quem vê. */
export async function executarVisao(
  viewId: unknown,
  page: unknown,
): Promise<SavedActionResult<ConsultaRunResult>> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(viewId);
  if (!id) return INVALID_ID;
  const pageNumber = typeof page === "number" && Number.isFinite(page) ? page : 1;
  try {
    const { runSavedView } = await import("@/lib/db/consultas-saved");
    return { ok: true, data: await runSavedView(user, id, pageNumber) };
  } catch (error) {
    return failure(error, "Não foi possível executar a visão.");
  }
}

export interface VisaoForm {
  name: string;
  description?: string | null;
  visualization: string;
  sharing: string;
  sharedRoles?: string[];
}

/** Salva a consulta do construtor como visão nova. */
export async function salvarVisao(
  spec: unknown,
  form: VisaoForm,
): Promise<SavedActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  try {
    const { createSavedView } = await import("@/lib/db/consultas-saved");
    const id = await createSavedView(user, { spec, ...form });
    revalidatePath("/app/consultas/visoes");
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "Não foi possível salvar a visão.");
  }
}

/** Altera nome/descrição/visualização/compartilhamento e, opcionalmente, a spec (só o dono). */
export async function atualizarVisao(
  viewId: unknown,
  form: VisaoForm,
  spec?: unknown,
): Promise<SavedActionResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(viewId);
  if (!id) return INVALID_ID;
  try {
    const { updateSavedView } = await import("@/lib/db/consultas-saved");
    await updateSavedView(user, id, { ...form, ...(spec !== undefined ? { spec } : {}) });
    revalidatePath("/app/consultas/visoes");
    revalidatePath(`/app/consultas/visoes/${id}`);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error, "Não foi possível atualizar a visão.");
  }
}

export async function excluirVisao(viewId: unknown): Promise<SavedActionResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(viewId);
  if (!id) return INVALID_ID;
  try {
    const { deleteSavedView } = await import("@/lib/db/consultas-saved");
    await deleteSavedView(user, id);
    revalidatePath("/app/consultas/visoes");
    return { ok: true, data: null };
  } catch (error) {
    return failure(error, "Não foi possível excluir a visão.");
  }
}

export interface PainelForm {
  name: string;
  description?: string | null;
  items: { viewId: string; size?: string }[];
  sharing: string;
  /** Edição: manter (padrão) ou remover as visões que o dono não pode mais abrir. */
  keepUnavailable?: boolean;
  sharedRoles?: string[];
}

export async function salvarPainel(form: PainelForm): Promise<SavedActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  try {
    const { createPanel } = await import("@/lib/db/consultas-saved");
    const id = await createPanel(user, form);
    revalidatePath("/app/consultas/paineis");
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "Não foi possível salvar o painel.");
  }
}

export async function atualizarPainel(panelId: unknown, form: PainelForm): Promise<SavedActionResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(panelId);
  if (!id) return INVALID_ID;
  try {
    const { updatePanel } = await import("@/lib/db/consultas-saved");
    await updatePanel(user, id, form);
    revalidatePath("/app/consultas/paineis");
    revalidatePath(`/app/consultas/paineis/${id}`);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error, "Não foi possível atualizar o painel.");
  }
}

export async function excluirPainel(panelId: unknown): Promise<SavedActionResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(panelId);
  if (!id) return INVALID_ID;
  try {
    const { deletePanel } = await import("@/lib/db/consultas-saved");
    await deletePanel(user, id);
    revalidatePath("/app/consultas/paineis");
    return { ok: true, data: null };
  } catch (error) {
    return failure(error, "Não foi possível excluir o painel.");
  }
}
