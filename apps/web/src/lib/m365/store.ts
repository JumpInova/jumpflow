import type { AppUser } from "@/lib/auth/types";
import type { NormalizedEvent, NormalizedAttendee } from "./calendar/normalize";
import type { SuggestionAllocation } from "./calendar/time-suggestions";

/**
 * Porta de persistência da integração Microsoft 365. A implementação real é
 * Prisma (`lib/db/m365.ts`); os testes usam uma implementação em memória. Toda
 * concorrência é resolvida NO BANCO (lease por updateMany condicional e unique
 * constraints) — nada de trava em memória no código de produção.
 */

export type M365ConnectionStatus =
  | "ACTIVE"
  | "PAUSED"
  | "REAUTH_REQUIRED"
  | "ERROR"
  | "DISCONNECTED";

export interface M365ConnectionRecord {
  id: string;
  userId: string;
  status: M365ConnectionStatus;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  expiresAt: Date | null;
  scopes: string[];
  mailbox: string | null;
  calendarDeltaLink: string | null;
  calendarWindowStart: Date | null;
  calendarWindowEnd: Date | null;
}

export interface CalendarCursor {
  deltaLink: string;
  windowStart: Date;
  windowEnd: Date;
}

export interface UserContext {
  user: AppUser;
  consultantId: string | null;
}

export interface SightedEvent {
  calendarEventId: string;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  isCancelled: boolean;
  organizerEmail: string | null;
  attendees: NormalizedAttendee[];
  responseStatus: string | null;
}

export interface CheckpointDraftInput {
  calendarEventId: string;
  consultantId: string;
  managerUserId: string;
  type: "ONE_ON_ONE" | "CHECKPOINT";
  occurredAt: Date;
  title: string | null;
}

export interface TimeSuggestionInput {
  consultantId: string;
  calendarEventId: string;
  date: Date;
  startAt: Date;
  endAt: Date;
  minutes: number;
  projectIds: string[];
  matchKind: "EMAIL" | "DOMAIN";
}

export interface IntegrationLogInput {
  operation: string;
  status: "SUCCESS" | "FAILED" | "RETRYING";
  /** Sempre "M365Connection" ou outra entidade técnica; nunca conteúdo. */
  entityType?: string;
  entityId?: string;
  /** Contadores/códigos apenas — sem nomes, e-mails, assuntos ou tokens. */
  meta?: Record<string, string | number | boolean | null>;
  error?: string | null;
}

/**
 * Guarda de escrita na conexão. Com `leaseOwner`, a escrita só acontece se esta
 * rodada AINDA é dona do lease e a conexão segue ACTIVE (desconectar limpa o
 * lease; pausar muda o status). Sem lease (`null`), exige status fora de
 * DISCONNECTED/PAUSED. Escrita recusada → `false`: quem chama encerra a rodada
 * sem gravar mais nada (nunca ressuscita tokens nem troca DISCONNECTED).
 */
export type ConnectionWriteGuard = { leaseOwner: string } | null;

/** A conexão mudou (desconectada/pausada/lease perdido) no meio da rodada. */
export class ConnectionChangedError extends Error {
  constructor() {
    super("Conexão alterada durante a rodada.");
    this.name = "ConnectionChangedError";
  }
}

export interface M365Store {
  getConnection(id: string): Promise<M365ConnectionRecord | null>;
  saveTokens(
    id: string,
    tokens: {
      accessTokenEncrypted: string;
      refreshTokenEncrypted: string;
      expiresAt: Date;
      scopes: string[];
    },
    guard: ConnectionWriteGuard,
  ): Promise<boolean>;
  setStatus(
    id: string,
    status: M365ConnectionStatus,
    error: string | null,
    guard: ConnectionWriteGuard,
  ): Promise<boolean>;

  /** Claim atômico do lease de sync (true = esta rodada é dona). */
  claimSyncLease(id: string, owner: string, until: Date, now: Date): Promise<boolean>;
  releaseSyncLease(id: string, owner: string): Promise<void>;
  /**
   * Heartbeat do lease: estende `syncLeaseUntil` SÓ se esta rodada ainda é dona
   * e a conexão segue ACTIVE. `false` = lease perdido (outra instância assumiu,
   * desconectada ou pausada): a rodada para ANTES da próxima fase de efeitos.
   */
  renewSyncLease(id: string, owner: string, until: Date): Promise<boolean>;
  saveCalendarCursor(id: string, cursor: CalendarCursor | null, guard: ConnectionWriteGuard): Promise<boolean>;
  recordSyncOutcome(
    id: string,
    outcome: { at: Date; error: string | null },
    guard: ConnectionWriteGuard,
  ): Promise<boolean>;

  /**
   * Upsert do CalendarEvent (por iCalUId) + sighting desta conexão. `categories`
   * e `isCancelled` da caixa ficam no sighting. O cancelamento do EVENTO segue a
   * visão do organizador (`isOrganizerView`); a visão de um participante só
   * cancela o evento quando nenhum sighting ativo (não removido, não cancelado)
   * resta. Devolve se o evento ficou cancelado.
   */
  upsertCalendarEvent(
    connectionId: string,
    event: NormalizedEvent,
    now: Date,
    isOrganizerView: boolean,
  ): Promise<{ calendarEventId: string; cancelled: boolean }>;
  /** Marca o sighting como removido; devolve o evento (se conhecido). */
  markSightingRemoved(
    connectionId: string,
    graphEventId: string,
    now: Date,
  ): Promise<{ calendarEventId: string; organizerEmail: string | null } | null>;
  cancelCalendarEvent(calendarEventId: string): Promise<void>;
  /**
   * O ORGANIZADOR marcou o evento como privado/confidencial: sem Checkpoint
   * vinculado o evento é apagado; com vínculo, assunto/participantes/link são
   * limpos (o rascunho do gestor continua) e o evento fica marcado como
   * redigido (`redactedAt`): a partir daí só a visão do ORGANIZADOR volta a
   * gravar assunto/participantes (um participante não reescreve o redigido).
   */
  redactCalendarEvent(calendarEventId: string): Promise<"deleted" | "redacted">;
  /** Id do CalendarEvent por iCalUId (null se ainda não existe). */
  findCalendarEventIdByICalUId(iCalUId: string): Promise<string | null>;
  /** Cancela o evento se nenhum sighting ativo restar; devolve se cancelou. */
  cancelIfNoActiveSighting(calendarEventId: string): Promise<boolean>;

  getUserContext(userId: string): Promise<UserContext | null>;
  /** e-mail (minúsculo) → Consultant.id, para consultores ATIVOS. */
  consultantIdsByEmail(emails: string[]): Promise<Map<string, string>>;
  /** Subconjunto de `consultantIds` que o gestor pode registrar (canTargetConsultant). */
  targetableConsultants(user: AppUser, consultantIds: string[]): Promise<Set<string>>;
  /**
   * Idempotente: um rascunho por (evento, consultor). Se o rascunho já existe e
   * ainda é DRAFT, acompanha a remarcação: `occurredAt` sempre; `title` só
   * enquanto o rascunho não tem conteúdo (notas/transcrição/áudio).
   */
  ensureCheckpointDraft(input: CheckpointDraftInput): Promise<"created" | "exists" | "updated">;
  /** Arquiva rascunhos DRAFT sem conteúdo do evento cancelado. */
  archiveDisposableDrafts(calendarEventId: string): Promise<number>;

  listRecentSightedEvents(connectionId: string, from: Date, to: Date): Promise<SightedEvent[]>;
  listSuggestionAllocations(consultantId: string, date: Date): Promise<SuggestionAllocation[]>;
  upsertTimeSuggestion(input: TimeSuggestionInput): Promise<"created" | "updated" | "unchanged">;
  deletePendingSuggestions(calendarEventId: string): Promise<number>;

  logIntegrationEvent(input: IntegrationLogInput): Promise<void>;
}
