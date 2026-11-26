import { Prisma, prisma } from "@jumpflow/database";
import type { AppUser } from "@/lib/auth/types";
import { mapPersistedRoles } from "@/lib/db/users";
import { canTargetConsultant } from "@/lib/db/checkpoint";
import { draftRescheduleChange, isDisposableDraft } from "@/lib/m365/calendar/detection";
import type { NormalizedAttendee } from "@/lib/m365/calendar/normalize";
import type {
  CheckpointDraftInput,
  ConnectionWriteGuard,
  IntegrationLogInput,
  M365ConnectionRecord,
  M365ConnectionStatus,
  M365Store,
  SightedEvent,
  TimeSuggestionInput,
} from "@/lib/m365/store";

/**
 * Persistência Prisma da integração Microsoft 365 (M1).
 *
 * - Lease: `updateMany` condicional (livre OU vencido OU do mesmo dono) — claim
 *   atômico no banco, sem trava em memória.
 * - Idempotência: unique (iCalUId), (connectionId, graphEventId),
 *   (calendarEventId, consultantId) no Checkpoint e (consultantId,
 *   calendarEventId) na sugestão; P2002 = já existe.
 * - Nenhum log/IntegrationEvent leva token, assunto, nome ou e-mail.
 */

const CONNECTION_SELECT = {
  id: true,
  userId: true,
  status: true,
  accessTokenEncrypted: true,
  refreshTokenEncrypted: true,
  expiresAt: true,
  scopes: true,
  mailbox: true,
  graphUserId: true,
  calendarDeltaLink: true,
  calendarWindowStart: true,
  calendarWindowEnd: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function toAttendees(value: Prisma.JsonValue): NormalizedAttendee[] {
  if (!Array.isArray(value)) return [];
  const out: NormalizedAttendee[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.email !== "string") continue;
    out.push({
      email: row.email,
      name: typeof row.name === "string" ? row.name : null,
      type: typeof row.type === "string" ? row.type : "required",
      response: typeof row.response === "string" ? row.response : null,
    });
  }
  return out;
}

/**
 * `where` das escritas na conexão: com lease, só o dono ainda ACTIVE; sem lease,
 * nunca sobre DISCONNECTED/PAUSED. Desconectar limpa o lease e pausar muda o
 * status, então uma rodada em curso não ressuscita tokens nem desfaz a ação.
 */
export function guardedWhere(id: string, guard: ConnectionWriteGuard): Prisma.M365ConnectionWhereInput {
  return guard
    ? { id, syncLeaseOwner: guard.leaseOwner, status: "ACTIVE" }
    : { id, status: { notIn: ["DISCONNECTED", "PAUSED"] } };
}

export async function logM365Event(input: IntegrationLogInput): Promise<void> {
  try {
    await prisma.integrationEvent.create({
      data: {
        provider: "MICROSOFT_365",
        operation: input.operation,
        status: input.status,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requestMeta: input.meta ? (input.meta as Prisma.InputJsonValue) : Prisma.JsonNull,
        error: input.error ? input.error.slice(0, 300) : null,
        attemptedAt: new Date(),
        completedAt: new Date(),
      },
    });
  } catch (error) {
    // Log nunca derruba a operação; só o nome do erro (sem payload).
    console.error("[m365] integration event log failed", (error as Error)?.name);
  }
}

export const prismaM365Store: M365Store = {
  async getConnection(id) {
    const row = await prisma.m365Connection.findUnique({ where: { id }, select: CONNECTION_SELECT });
    return row as M365ConnectionRecord | null;
  },

  async saveTokens(id, tokens, guard) {
    const res = await prisma.m365Connection.updateMany({
      where: guardedWhere(id, guard),
      data: {
        accessTokenEncrypted: tokens.accessTokenEncrypted,
        refreshTokenEncrypted: tokens.refreshTokenEncrypted,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      },
    });
    return res.count === 1;
  },

  async setStatus(id, status, error, guard) {
    const res = await prisma.m365Connection.updateMany({
      where: guardedWhere(id, guard),
      data: {
        status,
        lastError: error,
        lastErrorAt: error ? new Date() : undefined,
      },
    });
    return res.count === 1;
  },

  async claimSyncLease(id, owner, until, now) {
    const claimed = await prisma.m365Connection.updateMany({
      where: {
        id,
        status: "ACTIVE",
        OR: [
          { syncLeaseUntil: null },
          { syncLeaseUntil: { lt: now } },
          { syncLeaseOwner: owner },
        ],
      },
      data: { syncLeaseUntil: until, syncLeaseOwner: owner, lastSyncStartedAt: now },
    });
    return claimed.count === 1;
  },

  async releaseSyncLease(id, owner) {
    await prisma.m365Connection.updateMany({
      where: { id, syncLeaseOwner: owner },
      data: { syncLeaseUntil: null, syncLeaseOwner: null },
    });
  },

  async renewSyncLease(id, owner, until) {
    const res = await prisma.m365Connection.updateMany({
      where: { id, syncLeaseOwner: owner, status: "ACTIVE" },
      data: { syncLeaseUntil: until },
    });
    return res.count === 1;
  },

  async findCalendarEventIdByICalUId(iCalUId) {
    const row = await prisma.calendarEvent.findUnique({ where: { iCalUId }, select: { id: true } });
    return row?.id ?? null;
  },

  async saveCalendarCursor(id, cursor, guard) {
    const res = await prisma.m365Connection.updateMany({
      where: guardedWhere(id, guard),
      data: cursor
        ? {
            calendarDeltaLink: cursor.deltaLink,
            calendarWindowStart: cursor.windowStart,
            calendarWindowEnd: cursor.windowEnd,
          }
        : { calendarDeltaLink: null, calendarWindowStart: null, calendarWindowEnd: null },
    });
    return res.count === 1;
  },

  async recordSyncOutcome(id, outcome, guard) {
    const res = await prisma.m365Connection.updateMany({
      where: guardedWhere(id, guard),
      data: outcome.error
        ? { lastError: outcome.error, lastErrorAt: outcome.at }
        : { lastSyncAt: outcome.at, lastError: null, lastErrorAt: null },
    });
    return res.count === 1;
  },

  async upsertCalendarEvent(connectionId, event, now, isOrganizerView) {
    const data = {
      subject: event.subject,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      organizerEmail: event.organizerEmail,
      organizerName: event.organizerName,
      attendees: event.attendees as unknown as Prisma.InputJsonValue,
      joinUrl: event.joinUrl,
    };
    // Cancelamento do EVENTO: só a visão do organizador o define (e o reverte).
    // Evento REDIGIDO pelo organizador (ficou privado): um participante não
    // reescreve assunto/participantes; só a visão do organizador (que voltou a
    // vê-lo normal) grava de novo e limpa `redactedAt`.
    const current = await prisma.calendarEvent.findUnique({
      where: { iCalUId: event.iCalUId },
      select: { id: true, isCancelled: true, redactedAt: true },
    });
    let row: { id: string; isCancelled: boolean };
    if (current?.redactedAt && !isOrganizerView) {
      row = { id: current.id, isCancelled: current.isCancelled };
    } else {
      row = await prisma.calendarEvent.upsert({
        where: { iCalUId: event.iCalUId },
        create: { iCalUId: event.iCalUId, ...data, isCancelled: isOrganizerView && event.isCancelled },
        update: isOrganizerView ? { ...data, isCancelled: event.isCancelled } : data,
        select: { id: true, isCancelled: true },
      });
      if (current?.redactedAt && isOrganizerView) {
        // O organizador voltou a ver o evento normal: deixa de ser redigido.
        await prisma.calendarEvent.update({ where: { id: row.id }, data: { redactedAt: null } });
      }
    }
    await prisma.calendarEventSighting.upsert({
      where: { connectionId_graphEventId: { connectionId, graphEventId: event.graphEventId } },
      create: {
        calendarEventId: row.id,
        connectionId,
        graphEventId: event.graphEventId,
        webLink: event.webLink,
        responseStatus: event.responseStatus,
        categories: event.categories,
        isCancelled: event.isCancelled,
        lastSeenAt: now,
      },
      update: {
        calendarEventId: row.id,
        webLink: event.webLink,
        responseStatus: event.responseStatus,
        categories: event.categories,
        isCancelled: event.isCancelled,
        lastSeenAt: now,
        removedAt: null,
      },
    });
    if (row.isCancelled) return { calendarEventId: row.id, cancelled: true };
    // Participante viu cancelado: o evento só cai se nenhuma caixa o tiver ativo.
    if (!isOrganizerView && event.isCancelled) {
      const cancelled = await prismaM365Store.cancelIfNoActiveSighting(row.id);
      return { calendarEventId: row.id, cancelled };
    }
    return { calendarEventId: row.id, cancelled: false };
  },

  async redactCalendarEvent(calendarEventId) {
    const linked = await prisma.checkpoint.count({ where: { calendarEventId } });
    if (linked === 0) {
      // Cascade: sightings e sugestões do evento somem junto.
      await prisma.calendarEvent.deleteMany({ where: { id: calendarEventId } });
      return "deleted";
    }
    await prisma.calendarEvent.update({
      where: { id: calendarEventId },
      data: {
        subject: null,
        attendees: [],
        organizerName: null,
        joinUrl: null,
        onlineMeetingId: null,
        redactedAt: new Date(),
      },
    });
    await prisma.calendarEventSighting.updateMany({
      where: { calendarEventId },
      data: { categories: [], webLink: null },
    });
    return "redacted";
  },

  async cancelIfNoActiveSighting(calendarEventId) {
    const active = await prisma.calendarEventSighting.count({
      where: { calendarEventId, removedAt: null, isCancelled: false },
    });
    if (active > 0) return false;
    await prisma.calendarEvent.update({ where: { id: calendarEventId }, data: { isCancelled: true } });
    return true;
  },

  async markSightingRemoved(connectionId, graphEventId, now) {
    const sighting = await prisma.calendarEventSighting.findUnique({
      where: { connectionId_graphEventId: { connectionId, graphEventId } },
      select: { id: true, calendarEventId: true, calendarEvent: { select: { organizerEmail: true } } },
    });
    if (!sighting) return null;
    await prisma.calendarEventSighting.update({
      where: { id: sighting.id },
      data: { removedAt: now },
    });
    return {
      calendarEventId: sighting.calendarEventId,
      organizerEmail: sighting.calendarEvent.organizerEmail,
    };
  },

  async cancelCalendarEvent(calendarEventId) {
    await prisma.calendarEvent.update({ where: { id: calendarEventId }, data: { isCancelled: true } });
  },

  async getUserContext(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        roles: { include: { role: true } },
        consultant: { select: { id: true, status: true } },
      },
    });
    if (!user || user.status !== "ACTIVE") return null;
    const appUser: AppUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      roles: mapPersistedRoles(user.roles),
    };
    return {
      user: appUser,
      consultantId: user.consultant && user.consultant.status === "ACTIVE" ? user.consultant.id : null,
    };
  },

  async consultantIdsByEmail(emails) {
    const normalized = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const map = new Map<string, string>();
    if (normalized.length === 0) return map;
    const rows = await prisma.consultant.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { email: { in: normalized, mode: "insensitive" } },
          { user: { email: { in: normalized, mode: "insensitive" } } },
        ],
      },
      select: { id: true, email: true, user: { select: { email: true } } },
    });
    for (const row of rows) {
      map.set(row.email.toLowerCase(), row.id);
      if (row.user?.email) map.set(row.user.email.toLowerCase(), row.id);
    }
    return map;
  },

  async targetableConsultants(user, consultantIds) {
    const allowed = new Set<string>();
    for (const id of consultantIds) {
      if (await canTargetConsultant(user, id)) allowed.add(id);
    }
    return allowed;
  },

  async ensureCheckpointDraft(input: CheckpointDraftInput) {
    const existing = await prisma.checkpoint.findUnique({
      where: {
        calendarEventId_consultantId: {
          calendarEventId: input.calendarEventId,
          consultantId: input.consultantId,
        },
      },
      select: {
        id: true,
        status: true,
        occurredAt: true,
        title: true,
        notes: true,
        transcription: true,
        audioStorageKey: true,
      },
    });
    if (existing) {
      const change = draftRescheduleChange(existing, input);
      if (!change) return "exists";
      // Condicional: só enquanto continua DRAFT (corrida com o gestor).
      const res = await prisma.checkpoint.updateMany({
        where: { id: existing.id, status: "DRAFT" },
        data: change,
      });
      if (res.count !== 1) return "exists";
      await prisma.auditEvent.create({
        data: {
          actorUserId: null,
          entityType: "Checkpoint",
          entityId: existing.id,
          action: "CHECKPOINT_DRAFT_SYNCED_FROM_CALENDAR",
          // Sem título/assunto no log (conteúdo): só datas e se o título mudou.
          before: { occurredAt: existing.occurredAt.toISOString() },
          after: {
            occurredAt: (change.occurredAt ?? existing.occurredAt).toISOString(),
            titleUpdated: "title" in change,
          },
        },
      });
      return "updated";
    }
    try {
      const created = await prisma.checkpoint.create({
        data: {
          consultantId: input.consultantId,
          managerUserId: input.managerUserId,
          calendarEventId: input.calendarEventId,
          type: input.type,
          occurredAt: input.occurredAt,
          title: input.title,
          status: "DRAFT",
          visibility: "PRIVATE",
        },
        select: { id: true },
      });
      await prisma.auditEvent.create({
        data: {
          actorUserId: null,
          entityType: "Checkpoint",
          entityId: created.id,
          action: "CHECKPOINT_DRAFTED_FROM_CALENDAR",
          before: Prisma.JsonNull,
          after: {
            consultantId: input.consultantId,
            managerUserId: input.managerUserId,
            calendarEventId: input.calendarEventId,
            type: input.type,
            status: "DRAFT",
            visibility: "PRIVATE",
          },
        },
      });
      return "created";
    } catch (error) {
      if (isUniqueViolation(error)) return "exists";
      throw error;
    }
  },

  async archiveDisposableDrafts(calendarEventId) {
    const drafts = await prisma.checkpoint.findMany({
      where: { calendarEventId, status: "DRAFT" },
      select: { id: true, status: true, notes: true, transcription: true, audioStorageKey: true },
    });
    let archived = 0;
    for (const draft of drafts.filter(isDisposableDraft)) {
      // Condicional (concorrência otimista): só arquiva se o rascunho continua
      // EXATAMENTE como a regra pura avaliou (DRAFT, mesmas notas/transcrição —
      // nulas ou só espaços — e sem áudio). Regra pura e banco não divergem.
      const res = await prisma.checkpoint.updateMany({
        where: {
          id: draft.id,
          status: "DRAFT",
          notes: draft.notes,
          transcription: draft.transcription,
          audioStorageKey: null,
        },
        data: { status: "ARCHIVED" },
      });
      if (res.count === 1) {
        archived += 1;
        await prisma.auditEvent.create({
          data: {
            actorUserId: null,
            entityType: "Checkpoint",
            entityId: draft.id,
            action: "CHECKPOINT_DRAFT_ARCHIVED_EVENT_CANCELLED",
            before: { status: "DRAFT" },
            after: { status: "ARCHIVED", calendarEventId },
          },
        });
      }
    }
    return archived;
  },

  async listRecentSightedEvents(connectionId, from, to) {
    const rows = await prisma.calendarEventSighting.findMany({
      where: {
        connectionId,
        removedAt: null,
        isCancelled: false,
        calendarEvent: { isCancelled: false, endAt: { gte: from, lte: to } },
      },
      select: {
        responseStatus: true,
        calendarEvent: {
          select: {
            id: true,
            startAt: true,
            endAt: true,
            isAllDay: true,
            isCancelled: true,
            organizerEmail: true,
            attendees: true,
          },
        },
      },
      take: 500,
    });
    return rows.map(
      (row): SightedEvent => ({
        calendarEventId: row.calendarEvent.id,
        startAt: row.calendarEvent.startAt,
        endAt: row.calendarEvent.endAt,
        isAllDay: row.calendarEvent.isAllDay,
        isCancelled: row.calendarEvent.isCancelled,
        organizerEmail: row.calendarEvent.organizerEmail,
        attendees: toAttendees(row.calendarEvent.attendees),
        responseStatus: row.responseStatus,
      }),
    );
  },

  async listSuggestionAllocations(consultantId, date) {
    const rows = await prisma.allocation.findMany({
      where: {
        consultantId,
        status: "ACTIVE",
        startDate: { lte: date },
        OR: [{ endDate: null }, { endDate: { gte: date } }],
        project: { status: { not: "CLOSED" } },
      },
      select: {
        projectId: true,
        project: { select: { client: { select: { contactEmail: true, billingEmails: true } } } },
      },
    });
    return rows.map((row) => ({
      projectId: row.projectId,
      clientEmails: [
        ...(row.project.client.contactEmail ? [row.project.client.contactEmail] : []),
        ...row.project.client.billingEmails,
      ],
    }));
  },

  async upsertTimeSuggestion(input: TimeSuggestionInput) {
    const key = {
      consultantId_calendarEventId: {
        consultantId: input.consultantId,
        calendarEventId: input.calendarEventId,
      },
    };
    const existing = await prisma.m365TimeSuggestion.findUnique({
      where: key,
      select: { status: true, projectIds: true, minutes: true, date: true },
    });
    const data = {
      date: input.date,
      startAt: input.startAt,
      endAt: input.endAt,
      minutes: input.minutes,
      projectIds: input.projectIds,
      matchKind: input.matchKind,
    };
    if (!existing) {
      try {
        await prisma.m365TimeSuggestion.create({
          data: { consultantId: input.consultantId, calendarEventId: input.calendarEventId, ...data },
        });
        return "created";
      } catch (error) {
        if (isUniqueViolation(error)) return "unchanged";
        throw error;
      }
    }
    // Decisão do consultor (DISMISSED) é preservada.
    if (existing.status !== "PENDING") return "unchanged";
    if (
      existing.minutes === input.minutes &&
      existing.date.getTime() === input.date.getTime() &&
      sameStringSet(existing.projectIds, input.projectIds)
    ) {
      return "unchanged";
    }
    await prisma.m365TimeSuggestion.update({ where: key, data });
    return "updated";
  },

  async deletePendingSuggestions(calendarEventId) {
    const res = await prisma.m365TimeSuggestion.deleteMany({
      where: { calendarEventId, status: "PENDING" },
    });
    return res.count;
  },

  logIntegrationEvent: logM365Event,
};

// ── Leituras/escritas para a UI (sempre escopadas ao próprio usuário) ────────

export interface M365ConnectionView {
  status: M365ConnectionStatus;
  scopes: string[];
  mailbox: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  syncing: boolean;
}

export async function getM365ConnectionView(userId: string): Promise<M365ConnectionView | null> {
  const row = await prisma.m365Connection.findUnique({
    where: { userId },
    select: {
      status: true,
      scopes: true,
      mailbox: true,
      connectedAt: true,
      lastSyncAt: true,
      lastError: true,
      lastErrorAt: true,
      syncLeaseUntil: true,
    },
  });
  if (!row) return null;
  return {
    status: row.status,
    scopes: row.scopes,
    mailbox: row.mailbox,
    connectedAt: row.connectedAt.toISOString(),
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    syncing: Boolean(row.syncLeaseUntil && row.syncLeaseUntil > new Date()),
  };
}

/**
 * Escopos já consentidos (para o consentimento INCREMENTAL somar a capacidade
 * nova às existentes). Desconectado = nada (reconectar começa do zero).
 */
export async function getM365GrantedScopes(userId: string): Promise<string[]> {
  const row = await prisma.m365Connection.findUnique({ where: { userId }, select: { status: true, scopes: true } });
  if (!row || row.status === "DISCONNECTED") return [];
  return row.scopes;
}

export async function findConnectionIdForUser(userId: string): Promise<string | null> {
  const row = await prisma.m365Connection.findUnique({ where: { userId }, select: { id: true } });
  return row?.id ?? null;
}

/** Conecta/reconecta: grava tokens cifrados e zera estado de erro. */
export async function upsertM365Connection(input: {
  userId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  expiresAt: Date;
  scopes: string[];
  tenantId: string;
  graphUserId: string;
  mailbox: string;
}): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.m365Connection.findUnique({
    where: { userId: input.userId },
    select: { id: true, graphUserId: true },
  });
  const data = {
    status: "ACTIVE" as const,
    accessTokenEncrypted: input.accessTokenEncrypted,
    refreshTokenEncrypted: input.refreshTokenEncrypted,
    expiresAt: input.expiresAt,
    scopes: input.scopes,
    tenantId: input.tenantId,
    graphUserId: input.graphUserId,
    mailbox: input.mailbox,
    lastError: null,
    lastErrorAt: null,
    connectedAt: new Date(),
  };
  if (!existing) {
    const row = await prisma.m365Connection.create({
      data: { userId: input.userId, ...data },
      select: { id: true },
    });
    return { id: row.id, created: true };
  }
  // Outra conta Microsoft (graphUserId diferente) = cursor antigo não vale mais.
  const resetCursor =
    existing.graphUserId && existing.graphUserId !== input.graphUserId
      ? { calendarDeltaLink: null, calendarWindowStart: null, calendarWindowEnd: null }
      : {};
  await prisma.m365Connection.update({
    where: { id: existing.id },
    data: { ...data, ...resetCursor },
  });
  return { id: existing.id, created: false };
}

/** Pausar/retomar (só a própria conexão; não mexe em tokens). */
export async function setOwnConnectionPaused(userId: string, paused: boolean): Promise<boolean> {
  const res = await prisma.m365Connection.updateMany({
    where: paused ? { userId, status: "ACTIVE" } : { userId, status: "PAUSED" },
    data: { status: paused ? "PAUSED" : "ACTIVE" },
  });
  return res.count === 1;
}

/**
 * Desconectar: APAGA os tokens e o cursor (DISCONNECTED). Os dados já gerados
 * (eventos, rascunhos, sugestões) ficam como registro da empresa (informado no
 * consentimento).
 */
export async function disconnectOwnConnection(userId: string): Promise<string | null> {
  const row = await prisma.m365Connection.findUnique({ where: { userId }, select: { id: true } });
  if (!row) return null;
  await prisma.m365Connection.update({
    where: { id: row.id },
    data: {
      status: "DISCONNECTED",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
      calendarDeltaLink: null,
      calendarWindowStart: null,
      calendarWindowEnd: null,
      syncLeaseUntil: null,
      syncLeaseOwner: null,
    },
  });
  return row.id;
}

/** Conexões ACTIVE a sincronizar, as mais antigas primeiro. */
export async function listDueConnectionIds(limit: number): Promise<string[]> {
  const rows = await prisma.m365Connection.findMany({
    where: { status: "ACTIVE" },
    orderBy: [{ lastSyncAt: { sort: "asc", nulls: "first" } }],
    select: { id: true },
    take: limit,
  });
  return rows.map((r) => r.id);
}

export interface M365AdminOverview {
  activeUsers: number;
  byStatus: Record<M365ConnectionStatus, number>;
  connected: number;
  recentFailures: number;
}

/** Visão admin agregada — só contagens, nunca tokens/conteúdo/identidades. */
export async function getM365AdminOverview(): Promise<M365AdminOverview> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [activeUsers, grouped, recentFailures] = await Promise.all([
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.m365Connection.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.integrationEvent.count({
      where: { provider: "MICROSOFT_365", status: "FAILED", createdAt: { gte: since } },
    }),
  ]);
  const byStatus: Record<M365ConnectionStatus, number> = {
    ACTIVE: 0,
    PAUSED: 0,
    REAUTH_REQUIRED: 0,
    ERROR: 0,
    DISCONNECTED: 0,
  };
  for (const g of grouped) byStatus[g.status] = g._count._all;
  return {
    activeUsers,
    byStatus,
    connected: byStatus.ACTIVE + byStatus.PAUSED,
    recentFailures,
  };
}

// ── Sugestões de horas (tela de Horas) ───────────────────────────────────────

export interface TimeSuggestionView {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  minutes: number;
  subject: string | null;
  matchKind: "EMAIL" | "DOMAIN";
  projects: Array<{ id: string; name: string; clientName: string }>;
}

/**
 * Sugestões PENDENTES do consultor no intervalo, já sem as que viraram
 * lançamento (existe TimeEntry no mesmo dia em algum dos projetos sugeridos) e
 * sem projetos que não estão mais na lista permitida (`allowedProjectIds`).
 */
export async function listPendingTimeSuggestions(
  consultantId: string,
  from: Date,
  to: Date,
  allowedProjectIds: ReadonlySet<string>,
): Promise<TimeSuggestionView[]> {
  const rows = await prisma.m365TimeSuggestion.findMany({
    where: { consultantId, status: "PENDING", date: { gte: from, lte: to } },
    orderBy: [{ startAt: "asc" }],
    select: {
      id: true,
      date: true,
      startAt: true,
      endAt: true,
      minutes: true,
      projectIds: true,
      matchKind: true,
      calendarEvent: { select: { subject: true, isCancelled: true } },
    },
    take: 50,
  });
  const live = rows.filter((r) => !r.calendarEvent.isCancelled);
  if (live.length === 0) return [];
  const projectIds = [...new Set(live.flatMap((r) => r.projectIds))].filter((id) => allowedProjectIds.has(id));
  const [projects, entries] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, name: true, client: { select: { name: true } } },
    }),
    prisma.timeEntry.findMany({
      where: { consultantId, projectId: { in: projectIds }, date: { gte: from, lte: to } },
      select: { projectId: true, date: true },
    }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const logged = new Set(entries.map((e) => `${e.projectId}|${e.date.toISOString().slice(0, 10)}`));
  const out: TimeSuggestionView[] = [];
  for (const row of live) {
    const day = row.date.toISOString().slice(0, 10);
    const options = row.projectIds
      .map((id) => projectById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    if (options.length === 0) continue;
    if (options.some((p) => logged.has(`${p.id}|${day}`))) continue;
    out.push({
      id: row.id,
      date: day,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      minutes: row.minutes,
      subject: row.calendarEvent.subject,
      matchKind: row.matchKind === "EMAIL" ? "EMAIL" : "DOMAIN",
      projects: options.map((p) => ({ id: p.id, name: p.name, clientName: p.client.name })),
    });
  }
  return out;
}

/** Uma sugestão PENDENTE do próprio consultor (para pré-preencher o formulário). */
export async function getOwnPendingSuggestion(consultantId: string, id: string) {
  return prisma.m365TimeSuggestion.findFirst({
    where: { id, consultantId, status: "PENDING", calendarEvent: { isCancelled: false } },
    select: {
      id: true,
      date: true,
      startAt: true,
      endAt: true,
      projectIds: true,
      calendarEvent: { select: { subject: true } },
    },
  });
}

export async function dismissOwnSuggestion(consultantId: string, id: string): Promise<boolean> {
  const res = await prisma.m365TimeSuggestion.updateMany({
    where: { id, consultantId, status: "PENDING" },
    data: { status: "DISMISSED", decidedAt: new Date() },
  });
  return res.count === 1;
}
