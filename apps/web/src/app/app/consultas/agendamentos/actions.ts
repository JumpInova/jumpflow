"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isConsultaError, type ConsultaErrorCode } from "@/lib/consultas/errors";

/**
 * Server actions de envio agendado (C3). Recebem só dados de formulário; dono,
 * permissão (`CONSULTAS_AGENDAR`), alvo e destinatários são validados no
 * servidor (lib/db/consultas-schedules.ts).
 */

type Failure = { ok: false; code: ConsultaErrorCode; error: string };
export type ScheduleActionResult<T = null> = { ok: true; data: T } | Failure;

const NO_DATABASE: Failure = {
  ok: false,
  code: "NO_DATABASE",
  error: "Banco de dados indisponível neste ambiente.",
};

const INVALID_ID: Failure = { ok: false, code: "NOT_FOUND", error: "Agendamento não encontrado." };

function asId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function failure(error: unknown, fallback: string): Failure {
  if (isConsultaError(error)) return { ok: false, code: error.code, error: error.message };
  console.error("[consultas] erro inesperado em agendamentos", error);
  return { ok: false, code: "FAILED", error: fallback };
}

export async function salvarAgendamento(input: unknown): Promise<ScheduleActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  try {
    const { createSchedule } = await import("@/lib/db/consultas-schedules");
    const id = await createSchedule(user, input);
    revalidatePath("/app/consultas/agendamentos");
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error, "Não foi possível salvar o agendamento.");
  }
}

export async function atualizarAgendamento(
  scheduleId: unknown,
  input: unknown,
): Promise<ScheduleActionResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(scheduleId);
  if (!id) return INVALID_ID;
  try {
    const { updateSchedule } = await import("@/lib/db/consultas-schedules");
    await updateSchedule(user, id, input);
    revalidatePath("/app/consultas/agendamentos");
    return { ok: true, data: null };
  } catch (error) {
    return failure(error, "Não foi possível atualizar o agendamento.");
  }
}

export async function excluirAgendamento(scheduleId: unknown): Promise<ScheduleActionResult> {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return NO_DATABASE;
  const id = asId(scheduleId);
  if (!id) return INVALID_ID;
  try {
    const { deleteSchedule } = await import("@/lib/db/consultas-schedules");
    await deleteSchedule(user, id);
    revalidatePath("/app/consultas/agendamentos");
    return { ok: true, data: null };
  } catch (error) {
    return failure(error, "Não foi possível excluir o agendamento.");
  }
}
