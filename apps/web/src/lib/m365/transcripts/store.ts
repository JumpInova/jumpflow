import type { ActionItemInput } from "../minutes/generate";
import type { EmailMinutesStatus } from "../minutes/store";
import type { TranscriptMode, TranscriptStatus } from "./schedule";

/**
 * Porta de persistência da transcrição do Teams (M365 M3). Implementação real
 * em `lib/db/m365-transcripts.ts` (Prisma); testes usam
 * `testing/memory-transcript-store`. Concorrência NO BANCO: claim atômico do
 * registro (`updateMany` condicional com lease) + o lease da conexão do gestor;
 * o checkpoint só é gravado com update condicional (concorrência otimista).
 */

export interface TranscriptRecord {
  status: TranscriptStatus;
  mode: TranscriptMode | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  /** Instante do último 403 (bloqueio de 24 h). */
  accessDeniedAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
}

export interface TranscriptCheckpoint {
  checkpointId: string;
  managerUserId: string | null;
  consultantId: string;
  type: "ONE_ON_ONE" | "CHECKPOINT";
  checkpointStatus: "DRAFT" | "RECORDED" | "EXTRACTED" | "ARCHIVED";
  notes: string | null;
  transcription: string | null;
  audioStorageKey: string | null;
  occurredAt: Date;
  eventJoinUrl: string | null;
  eventOrganizerEmail: string | null;
  eventStartAt: Date;
  eventEndAt: Date;
  eventCancelled: boolean;
  emailMinutesStatus: EmailMinutesStatus | null;
  transcript: TranscriptRecord | null;
}

export interface SaveTranscriptMinutesInput {
  checkpointId: string;
  /** Dono do claim do registro (GENERATING). */
  owner: string;
  mode: TranscriptMode;
  /** Valores lidos na avaliação (concorrência otimista com o gestor/M2). */
  expected: {
    checkpointStatus: TranscriptCheckpoint["checkpointStatus"];
    notes: string | null;
    transcription: string | null;
  };
  /** Notas FINAIS do checkpoint (GENERATE: a ata; SUPPLEMENT: existentes + complemento). */
  notes: string;
  /** Transcrição FINAL do checkpoint (texto-fonte MASCARADO). */
  transcription: string;
  aiSummary: boolean;
  transcriptsUsed: number;
  truncated: boolean;
  actionItems: ActionItemInput[];
  now: Date;
}

export type SaveTranscriptResult = "saved" | "checkpoint_changed" | "lease_lost";

export interface TranscriptStore {
  /**
   * Cria PENDING (idempotente: único por checkpoint) para rascunhos DRAFT sem
   * conteúdo, com evento Teams não cancelado encerrado há < 48 h, cujo gestor
   * tem conexão ACTIVE com os escopos do Teams. Devolve quantos criou.
   */
  enrollDueCheckpoints(now: Date, limit: number): Promise<number>;
  /**
   * Registros devidos para o job: PENDING/WAITING_TRANSCRIPT com
   * `nextAttemptAt` vencido, ou GENERATING com lease vencido (rodada que
   * caiu); evento encerrado há < 48 h.
   */
  listDue(now: Date, limit: number): Promise<TranscriptCheckpoint[]>;
  getTranscriptCheckpoint(checkpointId: string): Promise<TranscriptCheckpoint | null>;
  connectionIdForUser(userId: string): Promise<string | null>;
  /** Garante o registro (PENDING) para o acionamento manual. Idempotente. */
  ensureRecord(checkpointId: string, nextAttemptAt: Date): Promise<void>;
  /**
   * Claim ATÔMICO do registro para uma tentativa: só se não está DONE, o lease
   * está livre/vencido e (job) a próxima tentativa venceu ou é GENERATING
   * abandonado. `force` (manual) ignora `nextAttemptAt` e reabre
   * NO_TRANSCRIPT/FAILED. Status não muda no claim.
   */
  claim(checkpointId: string, owner: string, until: Date, now: Date, force: boolean): Promise<boolean>;
  /** Transcrição em memória: → GENERATING (só o dono do claim). */
  markGenerating(checkpointId: string, owner: string, until: Date): Promise<boolean>;
  /**
   * Tentativa sem ata (ou falha da geração): grava status/próxima tentativa/
   * código e libera o lease. Só o dono do claim. `notified` marca o aviso.
   */
  recordAttempt(
    checkpointId: string,
    owner: string,
    outcome: {
      status: Extract<TranscriptStatus, "WAITING_TRANSCRIPT" | "NO_TRANSCRIPT" | "FAILED">;
      nextAttemptAt: Date | null;
      error: string | null;
      /** 403: grava o instante do bloqueio (ausente = mantém o anterior). */
      accessDeniedAt?: Date;
    },
    now: Date,
  ): Promise<boolean>;
  /**
   * Fim da tentativa (sempre, no `finally`): se este dono ainda segura o
   * registro EM GENERATING (rodada interrompida depois de `markGenerating` —
   * lease da conexão perdido, erro da conexão…), aplica `ifGenerating` (volta a
   * WAITING_TRANSCRIPT com backoff, ou FAILED fora de 48 h) — nunca deixa
   * GENERATING órfão. Em qualquer caso solta o lease deste dono.
   */
  releaseClaim(
    checkpointId: string,
    owner: string,
    ifGenerating: {
      status: Extract<TranscriptStatus, "WAITING_TRANSCRIPT" | "FAILED">;
      nextAttemptAt: Date | null;
      error: string;
    },
    now: Date,
  ): Promise<void>;
  /**
   * Varredura: registros não finais (PENDING/WAITING_TRANSCRIPT/GENERATING sem
   * lease vivo) cujo evento terminou há mais de 48 h → NO_TRANSCRIPT
   * (`expired`). Garante que nenhum estado fique sem saída quando o job deixa
   * de vê-los (conexão pausada, escopo do Teams retirado…). Devolve quantos.
   */
  expireStale(now: Date): Promise<number>;
  /**
   * Grava a ata numa transação: registro DONE (só o dono, GENERATING),
   * checkpoint com update condicional (GENERATE: DRAFT sem conteúdo → RECORDED;
   * SUPPLEMENT: como lido → notas/transcrição complementadas) e cards PENDING.
   */
  saveTranscriptMinutes(input: SaveTranscriptMinutesInput): Promise<SaveTranscriptResult>;
  /** Aviso in-app ao gestor (sem nome/e-mail/conteúdo). Best-effort. */
  notifyManager(input: { userId: string; checkpointId: string; kind: "ready" | "missing" }): Promise<void>;
}
