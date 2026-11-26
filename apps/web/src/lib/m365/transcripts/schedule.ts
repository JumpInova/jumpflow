/**
 * Transcrição do Teams (M365 M3) — máquina de estados e agenda de tentativas.
 * PURO (sem Prisma, sem rede, sem relógio implícito).
 *
 *   PENDING ──► WAITING_TRANSCRIPT ──► GENERATING ──► DONE
 *      │              │    ▲               │
 *      │              │    └── (erro) ─────┤
 *      └──────────────┴──► NO_TRANSCRIPT   └──► FAILED
 *                     └──► FAILED
 *
 * - 1ª consulta 10 min após o fim; sem transcrição, nova consulta em
 *   15 → 30 → 60 → 120 min (120 se repete) até 6 h após o fim. Passou de 6 h
 *   sem transcrição → NO_TRANSCRIPT (o gestor é avisado: colar notas ou
 *   aguardar a ata por e-mail).
 * - 403 → acesso negado: nenhuma nova consulta por 24 h; se a próxima cair
 *   depois do teto de 48 h após o fim → FAILED (`access_denied`).
 * - Erro transitório (5xx/404 de conteúdo…) segue o mesmo backoff, mas até 48 h.
 * - Transcrição acima do teto de bytes → FAILED (`transcript_too_large`).
 * - DONE / NO_TRANSCRIPT / FAILED são finais para o JOB; o gestor ainda pode
 *   acionar manualmente (até 48 h após o fim).
 */

export type TranscriptStatus =
  | "PENDING"
  | "WAITING_TRANSCRIPT"
  | "GENERATING"
  | "DONE"
  | "NO_TRANSCRIPT"
  | "FAILED";

export type TranscriptMode = "GENERATE" | "SUPPLEMENT";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Folga após o fim antes da 1ª consulta. */
export const TRANSCRIPT_GRACE_MS = 10 * MIN;
/** Espera entre consultas sem transcrição (o último valor se repete). */
export const TRANSCRIPT_BACKOFF_MS = [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN] as const;
/** Sem transcrição até aqui (após o fim) → NO_TRANSCRIPT. */
export const TRANSCRIPT_WAIT_LIMIT_MS = 6 * HOUR;
/** Teto absoluto (após o fim): nada (job ou manual) consulta depois disso. */
export const TRANSCRIPT_HARD_LIMIT_MS = 48 * HOUR;
/** 403: nenhuma nova consulta por este tempo. */
export const TRANSCRIPT_ACCESS_DENIED_RETRY_MS = 24 * HOUR;
/** Lease de uma tentativa (claim no banco). */
export const TRANSCRIPT_LEASE_MS = 5 * MIN;
/**
 * Precedência sobre o e-mail: enquanto a transcrição do Teams ainda pode
 * chegar (reunião Teams organizada pelo gestor com Teams ativo), o job de atas
 * por e-mail espera até este tempo após o fim. Depois disso, o e-mail segue
 * (e a transcrição só complementa por ação do gestor).
 */
export const TEAMS_EMAIL_HOLD_MS = 60 * MIN;

export const FINAL_STATUSES: readonly TranscriptStatus[] = ["DONE", "NO_TRANSCRIPT", "FAILED"];

const TRANSITIONS: Record<TranscriptStatus, readonly TranscriptStatus[]> = {
  PENDING: ["WAITING_TRANSCRIPT", "GENERATING", "NO_TRANSCRIPT", "FAILED"],
  WAITING_TRANSCRIPT: ["WAITING_TRANSCRIPT", "GENERATING", "NO_TRANSCRIPT", "FAILED"],
  // GENERATING interrompido volta a WAITING (releaseClaim); fora de 48 h a
  // varredura leva a NO_TRANSCRIPT.
  GENERATING: ["DONE", "FAILED", "WAITING_TRANSCRIPT", "NO_TRANSCRIPT"],
  DONE: [],
  NO_TRANSCRIPT: [],
  FAILED: [],
};

/** Transição permitida pela máquina (job). Reabertura manual é à parte. */
export function canTransition(from: TranscriptStatus, to: TranscriptStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinalStatus(status: TranscriptStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

/** Estados que o gestor pode reabrir manualmente (dentro de 48 h). */
export function canReopenManually(status: TranscriptStatus | null): boolean {
  return status === null || status !== "DONE";
}

/**
 * Bloqueio pós-403: 24 h a partir do instante do 403, para o job E para o
 * botão, qualquer que seja o status (WAITING ou FAILED). PURA.
 */
export function accessBlocked(accessDeniedAt: Date | null | undefined, now: Date): boolean {
  return Boolean(accessDeniedAt) && now.getTime() < accessDeniedAt!.getTime() + TRANSCRIPT_ACCESS_DENIED_RETRY_MS;
}

export function firstAttemptAt(endAt: Date): Date {
  return new Date(endAt.getTime() + TRANSCRIPT_GRACE_MS);
}

export function backoffDelay(misses: number): number {
  const index = Math.min(Math.max(misses, 1), TRANSCRIPT_BACKOFF_MS.length) - 1;
  return TRANSCRIPT_BACKOFF_MS[index];
}

export function withinHardLimit(endAt: Date, now: Date): boolean {
  return now.getTime() - endAt.getTime() <= TRANSCRIPT_HARD_LIMIT_MS;
}

/** Resultado de uma consulta que NÃO gerou ata. */
export type AttemptMiss =
  | { kind: "no_meeting" }
  | { kind: "no_transcript" }
  | { kind: "empty_transcript" }
  | { kind: "forbidden" }
  | { kind: "too_large" }
  | { kind: "not_organizer" }
  | { kind: "superseded" }
  | { kind: "transient"; code: string };

export interface AttemptPlan {
  status: Extract<TranscriptStatus, "WAITING_TRANSCRIPT" | "NO_TRANSCRIPT" | "FAILED">;
  nextAttemptAt: Date | null;
  error: string | null;
  /** 403: instante do bloqueio (24 h a partir dele, qualquer status). */
  accessDeniedAt?: Date;
  /** Avisar o gestor (só ao entrar num estado final sem ata). */
  notify: boolean;
}

/**
 * Próximo passo após uma consulta sem ata. `misses` = consultas sem sucesso
 * INCLUINDO esta (≥ 1). PURA.
 */
export function planAfterMiss(miss: AttemptMiss, ctx: { endAt: Date; now: Date; misses: number }): AttemptPlan {
  const end = ctx.endAt.getTime();
  const now = ctx.now.getTime();
  const hard = end + TRANSCRIPT_HARD_LIMIT_MS;
  if (miss.kind === "too_large") {
    return { status: "FAILED", nextAttemptAt: null, error: "transcript_too_large", notify: true };
  }
  // A reunião do link não é do gestor conectado: nunca será (sem aviso).
  if (miss.kind === "not_organizer") {
    return { status: "FAILED", nextAttemptAt: null, error: "not_organizer", notify: false };
  }
  // O checkpoint ganhou ata (e-mail) ou notas antes: o job para; o gestor
  // ainda pode complementar com a transcrição por ação própria.
  if (miss.kind === "superseded") {
    return { status: "FAILED", nextAttemptAt: null, error: "superseded", notify: false };
  }
  if (miss.kind === "forbidden") {
    const next = now + TRANSCRIPT_ACCESS_DENIED_RETRY_MS;
    const accessDeniedAt = new Date(now);
    if (next > hard) return { status: "FAILED", nextAttemptAt: null, error: "access_denied", notify: true, accessDeniedAt };
    return { status: "WAITING_TRANSCRIPT", nextAttemptAt: new Date(next), error: "access_denied", notify: false, accessDeniedAt };
  }
  if (miss.kind === "transient") {
    const next = now + backoffDelay(ctx.misses);
    if (next > hard) return { status: "FAILED", nextAttemptAt: null, error: miss.code.slice(0, 80), notify: true };
    return { status: "WAITING_TRANSCRIPT", nextAttemptAt: new Date(next), error: miss.code.slice(0, 80), notify: false };
  }
  const error = miss.kind === "no_meeting" ? "meeting_not_found" : miss.kind === "empty_transcript" ? "empty_transcript" : null;
  const limit = end + TRANSCRIPT_WAIT_LIMIT_MS;
  if (now >= limit) return { status: "NO_TRANSCRIPT", nextAttemptAt: null, error, notify: true };
  // A última consulta cai exatamente no limite de 6 h.
  const next = Math.min(now + backoffDelay(ctx.misses), limit);
  return { status: "WAITING_TRANSCRIPT", nextAttemptAt: new Date(next), error, notify: false };
}

// ── Elegibilidade ────────────────────────────────────────────────────────────

export interface TranscriptEligibilityInput {
  checkpointStatus: "DRAFT" | "RECORDED" | "EXTRACTED" | "ARCHIVED";
  notes: string | null;
  transcription: string | null;
  audioStorageKey: string | null;
  eventJoinUrl: string | null;
  eventOrganizerEmail: string | null;
  eventEndAt: Date;
  eventCancelled: boolean;
}

export function hasContent(cp: Pick<TranscriptEligibilityInput, "notes" | "transcription" | "audioStorageKey">): boolean {
  return Boolean((cp.notes && cp.notes.trim()) || (cp.transcription && cp.transcription.trim()) || cp.audioStorageKey);
}

/** Reunião Teams ORGANIZADA pela caixa do gestor conectado? */
export function isOrganizedBy(cp: Pick<TranscriptEligibilityInput, "eventOrganizerEmail">, managerEmails: string[]): boolean {
  const organizer = (cp.eventOrganizerEmail ?? "").trim().toLowerCase();
  return organizer.length > 0 && managerEmails.some((e) => e.trim().toLowerCase() === organizer);
}

export type EligibilityReason =
  | "ok"
  | "not_teams"
  | "cancelled"
  | "too_early"
  | "too_late"
  | "not_organizer"
  | "archived";

/**
 * Pode CONSULTAR a transcrição agora (vale para job e manual)? O modo (gerar ×
 * complementar) é decidido à parte por {@link transcriptMode}. PURA.
 */
export function transcriptEligibility(
  cp: TranscriptEligibilityInput,
  managerEmails: string[],
  now: Date,
): EligibilityReason {
  if (cp.checkpointStatus === "ARCHIVED") return "archived";
  if (!cp.eventJoinUrl) return "not_teams";
  if (cp.eventCancelled) return "cancelled";
  if (now.getTime() < cp.eventEndAt.getTime() + TRANSCRIPT_GRACE_MS) return "too_early";
  if (!withinHardLimit(cp.eventEndAt, now)) return "too_late";
  if (!isOrganizedBy(cp, managerEmails)) return "not_organizer";
  return "ok";
}

/**
 * GENERATE: rascunho DRAFT sem conteúdo — a transcrição gera a ata (vence o
 * e-mail que ainda não chegou). SUPPLEMENT: já há ata/notas (e-mail ou gestor)
 * — a transcrição só COMPLEMENTA, e só por ação do gestor. PURA.
 */
export function transcriptMode(cp: Pick<TranscriptEligibilityInput, "checkpointStatus" | "notes" | "transcription" | "audioStorageKey">): TranscriptMode {
  return cp.checkpointStatus === "DRAFT" && !hasContent(cp) ? "GENERATE" : "SUPPLEMENT";
}

/**
 * O job de atas por E-MAIL deve esperar a transcrição do Teams? Sim se ela já
 * gerou (DONE) ou está sendo gerada AGORA (GENERATING com lease vivo, dentro de
 * 48 h), e — para
 * reunião Teams organizada pelo gestor com Teams ativo — enquanto ainda não há
 * resultado final e não passou {@link TEAMS_EMAIL_HOLD_MS} do fim. PURA.
 */
export function emailShouldWaitForTeams(input: {
  teamsStatus: TranscriptStatus | null;
  /** Lease do registro (GENERATING só segura o e-mail com lease VIVO). */
  teamsLeaseUntil?: Date | null;
  teamsEnabled: boolean;
  organizedByManager: boolean;
  eventJoinUrl: string | null;
  eventEndAt: Date;
  now: Date;
}): boolean {
  if (input.teamsStatus === "DONE") return true;
  if (!withinHardLimit(input.eventEndAt, input.now)) return false;
  if (input.teamsStatus === "GENERATING") {
    // Sem lease vivo = rodada que caiu: não bloqueia o e-mail.
    return Boolean(input.teamsLeaseUntil && input.teamsLeaseUntil.getTime() > input.now.getTime());
  }
  if (input.teamsStatus === "NO_TRANSCRIPT" || input.teamsStatus === "FAILED") return false;
  if (!input.teamsEnabled || !input.organizedByManager || !input.eventJoinUrl) return false;
  return input.now.getTime() < input.eventEndAt.getTime() + TEAMS_EMAIL_HOLD_MS;
}
