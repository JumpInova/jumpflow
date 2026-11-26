import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA (Fase M1) — persistência Prisma da integração, com o client mockado
 * (nenhum banco real): lease condicional, idempotência por unique, arquivamento
 * condicional, desconexão apagando tokens, IntegrationEvent sem conteúdo e
 * escopo do próprio usuário nas operações da UI.
 */

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
    m365Connection: { updateMany: fn(), update: fn(), findUnique: fn(), create: fn(), findMany: fn(), groupBy: fn() },
    calendarEvent: { upsert: fn(), update: fn(), deleteMany: fn() },
    calendarEventSighting: { upsert: fn(), findUnique: fn(), update: fn(), findMany: fn(), updateMany: fn() },
    checkpoint: { findUnique: fn(), create: fn(), findMany: fn(), updateMany: fn(), count: fn() },
    auditEvent: { create: fn() },
    integrationEvent: { create: fn(), count: fn() },
    m365TimeSuggestion: { findUnique: fn(), create: fn(), update: fn(), deleteMany: fn(), updateMany: fn(), findFirst: fn(), findMany: fn() },
    timeEntry: { create: fn(), findMany: fn() },
    allocation: { findMany: fn() },
    user: { findUnique: fn(), count: fn() },
    consultant: { findMany: fn() },
    project: { findMany: fn() },
  };
  return { prismaMock, PrismaClientKnownRequestError };
});

vi.mock("@jumpflow/database", () => ({
  prisma: h.prismaMock,
  Prisma: { JsonNull: "__JsonNull__", PrismaClientKnownRequestError: h.PrismaClientKnownRequestError },
}));
vi.mock("@/lib/db/checkpoint", () => ({ canTargetConsultant: vi.fn(async () => true) }));

import {
  guardedWhere,
  disconnectOwnConnection,
  dismissOwnSuggestion,
  getOwnPendingSuggestion,
  logM365Event,
  prismaM365Store,
  setOwnConnectionPaused,
  upsertM365Connection,
} from "./m365";

const p = h.prismaMock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lease de sync (claim atômico no banco)", () => {
  it("claim é updateMany condicional: ACTIVE e (livre | vencido | mesmo dono)", async () => {
    p.m365Connection.updateMany.mockResolvedValueOnce({ count: 1 });
    const now = new Date("2026-11-26T15:00:00Z");
    const until = new Date("2026-11-26T15:05:00Z");
    expect(await prismaM365Store.claimSyncLease("c1", "job:1", until, now)).toBe(true);
    const arg = p.m365Connection.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      id: "c1",
      status: "ACTIVE",
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }, { syncLeaseOwner: "job:1" }],
    });
    expect(arg.data).toMatchObject({ syncLeaseUntil: until, syncLeaseOwner: "job:1" });
  });

  it("outra instância dona do lease → count 0 → false", async () => {
    p.m365Connection.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await prismaM365Store.claimSyncLease("c1", "user:1", new Date(), new Date())).toBe(false);
  });

  it("release só limpa o lease do próprio dono", async () => {
    p.m365Connection.updateMany.mockResolvedValueOnce({ count: 0 });
    await prismaM365Store.releaseSyncLease("c1", "job:1");
    expect(p.m365Connection.updateMany.mock.calls[0][0].where).toEqual({ id: "c1", syncLeaseOwner: "job:1" });
  });
});

describe("rascunho de Checkpoint (idempotência e privacidade)", () => {
  const input = {
    calendarEventId: "ev1",
    consultantId: "cons-ana",
    managerUserId: "u-mgr",
    type: "ONE_ON_ONE" as const,
    occurredAt: new Date("2026-11-27T13:00:00Z"),
    title: "1:1 Ana",
  };

  it("cria DRAFT/PRIVATE com o vínculo do evento e audita sem o assunto", async () => {
    p.checkpoint.findUnique.mockResolvedValueOnce(null);
    p.checkpoint.create.mockResolvedValueOnce({ id: "chk1" });
    expect(await prismaM365Store.ensureCheckpointDraft(input)).toBe("created");
    expect(p.checkpoint.create.mock.calls[0][0].data).toEqual({
      consultantId: "cons-ana",
      managerUserId: "u-mgr",
      calendarEventId: "ev1",
      type: "ONE_ON_ONE",
      occurredAt: input.occurredAt,
      title: "1:1 Ana",
      status: "DRAFT",
      visibility: "PRIVATE",
    });
    const audit = p.auditEvent.create.mock.calls[0][0].data;
    expect(audit.action).toBe("CHECKPOINT_DRAFTED_FROM_CALENDAR");
    expect(JSON.stringify(audit)).not.toContain("1:1 Ana");
  });

  it("já existe (unique evento+consultor) → exists sem criar", async () => {
    p.checkpoint.findUnique.mockResolvedValueOnce({ id: "chk1" });
    expect(await prismaM365Store.ensureCheckpointDraft(input)).toBe("exists");
    expect(p.checkpoint.create).not.toHaveBeenCalled();
    expect(p.checkpoint.findUnique.mock.calls[0][0].where).toEqual({
      calendarEventId_consultantId: { calendarEventId: "ev1", consultantId: "cons-ana" },
    });
  });

  it("corrida: P2002 no create → exists (sem auditoria duplicada)", async () => {
    p.checkpoint.findUnique.mockResolvedValueOnce(null);
    p.checkpoint.create.mockRejectedValueOnce(new h.PrismaClientKnownRequestError("P2002"));
    expect(await prismaM365Store.ensureCheckpointDraft(input)).toBe("exists");
    expect(p.auditEvent.create).not.toHaveBeenCalled();
  });

  it("outro erro do banco propaga", async () => {
    p.checkpoint.findUnique.mockResolvedValueOnce(null);
    p.checkpoint.create.mockRejectedValueOnce(new h.PrismaClientKnownRequestError("P2003"));
    await expect(prismaM365Store.ensureCheckpointDraft(input)).rejects.toBeTruthy();
  });
});

describe("cancelamento → arquivamento condicional", () => {
  it("só DRAFT sem conteúdo; update condicional protege contra o gestor editando ao mesmo tempo", async () => {
    p.checkpoint.findMany.mockResolvedValueOnce([
      { id: "a", status: "DRAFT", notes: null, transcription: null, audioStorageKey: null },
      { id: "b", status: "DRAFT", notes: "notas", transcription: null, audioStorageKey: null },
      { id: "c", status: "DRAFT", notes: null, transcription: null, audioStorageKey: null },
    ]);
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await prismaM365Store.archiveDisposableDrafts("ev1")).toBe(1);
    expect(p.checkpoint.findMany.mock.calls[0][0].where).toEqual({ calendarEventId: "ev1", status: "DRAFT" });
    expect(p.checkpoint.updateMany).toHaveBeenCalledTimes(2);
    expect(p.checkpoint.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "a", status: "DRAFT", notes: null, transcription: null, audioStorageKey: null },
      data: { status: "ARCHIVED" },
    });
    expect(p.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(p.auditEvent.create.mock.calls[0][0].data.action).toBe("CHECKPOINT_DRAFT_ARCHIVED_EVENT_CANCELLED");
  });

  it("notas vazias/só espaços contam como sem conteúdo nos DOIS lados (correção M1)", async () => {
    p.checkpoint.findMany.mockResolvedValueOnce([{ id: "a", status: "DRAFT", notes: "  ", transcription: "", audioStorageKey: null }]);
    p.checkpoint.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await prismaM365Store.archiveDisposableDrafts("ev1")).toBe(1);
    // Concorrência otimista: o where exige o mesmo valor avaliado pela regra pura.
    expect(p.checkpoint.updateMany.mock.calls[0][0].where).toEqual({
      id: "a",
      status: "DRAFT",
      notes: "  ",
      transcription: "",
      audioStorageKey: null,
    });
  });
});

describe("evento e sighting", () => {
  it("upsert do CalendarEvent por iCalUId não leva corpo, webLink nem graphEventId; sighting reabre (removedAt null)", async () => {
    p.calendarEvent.upsert.mockResolvedValueOnce({ id: "ev1" });
    await prismaM365Store.upsertCalendarEvent(
      "c1",
      {
        graphEventId: "g1",
        iCalUId: "ical-1",
        subject: "1:1",
        startAt: new Date(),
        endAt: new Date(),
        isAllDay: false,
        organizerEmail: "g@x.com",
        organizerName: null,
        attendees: [],
        categories: [],
        joinUrl: null,
        isCancelled: false,
        webLink: "https://outlook.office365.com/x",
        responseStatus: "organizer",
      },
      new Date(),
      true,
    );
    const ev = p.calendarEvent.upsert.mock.calls[0][0];
    expect(ev.where).toEqual({ iCalUId: "ical-1" });
    // Correção M1: categories é por caixa (sighting); isCancelled do evento só
    // pela visão do organizador.
    expect(Object.keys(ev.update).sort()).toEqual(
      ["attendees", "endAt", "isAllDay", "isCancelled", "joinUrl", "organizerEmail", "organizerName", "startAt", "subject"].sort(),
    );
    const s = p.calendarEventSighting.upsert.mock.calls[0][0];
    expect(s.where).toEqual({ connectionId_graphEventId: { connectionId: "c1", graphEventId: "g1" } });
    expect(s.update.removedAt).toBeNull();
    expect(s.update).toMatchObject({ categories: [], isCancelled: false });
  });

  it("visão de participante não altera isCancelled do evento", async () => {
    p.calendarEvent.upsert.mockResolvedValueOnce({ id: "ev1", isCancelled: false });
    await prismaM365Store.upsertCalendarEvent(
      "c2",
      {
        graphEventId: "g2",
        iCalUId: "ical-1",
        subject: "1:1",
        startAt: new Date(),
        endAt: new Date(),
        isAllDay: false,
        organizerEmail: "g@x.com",
        organizerName: null,
        attendees: [],
        categories: ["JumpFlow"],
        joinUrl: null,
        isCancelled: false,
        webLink: null,
        responseStatus: "accepted",
      },
      new Date(),
      false,
    );
    const ev = p.calendarEvent.upsert.mock.calls[0][0];
    expect(ev.update).not.toHaveProperty("isCancelled");
    expect(ev.create.isCancelled).toBe(false);
    expect(p.calendarEventSighting.upsert.mock.calls[0][0].create.categories).toEqual(["JumpFlow"]);
  });
});

describe("sugestões de horas", () => {
  const input = {
    consultantId: "cons-ana",
    calendarEventId: "ev1",
    date: new Date("2026-11-25T00:00:00Z"),
    startAt: new Date("2026-11-25T13:00:00Z"),
    endAt: new Date("2026-11-25T14:00:00Z"),
    minutes: 60,
    projectIds: ["p1"],
    matchKind: "EMAIL" as const,
  };

  it("DISMISSED é preservada (unchanged, sem update)", async () => {
    p.m365TimeSuggestion.findUnique.mockResolvedValueOnce({ status: "DISMISSED", projectIds: ["p2"], minutes: 30, date: input.date });
    expect(await prismaM365Store.upsertTimeSuggestion(input)).toBe("unchanged");
    expect(p.m365TimeSuggestion.update).not.toHaveBeenCalled();
  });

  it("mesmos projetos em outra ordem = unchanged", async () => {
    p.m365TimeSuggestion.findUnique.mockResolvedValueOnce({ status: "PENDING", projectIds: ["p1"], minutes: 60, date: input.date });
    expect(await prismaM365Store.upsertTimeSuggestion(input)).toBe("unchanged");
  });

  it("corrida na criação (P2002) → unchanged", async () => {
    p.m365TimeSuggestion.findUnique.mockResolvedValueOnce(null);
    p.m365TimeSuggestion.create.mockRejectedValueOnce(new h.PrismaClientKnownRequestError("P2002"));
    expect(await prismaM365Store.upsertTimeSuggestion(input)).toBe("unchanged");
  });

  it("nenhuma operação do store toca TimeEntry (nunca lança horas sozinho)", async () => {
    p.m365TimeSuggestion.findUnique.mockResolvedValueOnce(null);
    p.m365TimeSuggestion.create.mockResolvedValueOnce({});
    await prismaM365Store.upsertTimeSuggestion(input);
    expect(p.timeEntry.create).not.toHaveBeenCalled();
  });

  it("dismiss e leitura sempre escopados ao consultor dono", async () => {
    p.m365TimeSuggestion.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await dismissOwnSuggestion("cons-ana", "sug-de-outro")).toBe(false);
    expect(p.m365TimeSuggestion.updateMany.mock.calls[0][0].where).toEqual({ id: "sug-de-outro", consultantId: "cons-ana", status: "PENDING" });
    p.m365TimeSuggestion.findFirst.mockResolvedValueOnce(null);
    await getOwnPendingSuggestion("cons-ana", "s1");
    expect(p.m365TimeSuggestion.findFirst.mock.calls[0][0].where).toEqual({
      id: "s1",
      consultantId: "cons-ana",
      status: "PENDING",
      calendarEvent: { isCancelled: false },
    });
  });
});

describe("conexão do próprio usuário", () => {
  it("desconectar APAGA tokens, cursor e lease", async () => {
    p.m365Connection.findUnique.mockResolvedValueOnce({ id: "c1" });
    expect(await disconnectOwnConnection("u1")).toBe("c1");
    expect(p.m365Connection.update.mock.calls[0][0]).toEqual({
      where: { id: "c1" },
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
  });

  it("pausar só ACTIVE do próprio usuário; retomar só PAUSED", async () => {
    p.m365Connection.updateMany.mockResolvedValue({ count: 1 });
    await setOwnConnectionPaused("u1", true);
    await setOwnConnectionPaused("u1", false);
    expect(p.m365Connection.updateMany.mock.calls[0][0]).toEqual({ where: { userId: "u1", status: "ACTIVE" }, data: { status: "PAUSED" } });
    expect(p.m365Connection.updateMany.mock.calls[1][0]).toEqual({ where: { userId: "u1", status: "PAUSED" }, data: { status: "ACTIVE" } });
  });

  it("reconectar com outra conta Microsoft (graphUserId diferente) zera o cursor", async () => {
    p.m365Connection.findUnique.mockResolvedValueOnce({ id: "c1", graphUserId: "g-antigo" });
    await upsertM365Connection({
      userId: "u1",
      accessTokenEncrypted: "enc:a",
      refreshTokenEncrypted: "enc:r",
      expiresAt: new Date(),
      scopes: ["Calendars.Read"],
      tenantId: "t",
      graphUserId: "g-novo",
      mailbox: "u1@x.com",
    });
    expect(p.m365Connection.update.mock.calls[0][0].data).toMatchObject({
      status: "ACTIVE",
      calendarDeltaLink: null,
      calendarWindowStart: null,
      lastError: null,
    });
  });
});

describe("IntegrationEvent", () => {
  it("provider MICROSOFT_365, erro truncado e falha de log não derruba a operação", async () => {
    await logM365Event({ operation: "calendar.sync", status: "FAILED", error: "x".repeat(1000) });
    const data = p.integrationEvent.create.mock.calls[0][0].data;
    expect(data.provider).toBe("MICROSOFT_365");
    expect(data.error).toHaveLength(300);
    expect(data.requestMeta).toBe("__JsonNull__");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    p.integrationEvent.create.mockRejectedValueOnce(Object.assign(new Error("db down: Bearer AT-SECRETO"), { name: "PrismaError" }));
    await expect(logM365Event({ operation: "x", status: "SUCCESS" })).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("AT-SECRETO");
    spy.mockRestore();
  });
});

describe("correções M1 (validador) — escritas condicionadas e privado", () => {
  it("escritas da rodada exigem dono do lease + ACTIVE; sem lease, nunca DISCONNECTED/PAUSED", async () => {
    expect(guardedWhere("c1", { leaseOwner: "job:1" })).toEqual({ id: "c1", syncLeaseOwner: "job:1", status: "ACTIVE" });
    expect(guardedWhere("c1", null)).toEqual({ id: "c1", status: { notIn: ["DISCONNECTED", "PAUSED"] } });
    p.m365Connection.updateMany.mockResolvedValueOnce({ count: 0 });
    const ok = await prismaM365Store.saveTokens(
      "c1",
      { accessTokenEncrypted: "enc:a", refreshTokenEncrypted: "enc:r", expiresAt: new Date(), scopes: [] },
      { leaseOwner: "job:1" },
    );
    expect(ok).toBe(false);
    expect(p.m365Connection.update).not.toHaveBeenCalled();
    expect(p.m365Connection.updateMany.mock.calls[0][0].where).toEqual({ id: "c1", syncLeaseOwner: "job:1", status: "ACTIVE" });
  });

  it("evento privado sem Checkpoint é apagado; com Checkpoint, assunto/participantes limpos", async () => {
    p.checkpoint.count.mockResolvedValueOnce(0);
    expect(await prismaM365Store.redactCalendarEvent("ev1")).toBe("deleted");
    expect(p.calendarEvent.deleteMany).toHaveBeenCalledWith({ where: { id: "ev1" } });
    p.checkpoint.count.mockResolvedValueOnce(1);
    expect(await prismaM365Store.redactCalendarEvent("ev2")).toBe("redacted");
    expect(p.calendarEvent.update.mock.calls[0][0]).toMatchObject({
      where: { id: "ev2" },
      data: { subject: null, attendees: [], organizerName: null, joinUrl: null },
    });
  });
});
