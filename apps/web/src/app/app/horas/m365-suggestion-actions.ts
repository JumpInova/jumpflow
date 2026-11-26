"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/actions/result";
import { requireUser } from "@/lib/auth/guards";
import { m365RuntimeGate } from "@/lib/m365/runtime";

const idSchema = z.string().trim().min(1).max(64);

/**
 * Ignorar uma sugestão de horas vinda da agenda (Microsoft 365). Só o próprio
 * consultor, só sugestões PENDENTES dele (escopo resolvido no servidor).
 */
export async function dismissM365TimeSuggestion(id: string): Promise<ActionResult<null>> {
  if (!m365RuntimeGate().ok) {
    return { ok: false, error: "FORBIDDEN", message: "Integração indisponível." };
  }
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", message: "Sugestão inválida." };
  const user = await requireUser();
  const { getConsultantForUser } = await import("@/lib/db/timesheet");
  const consultant = await getConsultantForUser(user);
  if (!consultant) return { ok: false, error: "NO_CONSULTANT", message: "Usuário sem vínculo de consultor." };
  const { dismissOwnSuggestion } = await import("@/lib/db/m365");
  const done = await dismissOwnSuggestion(consultant.id, parsed.data);
  if (!done) return { ok: false, error: "NOT_FOUND", message: "Sugestão não encontrada." };
  revalidatePath("/app/horas");
  return { ok: true, data: null };
}
