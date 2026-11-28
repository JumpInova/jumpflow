import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  const fn = () => vi.fn();
  const prismaMock = {
    checkpoint: { findMany: fn(), findUnique: fn(), updateMany: fn() },
    checkpointEmailMinutes: { findUnique: fn(), findMany: fn(), create: fn(), updateMany: fn(), upsert: fn() },
    checkpointActionItem: { createMany: fn() },
    auditEvent: { create: fn() },
    m365Connection: { findUnique: fn() },
    consultant: { findUnique: fn() },
    $transaction: vi.fn(),
  };
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => Promise<unknown>) => cb(prismaMock));
  const createInAppNotifications = vi.fn<(rows: Array<Record<string, unknown>>) => Promise<number>>(async () => 1);
  return { prismaMock, PrismaClientKnownRequestError, createInAppNotifications };
});

vi.mock("@jumpflow/database", () => ({
  prisma: h.prismaMock,
  Prisma: { PrismaClientKnownRequestError: h.PrismaClientKnownRequestError },
}));
vi.mock("@/lib/db/notifications", () => ({ createInAppNotifications: h.createInAppNotifications }));

import { loadCheckpointM365Views, prismaMinutesStore } from "./m365-minutes";

const p = h.prismaMock;
const NOW = new Date("2026-11-26T15:00:00Z");

function input() {
  return {
    checkpointId: "chk1",
    expected: { notes: null, transcription: null },
    notes: "Ata gerada…",
    transcription: "texto [EMAIL_1]",
    source: { internetMessageId: "<m1@x>", webLink: "https://outlook.office365.com/x", receivedAt: NOW },
    attachmentsUsed: 1,
    attachmentsSkipped: 0,
    aiSummary: true,
    actionItems: [{ title: "T", ownerText: null, dueDate: null, dueText: null, sourceQuote: null }],
    now: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  p.$transaction.mockImplementation(async (cb: (tx: typeof p) => Promise<unknown>) => cb(p));
});

describe("saveMinutes", () => {
  it("grava origem DONE, rascunho condicional → RECORDED, cards PENDING e auditoria sem conteúdo", async () => {
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await prismaMinutesStore.saveMinutes(input())).toBe("saved");
    const upsert = p.checkpointEmailMinutes.upsert.mock.calls[0][0];
    expect(upsert.create).toMatchObject({ status: "DONE", internetMessageId: "<m1@x>", aiSummary: true });
    expect(Object.keys(upsert.create)).not.toContain("subject");
    const update = p.checkpoint.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: "chk1", status: "DRAFT", notes: null, transcription: null, audioStorageKey: null });
    expect(update.data).toEqual({ notes: "Ata gerada…", transcription: "texto [EMAIL_1]", status: "RECORDED" });
    expect(p.checkpointActionItem.createMany.mock.calls[0][0].data[0]).toMatchObject({ status: "PENDING", aiGenerated: true });
    const audit = JSON.stringify(p.auditEvent.create.mock.calls[0][0]);
    expect(audit).not.toContain("texto");
    expect(audit).not.toContain("Ata gerada");
    expect(audit).not.toContain("<m1@x>");
  });

  it("internetMessageId já usado (P2002) → duplicate_message, nada mais gravado", async () => {
    p.checkpointEmailMinutes.upsert.mockRejectedValueOnce(new h.PrismaClientKnownRequestError("P2002"));
    expect(await prismaMinutesStore.saveMinutes(input())).toBe("duplicate_message");
    expect(p.checkpoint.updateMany).not.toHaveBeenCalled();
  });

  it("rascunho mudou (gestor editou/arquivou) → checkpoint_changed e a transação aborta", async () => {
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await prismaMinutesStore.saveMinutes(input())).toBe("checkpoint_changed");
    expect(p.checkpointActionItem.createMany).not.toHaveBeenCalled();
  });
});

describe("listDueCheckpoints / recordSearch", () => {
  it("query exige DRAFT, evento na janela, sem ata e gestor com conexão ACTIVE + Mail.Read", async () => {
    p.checkpoint.findMany.mockResolvedValueOnce([]);
    await prismaMinutesStore.listDueCheckpoints(NOW, 10);
    const where = p.checkpoint.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("DRAFT");
    expect(where.manager).toEqual({ m365Connection: { status: "ACTIVE", scopes: { has: "Mail.Read" } } });
    expect(where.calendarEvent.isCancelled).toBe(false);
    expect(where.calendarEvent.endAt.lte).toEqual(NOW);
    expect(where.calendarEvent.endAt.gt).toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
  });

  it("recordSearch nunca rebaixa DONE", async () => {
    p.checkpointEmailMinutes.findUnique.mockResolvedValueOnce({ status: "DONE" });
    expect(await prismaMinutesStore.recordSearch("chk1", { status: "SEARCHING", error: null }, NOW)).toEqual({ previousStatus: "DONE" });
    expect(p.checkpointEmailMinutes.updateMany).not.toHaveBeenCalled();
    p.checkpointEmailMinutes.findUnique.mockResolvedValueOnce({ status: "SEARCHING" });
    await prismaMinutesStore.recordSearch("chk1", { status: "AMBIGUOUS", error: null }, NOW);
    expect(p.checkpointEmailMinutes.updateMany.mock.calls[0][0].where).toEqual({ checkpointId: "chk1", status: { not: "DONE" } });
  });

  it("aviso in-app ao gestor sem nome nem e-mail de pessoas", async () => {
    await prismaMinutesStore.notifyManager({ userId: "u-mgr", checkpointId: "chk1", kind: "ready" });
    const rows = h.createInAppNotifications.mock.calls[0][0];
    expect(rows[0]).toMatchObject({ userId: "u-mgr", event: "CHECKPOINT_MINUTES_READY", href: "/app/checkpoints" });
    expect(String(rows[0].body)).not.toMatch(/@/);
  });
});

describe("loadCheckpointM365Views", () => {
  it("projeta só metadados da origem e cards; isOwnManager pelo User.id do viewer", async () => {
    p.checkpoint.findMany.mockResolvedValueOnce([
      {
        id: "chk1",
        managerUserId: "u-mgr",
        calendarEventId: "ev1",
        emailMinutes: {
          status: "DONE",
          webLink: "https://outlook.office365.com/x",
          receivedAt: NOW,
          aiSummary: true,
          attachmentsUsed: 1,
          attachmentsSkipped: 0,
          lastCheckedAt: NOW,
        },
        actionItems: [
          { id: "a1", title: "T", ownerText: "Ana", dueDate: new Date("2026-12-05T00:00:00Z"), dueText: null, sourceQuote: "q", status: "PENDING" },
        ],
      },
    ]);
    const views = await loadCheckpointM365Views(["chk1"], "u-mgr");
    expect(views.chk1).toMatchObject({ linkedToEvent: true, isOwnManager: true, minutes: { status: "DONE" } });
    expect(views.chk1.actionItems[0].dueDate).toBe("2026-12-05");
    expect(await loadCheckpointM365Views([], "u-mgr")).toEqual({});
  });
});
