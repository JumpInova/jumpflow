"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/actions/result";
import { canTransitionActionItem, type ActionItemStatus } from "@/lib/checkpoint/action-items";
import { canManageCheckpoint } from "@/lib/checkpoint/visibility";
import type { ManualResult, MinutesChoiceView, ProcessOutcome } from "@/lib/m365/minutes/run";
import { m365RuntimeGate } from "@/lib/m365/runtime";

/**
 * Ações de Microsoft 365 na tela do Checkpoint (M2):
 * - "Buscar ata no e-mail" e a escolha do e-mail em caso de empate: SÓ o gestor
 *   do checkpoint, e só na PRÓPRIA caixa (nem ADMIN/PEOPLE leem a caixa de
 *   outra pessoa). As candidatas vêm ao vivo e não são persistidas.
 * - Validação dos cards de Ação: autor/PEOPLE/ADMIN (mesma porta de gestão do
 *   checkpoint), com o checkpoint dentro do escopo de leitura.
 * Com `M365_INTEGRATION_ENABLED` desligada, tudo fica inerte.
 */

const CHECKPOINT_PATH = "/app/checkpoints";

const idSchema = z.string().trim().min(1).max(100);
// Id de mensagem do Graph: allowlist de caracteres (base64/base64url do Exchange).
const chooseSchema = z.object({
  checkpointId: idSchema,
  messageId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_\-=+/]+$/)
    .regex(/[A-Za-z0-9]/),
});
const decideSchema = z.object({
  id: idSchema,
  status: z.enum(["ACCEPTED", "DONE", "DISMISSED"]),
});

function gateFailure(): ActionResult<never> | null {
  const gate = m365RuntimeGate();
  if (gate.ok) return null;
  return {
    ok: false,
    error: gate.reason === "no_database" ? "NO_DATABASE" : "FORBIDDEN",
    message: "A integração com o Microsoft 365 não está disponível.",
  };
}

/** Guard carregado sob demanda (mantém o módulo leve para a árvore cliente). */
async function requireCheckpointEdit() {
  const { requirePermission } = await import("@/lib/auth/guards");
  return requirePermission("CHECKPOINT", "edit");
}

async function actorUserId(): Promise<string | null> {
  const user = await requireCheckpointEdit();
  const { resolveDbUser } = await import("@/lib/db/users");
  return (await resolveDbUser(user))?.id ?? null;
}

const MANUAL_MESSAGES: Record<Exclude<ManualResult<unknown>, { ok: true }>["code"], string> = {
  not_found: "Checkpoint não encontrado.",
  forbidden: "Só o gestor que registra este checkpoint pode buscar a ata na própria caixa.",
  not_eligible: "Este checkpoint não está aguardando ata (já tem conteúdo ou a reunião não terminou há menos de 7 dias).",
  not_connected: "Ative as atas por e-mail em Minha conta › Microsoft 365.",
  busy: "Uma sincronização da sua conta já está em andamento. Tente de novo em instantes.",
  unavailable: "Não foi possível consultar o e-mail agora. Tente de novo em instantes.",
  reauth: "A Microsoft pediu uma nova autorização. Reconecte sua conta em Minha conta › Microsoft 365.",
};

function manualError(result: Exclude<ManualResult<unknown>, { ok: true }>): ActionResult<never> {
  const error = result.code === "not_found" ? "NOT_FOUND" : result.code === "forbidden" ? "FORBIDDEN" : "NOT_EDITABLE";
  return { ok: false, error, message: MANUAL_MESSAGES[result.code] };
}

const OUTCOME_MESSAGES: Record<ProcessOutcome, string> = {
  saved: "Ata gerada a partir do e-mail. Revise as notas, as ações e os insights.",
  saved_without_ai: "E-mail importado, mas a IA não estava disponível: o texto (mascarado) está na transcrição.",
  none: "Nenhum e-mail de ata encontrado ainda. A busca continua automaticamente por 7 dias.",
  ambiguous: "Mais de um e-mail pode ser a ata. Escolha qual usar.",
  failed: "O e-mail não tem texto legível (PDF escaneado não é suportado).",
  duplicate: "Esse e-mail já foi usado como ata de outro checkpoint.",
  checkpoint_changed: "O checkpoint mudou enquanto a ata era gerada. Nada foi sobrescrito.",
  not_eligible: "Este checkpoint não está aguardando ata.",
  not_candidate: "Esse e-mail não corresponde a esta reunião.",
};

export async function searchCheckpointMinutes(
  checkpointId: string,
): Promise<ActionResult<{ outcome: ProcessOutcome; message: string }>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const parsed = idSchema.safeParse(checkpointId);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", message: "Checkpoint inválido." };
  const actor = await actorUserId();
  if (!actor) return { ok: false, error: "FORBIDDEN", message: MANUAL_MESSAGES.forbidden };
  const { searchCheckpointMinutesNow } = await import("@/lib/m365/runtime");
  const result = await searchCheckpointMinutesNow(parsed.data, actor);
  if (!result.ok) return manualError(result);
  revalidatePath(CHECKPOINT_PATH);
  return { ok: true, data: { outcome: result.value, message: OUTCOME_MESSAGES[result.value] } };
}

export async function listCheckpointMinutesCandidates(
  checkpointId: string,
): Promise<ActionResult<MinutesChoiceView[]>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const parsed = idSchema.safeParse(checkpointId);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", message: "Checkpoint inválido." };
  const actor = await actorUserId();
  if (!actor) return { ok: false, error: "FORBIDDEN", message: MANUAL_MESSAGES.forbidden };
  const { listCheckpointMinutesChoices } = await import("@/lib/m365/runtime");
  const result = await listCheckpointMinutesChoices(parsed.data, actor);
  if (!result.ok) return manualError(result);
  return { ok: true, data: result.value };
}

export async function chooseCheckpointMinutesEmail(input: {
  checkpointId: string;
  messageId: string;
}): Promise<ActionResult<{ outcome: ProcessOutcome; message: string }>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const parsed = chooseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", message: "Escolha inválida." };
  const actor = await actorUserId();
  if (!actor) return { ok: false, error: "FORBIDDEN", message: MANUAL_MESSAGES.forbidden };
  const { chooseCheckpointMinutesMessage } = await import("@/lib/m365/runtime");
  const result = await chooseCheckpointMinutesMessage(parsed.data.checkpointId, parsed.data.messageId, actor);
  if (!result.ok) return manualError(result);
  revalidatePath(CHECKPOINT_PATH);
  return { ok: true, data: { outcome: result.value, message: OUTCOME_MESSAGES[result.value] } };
}

/**
 * Validação de um card de Ação pelo gestor. Fora de escopo ou sem gestão =
 * mesmo NOT_FOUND (anti-enumeração).
 */
export async function decideCheckpointActionItem(input: {
  id: string;
  status: "ACCEPTED" | "DONE" | "DISMISSED";
}): Promise<ActionResult<{ id: string; status: ActionItemStatus }>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", message: "Decisão inválida." };
  const user = await requireCheckpointEdit();
  const { resolveDbUser } = await import("@/lib/db/users");
  const dbUser = await resolveDbUser(user);
  const { prisma } = await import("@jumpflow/database");
  const { canViewCheckpointInScope } = await import("@/lib/db/checkpoint");
  const notFound: ActionResult<never> = { ok: false, error: "NOT_FOUND", message: "Ação não encontrada." };

  const item = await prisma.checkpointActionItem.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, status: true, checkpointId: true, checkpoint: { select: { managerUserId: true } } },
  });
  if (!item) return notFound;
  if (!(await canViewCheckpointInScope(user, item.checkpointId))) return notFound;
  if (!canManageCheckpoint({ roles: user.roles, userId: dbUser?.id ?? null }, item.checkpoint.managerUserId)) {
    return notFound;
  }
  if (!canTransitionActionItem(item.status, parsed.data.status)) {
    return { ok: false, error: "ALREADY_DECIDED", message: "Esta ação já foi decidida." };
  }
  // Condicional: corrida entre dois cliques não aplica duas transições.
  const res = await prisma.checkpointActionItem.updateMany({
    where: { id: item.id, status: item.status },
    data: { status: parsed.data.status, decidedByUserId: dbUser?.id ?? null, decidedAt: new Date() },
  });
  if (res.count !== 1) return { ok: false, error: "ALREADY_DECIDED", message: "Esta ação já foi decidida." };
  const { recordAuditEvent } = await import("@/lib/db/audit");
  await recordAuditEvent({
    actorUserId: dbUser?.id ?? null,
    entityType: "CheckpointActionItem",
    entityId: item.id,
    action: "CHECKPOINT_ACTION_ITEM_DECIDED",
    before: { status: item.status },
    after: { status: parsed.data.status },
  });
  revalidatePath(CHECKPOINT_PATH);
  return { ok: true, data: { id: item.id, status: parsed.data.status } };
}
