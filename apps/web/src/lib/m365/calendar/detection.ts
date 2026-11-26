import type { NormalizedAttendee } from "./normalize";

/**
 * Detecção PURA de checkpoint/1:1 na agenda de um GESTOR (papel em
 * CHECKPOINT_WRITE_ROLES — conferido por quem chama).
 *
 * O evento vira rascunho quando:
 *  - não está cancelado;
 *  - foi organizado pelo próprio gestor (e-mail da caixa ou do usuário);
 *  - tem EXATAMENTE um consultor entre os participantes (sem contar o
 *    organizador nem recursos/salas) e esse consultor está no escopo do gestor;
 *  - o assunto casa com {@link CHECKPOINT_SUBJECT_RE} OU tem a categoria JumpFlow.
 *
 * Tipo: ONE_ON_ONE se o assunto indicar 1:1; senão CHECKPOINT.
 *
 * Fronteiras: "1:1" não pode ter dígito nem ":" colado (assim "Daily 11:15" ou
 * "Sync 21:10" NÃO casam); as formas por extenso usam `\b`.
 */

export const ONE_ON_ONE_SUBJECT_RE =
  /(?<![\d:])1:1(?![\d:])|\b1-on-1\b|\bone on one\b|\b1on1\b/i;
export const CHECKPOINT_SUBJECT_RE = new RegExp(
  `${ONE_ON_ONE_SUBJECT_RE.source}|\\bcheckpoint\\b|\\bcheck-in\\b`,
  "i",
);
export const JUMPFLOW_CATEGORY = "jumpflow";

export interface DetectionEvent {
  subject: string | null;
  organizerEmail: string | null;
  attendees: readonly NormalizedAttendee[];
  categories: readonly string[];
  isCancelled: boolean;
}

export interface DetectionInput {
  event: DetectionEvent;
  /** E-mails do gestor (caixa conectada + e-mail do usuário), minúsculos. */
  managerEmails: readonly string[];
  /** e-mail (minúsculo) → Consultant.id, para TODOS os consultores conhecidos. */
  consultantIdByEmail: ReadonlyMap<string, string>;
  /** Consultores no escopo de escrita do gestor (canTargetConsultant). */
  inScopeConsultantIds: ReadonlySet<string>;
}

export type DetectionResult =
  | { kind: "checkpoint"; consultantId: string; type: "ONE_ON_ONE" | "CHECKPOINT" }
  | {
      kind: "skip";
      reason:
        | "cancelled"
        | "not_organizer"
        | "no_signal"
        | "consultant_count"
        | "out_of_scope";
    };

export function hasJumpFlowCategory(categories: readonly string[]): boolean {
  return categories.some((c) => c.trim().toLowerCase() === JUMPFLOW_CATEGORY);
}

/** Consultores (distintos) entre os participantes, sem organizador/gestor e salas. */
export function consultantsAmongAttendees(input: DetectionInput): string[] {
  const managers = new Set(input.managerEmails.map((e) => e.toLowerCase()));
  const organizer = input.event.organizerEmail?.toLowerCase() ?? null;
  const ids = new Set<string>();
  for (const attendee of input.event.attendees) {
    const email = attendee.email.toLowerCase();
    if (attendee.type === "resource") continue;
    if (email === organizer || managers.has(email)) continue;
    const id = input.consultantIdByEmail.get(email);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function detectCheckpoint(input: DetectionInput): DetectionResult {
  const { event } = input;
  if (event.isCancelled) return { kind: "skip", reason: "cancelled" };
  const managers = new Set(input.managerEmails.map((e) => e.toLowerCase()));
  if (!event.organizerEmail || !managers.has(event.organizerEmail.toLowerCase())) {
    return { kind: "skip", reason: "not_organizer" };
  }
  const subject = event.subject ?? "";
  const subjectMatches = CHECKPOINT_SUBJECT_RE.test(subject);
  if (!subjectMatches && !hasJumpFlowCategory(event.categories)) {
    return { kind: "skip", reason: "no_signal" };
  }
  const consultants = consultantsAmongAttendees(input);
  if (consultants.length !== 1) return { kind: "skip", reason: "consultant_count" };
  const [consultantId] = consultants;
  if (!input.inScopeConsultantIds.has(consultantId)) {
    return { kind: "skip", reason: "out_of_scope" };
  }
  return {
    kind: "checkpoint",
    consultantId,
    type: ONE_ON_ONE_SUBJECT_RE.test(subject) ? "ONE_ON_ONE" : "CHECKPOINT",
  };
}

/**
 * Rascunho criado pela agenda pode ser arquivado quando o evento é cancelado?
 * Só se ainda for DRAFT e SEM conteúdo (notas, transcrição, áudio). Qualquer
 * conteúdo humano preserva o registro — o gestor decide.
 */
export function isDisposableDraft(checkpoint: {
  status: string;
  notes: string | null;
  transcription: string | null;
  audioStorageKey: string | null;
}): boolean {
  return (
    checkpoint.status === "DRAFT" &&
    !checkpoint.notes?.trim() &&
    !checkpoint.transcription?.trim() &&
    !checkpoint.audioStorageKey
  );
}

/**
 * Remarcação: o que atualizar num rascunho já existente quando o evento muda.
 * Regra (PURA):
 *  - só enquanto o checkpoint é DRAFT (RECORDED/EXTRACTED/ARCHIVED nunca mudam);
 *  - `occurredAt` acompanha SEMPRE o início do evento (a M2 busca a ata a
 *    partir dele);
 *  - `title` acompanha o assunto só enquanto o rascunho não tem conteúdo humano
 *    (notas/transcrição/áudio). Com conteúdo, o título é do gestor.
 * Devolve null quando nada muda.
 */
export function draftRescheduleChange(
  draft: {
    status: string;
    occurredAt: Date;
    title: string | null;
    notes: string | null;
    transcription: string | null;
    audioStorageKey: string | null;
  },
  event: { occurredAt: Date; title: string | null },
): { occurredAt?: Date; title?: string | null } | null {
  if (draft.status !== "DRAFT") return null;
  const change: { occurredAt?: Date; title?: string | null } = {};
  if (draft.occurredAt.getTime() !== event.occurredAt.getTime()) change.occurredAt = event.occurredAt;
  if (isDisposableDraft(draft) && (draft.title ?? null) !== (event.title ?? null)) change.title = event.title;
  return Object.keys(change).length > 0 ? change : null;
}
