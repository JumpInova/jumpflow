import { Prisma, prisma } from "@jumpflow/database";
import { filterNewActionItems } from "@/lib/checkpoint/action-items";
import { CAPABILITY_SCOPES } from "@/lib/m365/scopes";
import {
  TRANSCRIPT_GRACE_MS,
  TRANSCRIPT_HARD_LIMIT_MS,
} from "@/lib/m365/transcripts/schedule";
import type {
  SaveTranscriptMinutesInput,
  SaveTranscriptResult,
  TranscriptCheckpoint,
  TranscriptStore,
} from "@/lib/m365/transcripts/store";

/**
 * Persistência Prisma da transcrição do Teams (M365 M3).
 *
 * - Enrolamento idempotente (unique `checkpointId`; P2002 = já existe).
 * - Claim ATÔMICO por `updateMany` condicional (lease livre/vencido + estado e
 *   próxima tentativa) — nada de trava em memória; várias instâncias seguras.
 * - Toda gravação de resultado exige o dono do claim.
 * - `saveTranscriptMinutes` numa transação: registro DONE (dono + GENERATING)
 *   + update condicional do checkpoint + cards PENDING + auditoria só com
 *   contagens. Nada de nome/fala/VTT é gravado fora de notes/transcription.
 */

const TEAMS_SCOPES = [...CAPABILITY_SCOPES.TEAMS];

const SELECT = {
  id: true,
  managerUserId: true,
  consultantId: true,
  type: true,
  status: true,
  notes: true,
  transcription: true,
  audioStorageKey: true,
  occurredAt: true,
  calendarEvent: {
    select: { joinUrl: true, organizerEmail: true, startAt: true, endAt: true, isCancelled: true },
  },
  emailMinutes: { select: { status: true } },
  teamsTranscript: {
    select: {
      status: true,
      mode: true,
      attempts: true,
      nextAttemptAt: true,
      lastError: true,
      accessDeniedAt: true,
      leaseOwner: true,
      leaseUntil: true,
    },
  },
} satisfies Prisma.CheckpointSelect;

type Row = Prisma.CheckpointGetPayload<{ select: typeof SELECT }>;

function toCheckpoint(row: Row): TranscriptCheckpoint | null {
  if (!row.calendarEvent) return null;
  return {
    checkpointId: row.id,
    managerUserId: row.managerUserId,
    consultantId: row.consultantId,
    type: row.type,
    checkpointStatus: row.status,
    notes: row.notes,
    transcription: row.transcription,
    audioStorageKey: row.audioStorageKey,
    occurredAt: row.occurredAt,
    eventJoinUrl: row.calendarEvent.joinUrl,
    eventOrganizerEmail: row.calendarEvent.organizerEmail,
    eventStartAt: row.calendarEvent.startAt,
    eventEndAt: row.calendarEvent.endAt,
    eventCancelled: row.calendarEvent.isCancelled,
    emailMinutesStatus: row.emailMinutes?.status ?? null,
    transcript: row.teamsTranscript ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

class LeaseLostError extends Error {}
class CheckpointChangedError extends Error {}

/** Lease livre ou vencido (ou já desta rodada). */
function leaseFree(now: Date, owner: string): Prisma.CheckpointTeamsTranscriptWhereInput {
  return { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner: owner }] };
}

const NOTIFICATION_COPY = {
  ready: {
    event: "CHECKPOINT_MINUTES_READY" as const,
    title: "Ata do checkpoint pronta",
    body: "A ata foi gerada a partir da transcrição do Teams. Revise as notas, as ações e os insights antes de compartilhar.",
  },
  missing: {
    event: "CHECKPOINT_TRANSCRIPT_MISSING" as const,
    title: "Sem transcrição do Teams",
    body: "Não encontramos a transcrição do Teams desta reunião. Cole as suas notas no checkpoint ou aguarde a ata por e-mail.",
  },
};

export const prismaTranscriptStore: TranscriptStore = {
  async enrollDueCheckpoints(now, limit) {
    const rows = await prisma.checkpoint.findMany({
      where: {
        status: "DRAFT",
        transcription: null,
        audioStorageKey: null,
        teamsTranscript: { is: null },
        OR: [{ notes: null }, { notes: "" }],
        calendarEvent: {
          isCancelled: false,
          joinUrl: { not: null },
          endAt: { gt: new Date(now.getTime() - TRANSCRIPT_HARD_LIMIT_MS), lte: now },
        },
        manager: { m365Connection: { status: "ACTIVE", scopes: { hasEvery: TEAMS_SCOPES } } },
      },
      orderBy: [{ occurredAt: "asc" }],
      select: { id: true, calendarEvent: { select: { endAt: true } } },
      take: limit,
    });
    let created = 0;
    for (const row of rows) {
      if (!row.calendarEvent) continue;
      try {
        await prisma.checkpointTeamsTranscript.create({
          data: {
            checkpointId: row.id,
            status: "PENDING",
            nextAttemptAt: new Date(row.calendarEvent.endAt.getTime() + TRANSCRIPT_GRACE_MS),
          },
        });
        created += 1;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    return created;
  },

  async listDue(now, limit) {
    const rows = await prisma.checkpoint.findMany({
      where: {
        calendarEvent: { endAt: { gt: new Date(now.getTime() - TRANSCRIPT_HARD_LIMIT_MS), lte: now } },
        manager: { m365Connection: { status: "ACTIVE", scopes: { hasEvery: TEAMS_SCOPES } } },
        teamsTranscript: {
          OR: [
            { status: { in: ["PENDING", "WAITING_TRANSCRIPT"] }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
            // Rodada que caiu no meio da geração: lease NULO ou vencido → retoma.
            { status: "GENERATING", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          ],
        },
      },
      orderBy: [{ occurredAt: "asc" }],
      select: SELECT,
      take: limit,
    });
    return rows.map(toCheckpoint).filter((r): r is TranscriptCheckpoint => r !== null);
  },

  async getTranscriptCheckpoint(checkpointId) {
    const row = await prisma.checkpoint.findUnique({ where: { id: checkpointId }, select: SELECT });
    return row ? toCheckpoint(row) : null;
  },

  async connectionIdForUser(userId) {
    const row = await prisma.m365Connection.findUnique({ where: { userId }, select: { id: true } });
    return row?.id ?? null;
  },

  async ensureRecord(checkpointId, nextAttemptAt) {
    try {
      await prisma.checkpointTeamsTranscript.create({ data: { checkpointId, status: "PENDING", nextAttemptAt } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  },

  async claim(checkpointId, owner, until, now, force) {
    const stateWhere: Prisma.CheckpointTeamsTranscriptWhereInput = force
      ? { status: { not: "DONE" } }
      : {
          OR: [
            { status: { in: ["PENDING", "WAITING_TRANSCRIPT"] }, nextAttemptAt: { lte: now } },
            { status: "GENERATING" },
          ],
        };
    const res = await prisma.checkpointTeamsTranscript.updateMany({
      where: { checkpointId, AND: [stateWhere, leaseFree(now, owner)] },
      data: { leaseOwner: owner, leaseUntil: until },
    });
    return res.count === 1;
  },

  async markGenerating(checkpointId, owner, until) {
    const res = await prisma.checkpointTeamsTranscript.updateMany({
      where: { checkpointId, leaseOwner: owner, status: { not: "DONE" } },
      data: { status: "GENERATING", leaseUntil: until },
    });
    return res.count === 1;
  },

  async recordAttempt(checkpointId, owner, outcome, now) {
    const res = await prisma.checkpointTeamsTranscript.updateMany({
      where: { checkpointId, leaseOwner: owner, status: { not: "DONE" } },
      data: {
        status: outcome.status,
        nextAttemptAt: outcome.nextAttemptAt,
        lastError: outcome.error,
        ...(outcome.accessDeniedAt ? { accessDeniedAt: outcome.accessDeniedAt } : {}),
        lastCheckedAt: now,
        attempts: { increment: 1 },
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    return res.count === 1;
  },

  async releaseClaim(checkpointId, owner, ifGenerating, now) {
    // Dono ainda em GENERATING (rodada interrompida): volta a WAITING/FAILED.
    await prisma.checkpointTeamsTranscript.updateMany({
      where: { checkpointId, leaseOwner: owner, status: "GENERATING" },
      data: {
        status: ifGenerating.status,
        nextAttemptAt: ifGenerating.nextAttemptAt,
        lastError: ifGenerating.error,
        lastCheckedAt: now,
        attempts: { increment: 1 },
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    await prisma.checkpointTeamsTranscript.updateMany({
      where: { checkpointId, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  },

  async expireStale(now) {
    const res = await prisma.checkpointTeamsTranscript.updateMany({
      where: {
        status: { in: ["PENDING", "WAITING_TRANSCRIPT", "GENERATING"] },
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          {
            // Fora da janela de 48 h, ou o evento sumiu (vínculo SetNull).
            OR: [
              { checkpoint: { calendarEvent: { endAt: { lt: new Date(now.getTime() - TRANSCRIPT_HARD_LIMIT_MS) } } } },
              { checkpoint: { calendarEventId: null } },
            ],
          },
        ],
      },
      data: { status: "NO_TRANSCRIPT", nextAttemptAt: null, lastError: "expired", leaseOwner: null, leaseUntil: null },
    });
    return res.count;
  },

  async saveTranscriptMinutes(input: SaveTranscriptMinutesInput): Promise<SaveTranscriptResult> {
    try {
      await prisma.$transaction(async (tx) => {
        const done = await tx.checkpointTeamsTranscript.updateMany({
          where: { checkpointId: input.checkpointId, leaseOwner: input.owner, status: "GENERATING" },
          data: {
            status: "DONE",
            mode: input.mode,
            aiSummary: input.aiSummary,
            transcriptsUsed: input.transcriptsUsed,
            truncated: input.truncated,
            lastError: null,
            lastCheckedAt: input.now,
            completedAt: input.now,
            nextAttemptAt: null,
            attempts: { increment: 1 },
            leaseOwner: null,
            leaseUntil: null,
          },
        });
        if (done.count !== 1) throw new LeaseLostError();
        const checkpointWhere: Prisma.CheckpointWhereInput =
          input.mode === "GENERATE"
            ? {
                id: input.checkpointId,
                status: "DRAFT",
                notes: input.expected.notes,
                transcription: input.expected.transcription,
                audioStorageKey: null,
              }
            : {
                id: input.checkpointId,
                // Como lido (arquivado nunca recebe complemento).
                status: { in: input.expected.checkpointStatus === "ARCHIVED" ? [] : [input.expected.checkpointStatus] },
                notes: input.expected.notes,
                transcription: input.expected.transcription,
              };
        const updated = await tx.checkpoint.updateMany({
          where: checkpointWhere,
          data: {
            notes: input.notes,
            transcription: input.transcription,
            // Complemento não rebaixa RECORDED/EXTRACTED; rascunho vira RECORDED.
            status: input.expected.checkpointStatus === "DRAFT" ? "RECORDED" : undefined,
          },
        });
        if (updated.count !== 1) throw new CheckpointChangedError();
        // Complemento: nunca duplica um card que o checkpoint já tem (inclusive
        // DISMISSED, que não é reaberto).
        const existing =
          input.actionItems.length > 0
            ? await tx.checkpointActionItem.findMany({
                where: { checkpointId: input.checkpointId },
                select: { title: true, ownerText: true, dueDate: true, dueText: true },
              })
            : [];
        const fresh = filterNewActionItems(input.actionItems, existing);
        if (fresh.length > 0) {
          await tx.checkpointActionItem.createMany({
            data: fresh.map((a) => ({
              checkpointId: input.checkpointId,
              title: a.title,
              ownerText: a.ownerText,
              dueDate: a.dueDate,
              dueText: a.dueText,
              sourceQuote: a.sourceQuote,
              aiGenerated: true,
              status: "PENDING" as const,
            })),
          });
        }
        await tx.auditEvent.create({
          data: {
            actorUserId: null,
            entityType: "Checkpoint",
            entityId: input.checkpointId,
            action: input.mode === "GENERATE" ? "CHECKPOINT_MINUTES_FROM_TEAMS" : "CHECKPOINT_MINUTES_SUPPLEMENTED_FROM_TEAMS",
            before: { status: input.expected.checkpointStatus },
            // Só contagens e flags — nunca o texto, nomes ou falas.
            after: {
              status: input.expected.checkpointStatus === "DRAFT" ? "RECORDED" : input.expected.checkpointStatus,
              mode: input.mode,
              aiSummary: input.aiSummary,
              actionItems: fresh.length,
              actionItemsSkippedAsDuplicate: input.actionItems.length - fresh.length,
              transcriptsUsed: input.transcriptsUsed,
              truncated: input.truncated,
              notesLength: input.notes.length,
              transcriptionLength: input.transcription.length,
            },
          },
        });
      });
      return "saved";
    } catch (error) {
      if (error instanceof LeaseLostError) return "lease_lost";
      if (error instanceof CheckpointChangedError) return "checkpoint_changed";
      throw error;
    }
  },

  async notifyManager(input) {
    try {
      const copy = NOTIFICATION_COPY[input.kind];
      const { createInAppNotifications } = await import("@/lib/db/notifications");
      await createInAppNotifications([
        { userId: input.userId, event: copy.event, title: copy.title, body: copy.body, href: "/app/checkpoints" },
      ]);
    } catch (error) {
      // Best-effort: aviso nunca derruba a ata. Só o nome do erro.
      console.error("[m365] transcript notification failed", (error as Error)?.name);
    }
  },
};
