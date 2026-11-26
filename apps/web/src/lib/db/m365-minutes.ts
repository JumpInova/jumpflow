import { Prisma, prisma } from "@jumpflow/database";
import type { ExtractionRow } from "@/lib/checkpoint/run-extraction";
import type { CheckpointM365View } from "@/lib/checkpoint/action-items";
import type {
  EmailMinutesStatus,
  MinutesCheckpoint,
  MinutesStore,
  SaveMinutesInput,
  SaveMinutesResult,
} from "@/lib/m365/minutes/store";

/**
 * Persistência Prisma das atas por e-mail (M365 M2).
 *
 * - Elegibilidade na query (DRAFT, evento encerrado há < 7 dias, sem ata,
 *   gestor com conexão ACTIVE + Mail.Read) e reconferida pela regra pura.
 * - `saveMinutes` numa transação: `CheckpointEmailMinutes.internetMessageId`
 *   ÚNICO (P2002 = o e-mail já alimentou outro checkpoint) + update condicional
 *   do rascunho (DRAFT e notas/transcrição como lidas) + cards PENDING.
 * - Nada de assunto/remetente/corpo do e-mail é guardado; logs/auditoria só
 *   com contagens.
 */

/** Intervalo mínimo entre duas buscas automáticas do mesmo checkpoint. */
export const MINUTES_RECHECK_MS = 30 * 60_000;
const WINDOW_MS = 7 * 86_400_000;

const CHECKPOINT_SELECT = {
  id: true,
  managerUserId: true,
  consultantId: true,
  type: true,
  status: true,
  notes: true,
  transcription: true,
  audioStorageKey: true,
  occurredAt: true,
  calendarEvent: { select: { subject: true, startAt: true, endAt: true, isCancelled: true } },
  emailMinutes: { select: { status: true } },
} satisfies Prisma.CheckpointSelect;

type Row = Prisma.CheckpointGetPayload<{ select: typeof CHECKPOINT_SELECT }>;

function toMinutesCheckpoint(row: Row): MinutesCheckpoint | null {
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
    eventSubject: row.calendarEvent.subject,
    eventStartAt: row.calendarEvent.startAt,
    eventEndAt: row.calendarEvent.endAt,
    eventCancelled: row.calendarEvent.isCancelled,
    minutesStatus: row.emailMinutes?.status ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

class CheckpointChangedError extends Error {}

const NOTIFICATION_COPY = {
  ready: {
    event: "CHECKPOINT_MINUTES_READY" as const,
    title: "Ata do checkpoint pronta",
    body: "A ata foi gerada a partir do e-mail. Revise as notas, as ações e os insights antes de compartilhar.",
  },
  choice: {
    event: "CHECKPOINT_MINUTES_CHOICE" as const,
    title: "Escolha o e-mail da ata",
    body: "Mais de um e-mail pode ser a ata deste checkpoint. Abra o checkpoint e escolha qual usar.",
  },
};

export const prismaMinutesStore: MinutesStore = {
  async listDueCheckpoints(now, limit) {
    const rows = await prisma.checkpoint.findMany({
      where: {
        status: "DRAFT",
        transcription: null,
        audioStorageKey: null,
        calendarEvent: {
          isCancelled: false,
          endAt: { gt: new Date(now.getTime() - WINDOW_MS), lte: now },
        },
        manager: { m365Connection: { status: "ACTIVE", scopes: { has: "Mail.Read" } } },
        AND: [
          { OR: [{ notes: null }, { notes: "" }] },
          {
            OR: [
              { emailMinutes: { is: null } },
              {
                // FAILED (sem texto/curto) é recuperável: volta a procurar até
                // o fim da janela de 7 dias.
                emailMinutes: {
                  status: { in: ["SEARCHING", "FAILED"] },
                  OR: [
                    { lastCheckedAt: null },
                    { lastCheckedAt: { lt: new Date(now.getTime() - MINUTES_RECHECK_MS) } },
                  ],
                },
              },
            ],
          },
        ],
      },
      orderBy: [{ occurredAt: "asc" }],
      select: CHECKPOINT_SELECT,
      take: limit,
    });
    return rows.map(toMinutesCheckpoint).filter((r): r is MinutesCheckpoint => r !== null);
  },

  async getMinutesCheckpoint(checkpointId) {
    const row = await prisma.checkpoint.findUnique({ where: { id: checkpointId }, select: CHECKPOINT_SELECT });
    return row ? toMinutesCheckpoint(row) : null;
  },

  async connectionIdForUser(userId) {
    const row = await prisma.m365Connection.findUnique({ where: { userId }, select: { id: true } });
    return row?.id ?? null;
  },

  async consultantEmails(consultantId) {
    const row = await prisma.consultant.findUnique({
      where: { id: consultantId },
      select: { email: true, user: { select: { email: true } } },
    });
    if (!row) return [];
    return [...new Set([row.email, row.user?.email].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
  },

  async usedInternetMessageIds(ids, exceptCheckpointId) {
    if (ids.length === 0) return new Set();
    const rows = await prisma.checkpointEmailMinutes.findMany({
      where: { internetMessageId: { in: ids }, checkpointId: { not: exceptCheckpointId } },
      select: { internetMessageId: true },
    });
    return new Set(rows.map((r) => r.internetMessageId!).filter(Boolean));
  },

  async recordSearch(checkpointId, outcome, now) {
    const existing = await prisma.checkpointEmailMinutes.findUnique({
      where: { checkpointId },
      select: { status: true },
    });
    if (existing?.status === "DONE") return { previousStatus: "DONE" };
    const data = { status: outcome.status, lastError: outcome.error, lastCheckedAt: now };
    if (!existing) {
      try {
        await prisma.checkpointEmailMinutes.create({ data: { checkpointId, ...data, attempts: 1 } });
        return { previousStatus: null };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    // Nunca rebaixa um DONE gravado em paralelo.
    await prisma.checkpointEmailMinutes.updateMany({
      where: { checkpointId, status: { not: "DONE" } },
      data: { ...data, attempts: { increment: 1 } },
    });
    return { previousStatus: (existing?.status ?? null) as EmailMinutesStatus | null };
  },

  async saveMinutes(input: SaveMinutesInput): Promise<SaveMinutesResult> {
    try {
      await prisma.$transaction(async (tx) => {
        const source = {
          status: "DONE" as const,
          internetMessageId: input.source.internetMessageId,
          webLink: input.source.webLink,
          receivedAt: input.source.receivedAt,
          attachmentsUsed: input.attachmentsUsed,
          attachmentsSkipped: input.attachmentsSkipped,
          aiSummary: input.aiSummary,
          lastCheckedAt: input.now,
          lastError: null,
          completedAt: input.now,
        };
        // Unique em internetMessageId: P2002 aborta a transação inteira.
        await tx.checkpointEmailMinutes.upsert({
          where: { checkpointId: input.checkpointId },
          create: { checkpointId: input.checkpointId, ...source, attempts: 1 },
          update: { ...source, attempts: { increment: 1 } },
        });
        const updated = await tx.checkpoint.updateMany({
          where: {
            id: input.checkpointId,
            status: "DRAFT",
            notes: input.expected.notes,
            transcription: input.expected.transcription,
            audioStorageKey: null,
          },
          data: { notes: input.notes, transcription: input.transcription, status: "RECORDED" },
        });
        if (updated.count !== 1) throw new CheckpointChangedError();
        if (input.actionItems.length > 0) {
          await tx.checkpointActionItem.createMany({
            data: input.actionItems.map((a) => ({
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
            action: "CHECKPOINT_MINUTES_FROM_EMAIL",
            before: { status: "DRAFT" },
            // Só contagens e flags — nunca o texto, o assunto ou o remetente.
            after: {
              status: "RECORDED",
              aiSummary: input.aiSummary,
              actionItems: input.actionItems.length,
              attachmentsUsed: input.attachmentsUsed,
              attachmentsSkipped: input.attachmentsSkipped,
              notesLength: input.notes.length,
              transcriptionLength: input.transcription.length,
            },
          },
        });
      });
      return "saved";
    } catch (error) {
      if (error instanceof CheckpointChangedError) return "checkpoint_changed";
      if (isUniqueViolation(error)) return "duplicate_message";
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
      console.error("[m365] minutes notification failed", (error as Error)?.name);
    }
  },
};

/** Linha para o pipeline de extração (após gravar a ata). */
export async function loadExtractionRow(checkpointId: string): Promise<ExtractionRow | null> {
  const row = await prisma.checkpoint.findUnique({
    where: { id: checkpointId },
    select: {
      id: true,
      consultantId: true,
      relatedProjectId: true,
      type: true,
      occurredAt: true,
      weekStart: true,
      weekEnd: true,
      notes: true,
      transcription: true,
      status: true,
    },
  });
  if (!row || row.status === "ARCHIVED") return null;
  return row;
}

// ── Leitura para a tela do Checkpoint ────────────────────────────────────────


/**
 * Painéis M365 dos checkpoints cujo CRU o viewer pode ver (o chamador filtra
 * por `canViewRaw`, que já aplica PRIVATE/SHARED — o consultor nunca recebe).
 */
export async function loadCheckpointM365Views(
  checkpointIds: string[],
  viewerUserId: string | null,
): Promise<Record<string, CheckpointM365View>> {
  if (checkpointIds.length === 0) return {};
  const rows = await prisma.checkpoint.findMany({
    where: { id: { in: checkpointIds } },
    select: {
      id: true,
      managerUserId: true,
      calendarEventId: true,
      emailMinutes: {
        select: {
          status: true,
          webLink: true,
          receivedAt: true,
          aiSummary: true,
          attachmentsUsed: true,
          attachmentsSkipped: true,
          lastCheckedAt: true,
        },
      },
      actionItems: {
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, title: true, ownerText: true, dueDate: true, dueText: true, sourceQuote: true, status: true },
      },
    },
  });
  const out: Record<string, CheckpointM365View> = {};
  for (const row of rows) {
    out[row.id] = {
      linkedToEvent: row.calendarEventId !== null,
      isOwnManager: viewerUserId !== null && row.managerUserId === viewerUserId,
      minutes: row.emailMinutes
        ? {
            status: row.emailMinutes.status,
            webLink: row.emailMinutes.webLink,
            receivedAt: row.emailMinutes.receivedAt?.toISOString() ?? null,
            aiSummary: row.emailMinutes.aiSummary,
            attachmentsUsed: row.emailMinutes.attachmentsUsed,
            attachmentsSkipped: row.emailMinutes.attachmentsSkipped,
            lastCheckedAt: row.emailMinutes.lastCheckedAt?.toISOString() ?? null,
          }
        : null,
      actionItems: row.actionItems.map((a) => ({
        id: a.id,
        title: a.title,
        ownerText: a.ownerText,
        dueDate: a.dueDate ? a.dueDate.toISOString().slice(0, 10) : null,
        dueText: a.dueText,
        sourceQuote: a.sourceQuote,
        status: a.status,
      })),
    };
  }
  return out;
}
