import type { ActionItemInput } from "./generate";

/**
 * Porta de persistência das atas por e-mail (M365 M2). Implementação real em
 * `lib/db/m365-minutes.ts` (Prisma); testes usam `testing/memory-minutes-store`.
 * Concorrência no BANCO: o lease da conexão do gestor serializa as rodadas e o
 * `internetMessageId` é ÚNICO (um e-mail alimenta no máximo um Checkpoint).
 */

export type EmailMinutesStatus = "SEARCHING" | "AMBIGUOUS" | "DONE" | "FAILED";

export interface MinutesCheckpoint {
  checkpointId: string;
  managerUserId: string | null;
  consultantId: string;
  type: "ONE_ON_ONE" | "CHECKPOINT";
  checkpointStatus: "DRAFT" | "RECORDED" | "EXTRACTED" | "ARCHIVED";
  notes: string | null;
  transcription: string | null;
  audioStorageKey: string | null;
  occurredAt: Date;
  eventSubject: string | null;
  eventStartAt: Date;
  eventEndAt: Date;
  eventCancelled: boolean;
  minutesStatus: EmailMinutesStatus | null;
}

export interface SaveMinutesInput {
  checkpointId: string;
  /** Valores lidos na avaliação (concorrência otimista com o gestor). */
  expected: { notes: string | null; transcription: string | null };
  notes: string;
  /** Texto-fonte JÁ MASCARADO. */
  transcription: string;
  source: { internetMessageId: string; webLink: string | null; receivedAt: Date };
  attachmentsUsed: number;
  attachmentsSkipped: number;
  aiSummary: boolean;
  actionItems: ActionItemInput[];
  now: Date;
}

export type SaveMinutesResult = "saved" | "duplicate_message" | "checkpoint_changed";

export interface MinutesStore {
  /**
   * Rascunhos elegíveis cujo GESTOR tem conexão ACTIVE com `Mail.Read`: DRAFT,
   * evento encerrado há < 7 dias e não cancelado, sem ata (notas/transcrição/
   * áudio), sem busca concluída/ambígua (FAILED é recuperável) e não checados há pouco.
   */
  listDueCheckpoints(now: Date, limit: number): Promise<MinutesCheckpoint[]>;
  getMinutesCheckpoint(checkpointId: string): Promise<MinutesCheckpoint | null>;
  connectionIdForUser(userId: string): Promise<string | null>;
  /** e-mails (minúsculos) do consultor: cadastro + usuário vinculado. */
  consultantEmails(consultantId: string): Promise<string[]>;
  /** Quais destes internetMessageIds (minúsculos) já alimentaram OUTRO checkpoint. */
  usedInternetMessageIds(ids: string[], exceptCheckpointId: string): Promise<Set<string>>;
  /** Registra a tentativa (sem conteúdo). Devolve o status anterior. */
  recordSearch(
    checkpointId: string,
    outcome: { status: Exclude<EmailMinutesStatus, "DONE">; error: string | null },
    now: Date,
  ): Promise<{ previousStatus: EmailMinutesStatus | null }>;
  /**
   * Grava a ata numa transação: origem com internetMessageId ÚNICO, notas/
   * transcrição/RECORDED só se o rascunho continua DRAFT e como foi lido, e os
   * cards de ação PENDING. Corrida/duplicado → nada é gravado.
   */
  saveMinutes(input: SaveMinutesInput): Promise<SaveMinutesResult>;
  /** Aviso in-app ao gestor (sem nome/e-mail de pessoas). Best-effort. */
  notifyManager(input: { userId: string; checkpointId: string; kind: "ready" | "choice" }): Promise<void>;
}
