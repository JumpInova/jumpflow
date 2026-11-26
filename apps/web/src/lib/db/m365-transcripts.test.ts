import { beforeEach, describe, expect, it, vi } from "vitest";

/** M3 — persistência Prisma da transcrição do Teams (Prisma mockado). */

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
    checkpointTeamsTranscript: { create: fn(), updateMany: fn() },
    checkpointActionItem: { createMany: fn(), findMany: fn() },
    auditEvent: { create: fn() },
    m365Connection: { findUnique: fn() },
    $transaction: vi.fn(),
  };
  const createInAppNotifications = vi.fn<(rows: Array<Record<string, unknown>>) => Promise<number>>(async () => 1);
  return { prismaMock, PrismaClientKnownRequestError, createInAppNotifications };
});

vi.mock("@jumpflow/database", () => ({
  prisma: h.prismaMock,
  Prisma: { PrismaClientKnownRequestError: h.PrismaClientKnownRequestError },
}));
vi.mock("@/lib/db/notifications", () => ({ createInAppNotifications: h.createInAppNotifications }));

import { prismaTranscriptStore } from "./m365-transcripts";

const p = h.prismaMock;
const NOW = new Date("2026-11-26T15:00:00Z");
const UNTIL = new Date("2026-11-26T15:05:00Z");

function save(over: Record<string, unknown> = {}) {
  return {
    checkpointId: "chk1",
    owner: "job-A",
    mode: "GENERATE" as const,
    expected: { checkpointStatus: "DRAFT" as const, notes: null, transcription: null },
    notes: "Ata gerada…",
    transcription: "Ana Souza: [EMAIL_1]",
    aiSummary: true,
    transcriptsUsed: 1,
    truncated: false,
    actionItems: [{ title: "T", ownerText: null, dueDate: null, dueText: null, sourceQuote: null }],
    now: NOW,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  p.$transaction.mockImplementation(async (cb: (tx: typeof p) => Promise<unknown>) => cb(p));
  p.checkpointActionItem.findMany.mockResolvedValue([]);
});

describe("claim atômico (updateMany condicional, sem trava em memória)", () => {
  it("job: estado devido + próxima tentativa vencida (ou GENERATING abandonado) + lease livre/vencido", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await prismaTranscriptStore.claim("chk1", "job-A", UNTIL, NOW, false)).toBe(true);
    const { where, data } = p.checkpointTeamsTranscript.updateMany.mock.calls[0][0];
    expect(where.checkpointId).toBe("chk1");
    expect(where.AND[0]).toEqual({
      OR: [{ status: { in: ["PENDING", "WAITING_TRANSCRIPT"] }, nextAttemptAt: { lte: NOW } }, { status: "GENERATING" }],
    });
    expect(where.AND[1]).toEqual({ OR: [{ leaseUntil: null }, { leaseUntil: { lt: NOW } }, { leaseOwner: "job-A" }] });
    expect(data).toEqual({ leaseOwner: "job-A", leaseUntil: UNTIL });
  });

  it("manual (force): qualquer estado menos DONE; count 0 = outro dono", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await prismaTranscriptStore.claim("chk1", "user-1", UNTIL, NOW, true)).toBe(false);
    expect(p.checkpointTeamsTranscript.updateMany.mock.calls[0][0].where.AND[0]).toEqual({ status: { not: "DONE" } });
  });

  it("recordAttempt/markGenerating/releaseClaim só para o dono; recordAttempt solta o lease", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValue({ count: 1 });
    await prismaTranscriptStore.recordAttempt("chk1", "job-A", { status: "WAITING_TRANSCRIPT", nextAttemptAt: UNTIL, error: "access_denied" }, NOW);
    const rec = p.checkpointTeamsTranscript.updateMany.mock.calls[0][0];
    expect(rec.where).toEqual({ checkpointId: "chk1", leaseOwner: "job-A", status: { not: "DONE" } });
    expect(rec.data).toMatchObject({ status: "WAITING_TRANSCRIPT", lastError: "access_denied", leaseOwner: null, leaseUntil: null, attempts: { increment: 1 } });
    await prismaTranscriptStore.markGenerating("chk1", "job-A", UNTIL);
    expect(p.checkpointTeamsTranscript.updateMany.mock.calls[1][0].where).toMatchObject({ leaseOwner: "job-A" });
    await prismaTranscriptStore.releaseClaim("chk1", "job-A", { status: "WAITING_TRANSCRIPT", nextAttemptAt: UNTIL, error: "interrupted" }, NOW);
    // GENERATING órfão deste dono volta a WAITING com backoff; depois solta o lease.
    expect(p.checkpointTeamsTranscript.updateMany.mock.calls[2][0]).toMatchObject({
      where: { checkpointId: "chk1", leaseOwner: "job-A", status: "GENERATING" },
      data: { status: "WAITING_TRANSCRIPT", nextAttemptAt: UNTIL, lastError: "interrupted", leaseOwner: null, leaseUntil: null },
    });
    expect(p.checkpointTeamsTranscript.updateMany.mock.calls[3][0]).toEqual({
      where: { checkpointId: "chk1", leaseOwner: "job-A" },
      data: { leaseOwner: null, leaseUntil: null },
    });
  });

  it("ensureRecord/enrolamento idempotentes (P2002 = já existe)", async () => {
    p.checkpointTeamsTranscript.create.mockRejectedValueOnce(new h.PrismaClientKnownRequestError("P2002"));
    await expect(prismaTranscriptStore.ensureRecord("chk1", NOW)).resolves.toBeUndefined();
    p.checkpoint.findMany.mockResolvedValueOnce([
      { id: "a", calendarEvent: { endAt: NOW } },
      { id: "b", calendarEvent: { endAt: NOW } },
    ]);
    p.checkpointTeamsTranscript.create.mockResolvedValueOnce({}).mockRejectedValueOnce(new h.PrismaClientKnownRequestError("P2002"));
    expect(await prismaTranscriptStore.enrollDueCheckpoints(NOW, 10)).toBe(1);
    const where = p.checkpoint.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "DRAFT", transcription: null, audioStorageKey: null, teamsTranscript: { is: null } });
    expect(where.manager).toEqual({
      m365Connection: { status: "ACTIVE", scopes: { hasEvery: ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"] } },
    });
    expect(where.calendarEvent.joinUrl).toEqual({ not: null });
    expect(p.checkpointTeamsTranscript.create.mock.calls[1][0].data).toMatchObject({
      status: "PENDING",
      nextAttemptAt: new Date(NOW.getTime() + 10 * 60_000),
    });
  });
});

describe("nenhum estado sem saída", () => {
  it("listDue retoma GENERATING com lease NULO ou vencido", async () => {
    p.checkpoint.findMany.mockResolvedValueOnce([]);
    await prismaTranscriptStore.listDue(NOW, 10);
    const ors = p.checkpoint.findMany.mock.calls[0][0].where.teamsTranscript.OR;
    expect(ors[1]).toEqual({ status: "GENERATING", OR: [{ leaseUntil: null }, { leaseUntil: { lt: NOW } }] });
  });

  it("expireStale: não finais sem lease vivo fora de 48 h (ou sem evento) → NO_TRANSCRIPT expired", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 2 });
    expect(await prismaTranscriptStore.expireStale(NOW)).toBe(2);
    const { where, data } = p.checkpointTeamsTranscript.updateMany.mock.calls[0][0];
    expect(where.status).toEqual({ in: ["PENDING", "WAITING_TRANSCRIPT", "GENERATING"] });
    expect(where.AND[1].OR[0]).toEqual({
      checkpoint: { calendarEvent: { endAt: { lt: new Date(NOW.getTime() - 48 * 3600_000) } } },
    });
    expect(where.AND[1].OR[1]).toEqual({ checkpoint: { calendarEventId: null } });
    expect(data).toMatchObject({ status: "NO_TRANSCRIPT", lastError: "expired", leaseOwner: null });
  });
});

describe("saveTranscriptMinutes", () => {
  it("GENERATE: registro DONE (dono + GENERATING), rascunho condicional → RECORDED, cards e auditoria só com contagens", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 1 });
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await prismaTranscriptStore.saveTranscriptMinutes(save())).toBe("saved");
    expect(p.checkpointTeamsTranscript.updateMany.mock.calls[0][0].where).toEqual({ checkpointId: "chk1", leaseOwner: "job-A", status: "GENERATING" });
    const cp = p.checkpoint.updateMany.mock.calls[0][0];
    expect(cp.where).toEqual({ id: "chk1", status: "DRAFT", notes: null, transcription: null, audioStorageKey: null });
    expect(cp.data).toEqual({ notes: "Ata gerada…", transcription: "Ana Souza: [EMAIL_1]", status: "RECORDED" });
    const audit = JSON.stringify(p.auditEvent.create.mock.calls[0][0]);
    expect(audit).toContain("CHECKPOINT_MINUTES_FROM_TEAMS");
    expect(audit).not.toContain("Ana Souza");
    expect(audit).not.toContain("Ata gerada");
  });

  it("SUPPLEMENT: condicional pelo status/notas lidos, não rebaixa RECORDED", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 1 });
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 1 });
    await prismaTranscriptStore.saveTranscriptMinutes(
      save({ mode: "SUPPLEMENT", expected: { checkpointStatus: "RECORDED", notes: "ata e-mail", transcription: "fonte" } }),
    );
    const cp = p.checkpoint.updateMany.mock.calls[0][0];
    expect(cp.where).toEqual({ id: "chk1", status: { in: ["RECORDED"] }, notes: "ata e-mail", transcription: "fonte" });
    expect(cp.data.status).toBeUndefined();
  });

  it("lease perdido → lease_lost; checkpoint mudou → checkpoint_changed (transação desfeita, nada de cards)", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await prismaTranscriptStore.saveTranscriptMinutes(save())).toBe("lease_lost");
    expect(p.checkpoint.updateMany).not.toHaveBeenCalled();
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 1 });
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await prismaTranscriptStore.saveTranscriptMinutes(save())).toBe("checkpoint_changed");
    expect(p.checkpointActionItem.createMany).not.toHaveBeenCalled();
  });
});

describe("complemento não duplica cards de Ação", () => {
  it("pula ações já existentes no checkpoint (qualquer status, inclusive DISMISSED) e duplicatas do lote", async () => {
    p.checkpointTeamsTranscript.updateMany.mockResolvedValueOnce({ count: 1 });
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 1 });
    p.checkpointActionItem.findMany.mockResolvedValueOnce([
      { title: "Enviar plano de estudos", ownerText: "Ana", dueDate: null, dueText: "2026-12-05" },
      { title: "Revisar metas", ownerText: null, dueDate: null, dueText: null },
    ]);
    const items = [
      { title: "Enviar  plano de ESTUDOS.", ownerText: "ana", dueDate: new Date("2026-12-05T00:00:00Z"), dueText: null, sourceQuote: null },
      { title: "Revisar metas", ownerText: "Bruno", dueDate: null, dueText: null, sourceQuote: null },
      { title: "Agendar retorno", ownerText: null, dueDate: null, dueText: null, sourceQuote: null },
      { title: "agendar retorno", ownerText: null, dueDate: null, dueText: null, sourceQuote: null },
      { title: "Enviar plano de estudos", ownerText: "Carlos", dueDate: null, dueText: null, sourceQuote: null },
    ];
    await prismaTranscriptStore.saveTranscriptMinutes(
      save({ mode: "SUPPLEMENT", expected: { checkpointStatus: "RECORDED", notes: "a", transcription: "f" }, actionItems: items }),
    );
    expect(p.checkpointActionItem.findMany.mock.calls[0][0].where).toEqual({ checkpointId: "chk1" });
    const created = p.checkpointActionItem.createMany.mock.calls[0][0].data.map((d: { title: string; ownerText: string | null }) => [d.title, d.ownerText]);
    // Responsável diferente = outra ação; mesmo título sem responsável = mesma ação.
    expect(created).toEqual([["Agendar retorno", null], ["Enviar plano de estudos", "Carlos"]]);
    const audit = p.auditEvent.create.mock.calls[0][0].data.after;
    expect(audit).toMatchObject({ actionItems: 2, actionItemsSkippedAsDuplicate: 3 });
  });
});

describe("aviso ao gestor", () => {
  it("missing: só in-app, sem nome/e-mail/conteúdo; falha do aviso não lança", async () => {
    await prismaTranscriptStore.notifyManager({ userId: "u-mgr", checkpointId: "chk1", kind: "missing" });
    const [rows] = h.createInAppNotifications.mock.calls[0];
    expect(rows[0]).toMatchObject({ userId: "u-mgr", event: "CHECKPOINT_TRANSCRIPT_MISSING", href: "/app/checkpoints" });
    expect(String(rows[0].body)).toContain("Cole as suas notas");
    h.createInAppNotifications.mockRejectedValueOnce(new Error("x"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(prismaTranscriptStore.notifyManager({ userId: "u", checkpointId: "c", kind: "ready" })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
