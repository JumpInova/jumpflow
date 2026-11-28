import { describe, expect, it } from "vitest";
import { PUBLIC_EMAIL_DOMAINS } from "../config";
import type { GraphEvent } from "../graph/types";
import { detectCheckpoint, draftRescheduleChange, isDisposableDraft, type DetectionInput } from "./detection";
import { normalizeGraphEvent, parseGraphUtc, sanitizeJoinUrl } from "./normalize";
import { buildSuggestionPrefill } from "./prefill";
import { localDateAsUtcMidnight } from "./time";
import { planTimeSuggestion, type SuggestionInput } from "./time-suggestions";

const base: GraphEvent = {
  id: "g1",
  iCalUId: "ical-1",
  subject: "  1:1 Ana  ",
  start: { dateTime: "2026-11-25T13:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-25T13:30:00.0000000", timeZone: "UTC" },
  sensitivity: "normal",
  type: "occurrence",
  organizer: { emailAddress: { address: "Gestor@Jump.com.br", name: "Gestor" } },
  attendees: [
    { type: "required", emailAddress: { address: "ANA@jump.com.br", name: "Ana" } },
    { type: "required", emailAddress: { address: "ana@jump.com.br" } },
    { type: "resource", emailAddress: { address: "sala@jump.com.br" } },
  ],
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/1" },
};

describe("normalizeGraphEvent", () => {
  it("normaliza datas UTC, e-mails, dedup de participantes e mantém joinUrl do Teams", () => {
    const r = normalizeGraphEvent({ ...base, body: { content: "x" } } as GraphEvent);
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(r.event.startAt.toISOString()).toBe("2026-11-25T13:00:00.000Z");
    expect(r.event.subject).toBe("1:1 Ana");
    expect(r.event.organizerEmail).toBe("gestor@jump.com.br");
    expect(r.event.attendees.map((a) => a.email)).toEqual(["ana@jump.com.br", "sala@jump.com.br"]);
    expect(r.event.joinUrl).toBe("https://teams.microsoft.com/l/meetup-join/1");
    expect(JSON.stringify(r.event)).not.toContain("content");
  });

  it("descarta privados/confidenciais/pessoais e series master; @removed vira removed", () => {
    for (const sensitivity of ["private", "confidential", "personal"]) {
      expect(normalizeGraphEvent({ ...base, sensitivity })).toEqual({
        kind: "skip",
        graphEventId: "g1",
        reason: "private",
        organizerEmail: "gestor@jump.com.br",
        iCalUId: base.iCalUId,
      });
    }
    expect(normalizeGraphEvent({ ...base, type: "seriesMaster" })).toMatchObject({ reason: "series_master" });
    expect(normalizeGraphEvent({ id: "g9", "@removed": { reason: "deleted" } })).toEqual({ kind: "removed", graphEventId: "g9" });
    expect(normalizeGraphEvent({ ...base, iCalUId: null })).toMatchObject({ reason: "invalid" });
  });

  it("joinUrl de host não permitido ou http é descartado", () => {
    expect(sanitizeJoinUrl("https://evil.com/teams.microsoft.com")).toBeNull();
    expect(sanitizeJoinUrl("http://teams.microsoft.com/l/x")).toBeNull();
    expect(sanitizeJoinUrl("https://teams.microsoft.com/l/x")).not.toBeNull();
  });

  it("parseGraphUtc trata 7 casas decimais e offset explícito", () => {
    expect(parseGraphUtc("2026-01-01T10:00:00.1234567")?.toISOString()).toBe("2026-01-01T10:00:00.123Z");
    expect(parseGraphUtc("2026-01-01T10:00:00-03:00")?.toISOString()).toBe("2026-01-01T13:00:00.000Z");
    expect(parseGraphUtc("lixo")).toBeNull();
  });
});

describe("detectCheckpoint", () => {
  const input = (o: Partial<DetectionInput["event"]> = {}, inScope = ["c-ana"]): DetectionInput => ({
    event: {
      subject: "1:1 Ana",
      organizerEmail: "gestor@jump.com.br",
      attendees: [
        { email: "ana@jump.com.br", name: null, type: "required", response: null },
        { email: "gestor@jump.com.br", name: null, type: "required", response: null },
        { email: "sala@jump.com.br", name: null, type: "resource", response: null },
      ],
      categories: [],
      isCancelled: false,
      ...o,
    },
    managerEmails: ["gestor@jump.com.br"],
    consultantIdByEmail: new Map([
      ["ana@jump.com.br", "c-ana"],
      ["bruno@jump.com.br", "c-bruno"],
      ["gestor@jump.com.br", "c-gestor"],
      ["sala@jump.com.br", "c-sala"],
    ]),
    inScopeConsultantIds: new Set(inScope),
  });

  it.each([
    ["1:1 Ana", "ONE_ON_ONE"],
    ["One on One - Ana", "ONE_ON_ONE"],
    ["1-on-1 mensal", "ONE_ON_ONE"],
    ["Ana 1on1", "ONE_ON_ONE"],
    ["Checkpoint quinzenal", "CHECKPOINT"],
    ["Check-in de projeto", "CHECKPOINT"],
  ])("assunto %s → %s", (subject, type) => {
    expect(detectCheckpoint(input({ subject }))).toEqual({ kind: "checkpoint", consultantId: "c-ana", type });
  });

  it("categoria JumpFlow vale sem assunto casando", () => {
    expect(detectCheckpoint(input({ subject: "Conversa", categories: ["jumpflow"] }))).toMatchObject({ type: "CHECKPOINT" });
    expect(detectCheckpoint(input({ subject: "Conversa" }))).toEqual({ kind: "skip", reason: "no_signal" });
  });

  it("exige organizador = gestor, exatamente um consultor e escopo", () => {
    expect(detectCheckpoint(input({ organizerEmail: "outro@jump.com.br" }))).toEqual({ kind: "skip", reason: "not_organizer" });
    expect(
      detectCheckpoint(
        input({ attendees: [
          { email: "ana@jump.com.br", name: null, type: "required", response: null },
          { email: "bruno@jump.com.br", name: null, type: "optional", response: null },
        ] }),
      ),
    ).toEqual({ kind: "skip", reason: "consultant_count" });
    expect(detectCheckpoint(input({}, ["c-bruno"]))).toEqual({ kind: "skip", reason: "out_of_scope" });
    expect(detectCheckpoint(input({ isCancelled: true }))).toEqual({ kind: "skip", reason: "cancelled" });
  });

  it("rascunho descartável = DRAFT sem conteúdo", () => {
    const empty = { status: "DRAFT", notes: null, transcription: null, audioStorageKey: null };
    expect(isDisposableDraft(empty)).toBe(true);
    expect(isDisposableDraft({ ...empty, notes: "x" })).toBe(false);
    expect(isDisposableDraft({ ...empty, audioStorageKey: "k" })).toBe(false);
    expect(isDisposableDraft({ ...empty, status: "RECORDED" })).toBe(false);
  });
});

describe("planTimeSuggestion", () => {
  const now = new Date("2026-11-26T15:00:00Z");
  const mk = (attendees: string[], o: Partial<SuggestionInput> = {}): SuggestionInput => ({
    event: {
      startAt: new Date("2026-11-25T13:00:00Z"),
      endAt: new Date("2026-11-25T14:00:00Z"),
      isAllDay: false,
      isCancelled: false,
      organizerEmail: "ana@jump.com.br",
      attendees: attendees.map((email) => ({ email, name: null, type: "required", response: null })),
    },
    responseStatus: "accepted",
    allocations: [
      { projectId: "p1", clientEmails: ["joao@acme.com", "financeiro@gmail.com"] },
      { projectId: "p2", clientEmails: ["maria@acme.com"] },
      { projectId: "p3", clientEmails: ["x@beta.com"] },
    ],
    internalDomains: new Set(["jump.com.br"]),
    publicDomains: PUBLIC_EMAIL_DOMAINS,
    now,
    ...o,
  });

  it("e-mail exato vence domínio", () => {
    expect(planTimeSuggestion(mk(["joao@acme.com"]))).toEqual({ projectIds: ["p1"], matchKind: "EMAIL", minutes: 60 });
  });

  it("domínio com mais de um projeto → todos (o consultor escolhe)", () => {
    expect(planTimeSuggestion(mk(["novo@acme.com"]))).toEqual({ projectIds: ["p1", "p2"], matchKind: "DOMAIN", minutes: 60 });
  });

  it("domínio público e interno não contam", () => {
    expect(planTimeSuggestion(mk(["financeiro@gmail.com"]))).toBeNull();
    expect(planTimeSuggestion(mk(["colega@jump.com.br"]))).toBeNull();
  });

  it("evento futuro, antigo, cancelado, dia inteiro, recusado ou longo demais não sugere", () => {
    expect(planTimeSuggestion(mk(["joao@acme.com"], { now: new Date("2026-11-25T13:30:00Z") }))).toBeNull();
    expect(planTimeSuggestion(mk(["joao@acme.com"], { now: new Date("2026-12-05T00:00:00Z") }))).toBeNull();
    expect(planTimeSuggestion(mk(["joao@acme.com"], { responseStatus: "declined" }))).toBeNull();
    const e = mk(["joao@acme.com"]);
    expect(planTimeSuggestion({ ...e, event: { ...e.event, isCancelled: true } })).toBeNull();
    expect(planTimeSuggestion({ ...e, event: { ...e.event, isAllDay: true } })).toBeNull();
    expect(planTimeSuggestion({ ...e, event: { ...e.event, startAt: new Date("2026-11-24T00:00:00Z") } })).toBeNull();
  });

  it("sem alocação que case → null", () => {
    expect(planTimeSuggestion(mk(["joao@acme.com"], { allocations: [] }))).toBeNull();
  });
});

describe("prefill e datas locais", () => {
  it("data-calendário em America/Sao_Paulo (evento 01:00Z cai no dia anterior)", () => {
    expect(localDateAsUtcMidnight(new Date("2026-11-26T01:00:00Z")).toISOString()).toBe("2026-11-25T00:00:00.000Z");
  });

  it("pré-preenche projeto escolhido, data e horário local; recusa projeto fora dos candidatos", () => {
    const s = {
      startAt: new Date("2026-11-25T13:00:00Z"),
      endAt: new Date("2026-11-25T14:30:00Z"),
      projectIds: ["p1", "p2"],
      subject: "Kickoff ACME",
    };
    const allowed = new Set(["p1", "p2"]);
    expect(buildSuggestionPrefill(s, "p2", allowed)).toEqual({
      projectId: "p2",
      date: "2026-11-25",
      clock: { startTime: "10:00", endTime: "11:30", breakStart: "", breakEnd: "", hasBreak: false },
      description: "Reunião: Kickoff ACME",
    });
    expect(buildSuggestionPrefill(s, null, allowed)).toBeNull();
    expect(buildSuggestionPrefill(s, "p9", allowed)).toBeNull();
    expect(buildSuggestionPrefill(s, "p1", new Set(["p2"]))).toBeNull();
    expect(buildSuggestionPrefill({ ...s, projectIds: ["p1"] }, null, allowed)?.projectId).toBe("p1");
  });
});

describe("correções M1 — regex com fronteiras e remarcação", () => {
  const mk = (subject: string) => ({
    event: {
      subject,
      organizerEmail: "g@jump.com.br",
      attendees: [{ email: "ana@jump.com.br", name: null, type: "required", response: null }],
      categories: [],
      isCancelled: false,
    },
    managerEmails: ["g@jump.com.br"],
    consultantIdByEmail: new Map([["ana@jump.com.br", "c-ana"]]),
    inScopeConsultantIds: new Set(["c-ana"]),
  });

  it.each(["Daily 11:15", "Sync 21:10", "Call 1:10", "Checkpoints do squad", "precheck-in"])("%s não casa", (subject) => {
    expect(detectCheckpoint(mk(subject))).toEqual({ kind: "skip", reason: "no_signal" });
  });

  it.each([
    ["(1:1) Ana", "ONE_ON_ONE"],
    ["Ana - 1:1", "ONE_ON_ONE"],
    ["[Checkpoint] Ana", "CHECKPOINT"],
  ])("%s → %s", (subject, type) => {
    expect(detectCheckpoint(mk(subject))).toMatchObject({ kind: "checkpoint", type });
  });

  const draft = {
    status: "DRAFT",
    occurredAt: new Date("2026-11-27T13:00:00Z"),
    title: "1:1 Ana",
    notes: null as string | null,
    transcription: null as string | null,
    audioStorageKey: null as string | null,
  };
  const moved = { occurredAt: new Date("2026-12-03T13:00:00Z"), title: "1:1 Ana (dez)" };

  it("DRAFT sem conteúdo acompanha data e título", () => {
    expect(draftRescheduleChange(draft, moved)).toEqual(moved);
  });

  it("DRAFT com conteúdo acompanha só a data; título é do gestor", () => {
    expect(draftRescheduleChange({ ...draft, notes: "pauta" }, moved)).toEqual({ occurredAt: moved.occurredAt });
  });

  it("não-DRAFT nunca muda; nada mudou → null", () => {
    expect(draftRescheduleChange({ ...draft, status: "RECORDED" }, moved)).toBeNull();
    expect(draftRescheduleChange(draft, { occurredAt: draft.occurredAt, title: draft.title })).toBeNull();
  });
});
