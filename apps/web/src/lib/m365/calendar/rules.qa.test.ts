import { describe, expect, it } from "vitest";
import { PUBLIC_EMAIL_DOMAINS, configuredInternalDomains } from "../config";
import type { GraphEvent } from "../graph/types";
import { detectCheckpoint, isDisposableDraft, type DetectionInput } from "./detection";
import { normalizeGraphEvent, sanitizeJoinUrl } from "./normalize";
import { buildSuggestionPrefill } from "./prefill";
import { MAX_MINUTES, MIN_MINUTES, planTimeSuggestion, type SuggestionInput } from "./time-suggestions";

/**
 * QA (Fase M1) — regras puras: normalização (privacidade), detecção de
 * checkpoint, vínculo de sugestão de horas (limites) e pré-preenchimento.
 */

const baseEvent: GraphEvent = {
  id: "g1",
  iCalUId: "ical-1",
  subject: "1:1",
  start: { dateTime: "2026-11-25T13:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-25T13:30:00.0000000", timeZone: "UTC" },
  sensitivity: "normal",
  type: "singleInstance",
  organizer: { emailAddress: { address: "gestor@jump.com.br" } },
  attendees: [{ type: "required", emailAddress: { address: "ana@jump.com.br" } }],
};

describe("normalizeGraphEvent — privacidade e saneamento", () => {
  it("a saída só tem os campos permitidos (nada de body/bodyPreview/location/attachments)", () => {
    const r = normalizeGraphEvent({
      ...baseEvent,
      body: { content: "x" },
      bodyPreview: "x",
      location: { displayName: "x" },
      attachments: [],
    } as GraphEvent);
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(Object.keys(r.event).sort()).toEqual(
      [
        "attendees",
        "categories",
        "endAt",
        "graphEventId",
        "iCalUId",
        "isAllDay",
        "isCancelled",
        "joinUrl",
        "organizerEmail",
        "organizerName",
        "responseStatus",
        "startAt",
        "subject",
        "webLink",
      ].sort(),
    );
  });

  it.each(["PRIVATE", "Confidential", "PERSONAL"])("sensibilidade %s (qualquer caixa) é descartada", (sensitivity) => {
    expect(normalizeGraphEvent({ ...baseEvent, sensitivity })).toMatchObject({ kind: "skip", reason: "private" });
  });

  it("SeriesMaster com outra caixa também é descartada; exception/occurrence ficam", () => {
    expect(normalizeGraphEvent({ ...baseEvent, type: "SeriesMaster" })).toMatchObject({ reason: "series_master" });
    expect(normalizeGraphEvent({ ...baseEvent, type: "exception" }).kind).toBe("event");
    expect(normalizeGraphEvent({ ...baseEvent, type: "occurrence" }).kind).toBe("event");
  });

  it("fim antes do início e datas inválidas → invalid", () => {
    expect(normalizeGraphEvent({ ...baseEvent, end: { dateTime: "2026-11-25T12:00:00" } })).toMatchObject({ reason: "invalid" });
    expect(normalizeGraphEvent({ ...baseEvent, start: { dateTime: "ontem" } })).toMatchObject({ reason: "invalid" });
    expect(normalizeGraphEvent({ ...baseEvent, id: "" })).toMatchObject({ reason: "invalid" });
  });

  it.each([
    "https://teams.microsoft.com.evil.com/l/meetup-join/1",
    "https://evil.com/?u=https://teams.microsoft.com/",
    "javascript:alert(1)",
    "https://user:pass@evil.com@teams.microsoft.com.evil.com/",
    "ftp://teams.microsoft.com/x",
  ])("joinUrl %s é descartado", (url) => {
    expect(sanitizeJoinUrl(url)).toBeNull();
  });

  it("webLink fora de host Microsoft é descartado", () => {
    const r = normalizeGraphEvent({ ...baseEvent, webLink: "https://evil.com/owa" });
    expect(r.kind === "event" && r.event.webLink).toBeNull();
    const ok = normalizeGraphEvent({ ...baseEvent, webLink: "https://outlook.office365.com/owa/?itemid=1" });
    expect(ok.kind === "event" && ok.event.webLink).toContain("outlook.office365.com");
  });

  it("assunto é truncado em 500 caracteres; vazio vira null", () => {
    const long = normalizeGraphEvent({ ...baseEvent, subject: "x".repeat(900) });
    expect(long.kind === "event" && long.event.subject?.length).toBe(500);
    const empty = normalizeGraphEvent({ ...baseEvent, subject: "   " });
    expect(empty.kind === "event" && empty.event.subject).toBeNull();
  });

  it("participante sem e-mail válido é ignorado", () => {
    const r = normalizeGraphEvent({
      ...baseEvent,
      attendees: [{ emailAddress: { address: "sem-arroba" } }, { emailAddress: null }, { emailAddress: { address: "ok@x.com" } }],
    });
    expect(r.kind === "event" && r.event.attendees.map((a) => a.email)).toEqual(["ok@x.com"]);
  });
});

describe("detectCheckpoint — bordas", () => {
  const mk = (o: Partial<DetectionInput["event"]> = {}, extra: Partial<DetectionInput> = {}): DetectionInput => ({
    event: {
      subject: "1:1 Ana",
      organizerEmail: "gestor@jump.com.br",
      attendees: [{ email: "ana@jump.com.br", name: null, type: "required", response: null }],
      categories: [],
      isCancelled: false,
      ...o,
    },
    managerEmails: ["gestor@jump.com.br"],
    consultantIdByEmail: new Map([
      ["ana@jump.com.br", "c-ana"],
      ["bruno@jump.com.br", "c-bruno"],
    ]),
    inScopeConsultantIds: new Set(["c-ana", "c-bruno"]),
    ...extra,
  });

  it("organizador comparado sem diferenciar maiúsculas", () => {
    expect(detectCheckpoint(mk({ organizerEmail: "GESTOR@jump.com.br" }), )).toMatchObject({ kind: "checkpoint" });
    expect(detectCheckpoint(mk({}, { managerEmails: ["Gestor@Jump.com.br"] }))).toMatchObject({ kind: "checkpoint" });
  });

  it("sem organizador → not_organizer", () => {
    expect(detectCheckpoint(mk({ organizerEmail: null }))).toEqual({ kind: "skip", reason: "not_organizer" });
  });

  it("sem nenhum consultor (só externos) → consultant_count", () => {
    expect(
      detectCheckpoint(mk({ attendees: [{ email: "cliente@acme.com", name: null, type: "required", response: null }] })),
    ).toEqual({ kind: "skip", reason: "consultant_count" });
  });

  it("assunto null com categoria JumpFlow → CHECKPOINT", () => {
    expect(detectCheckpoint(mk({ subject: null, categories: ["JumpFlow"] }))).toMatchObject({ type: "CHECKPOINT" });
  });

  it("cancelado tem precedência sobre todo o resto", () => {
    expect(detectCheckpoint(mk({ isCancelled: true, organizerEmail: "x@y.com" }))).toEqual({ kind: "skip", reason: "cancelled" });
  });

  // ACHADO (menor): a regex da especificação não tem fronteira de palavra; um
  // horário no assunto ("Daily 11:15", "Sync 21:10") contém "1:1" e vira
  // rascunho ONE_ON_ONE quando há um único consultor no escopo.
  it("CORRIGIDO: horário no assunto ('Daily 11:15') não deveria ser 1:1", () => {
    expect(detectCheckpoint(mk({ subject: "Daily 11:15" }))).toEqual({ kind: "skip", reason: "no_signal" });
  });
});

describe("isDisposableDraft — bordas", () => {
  const empty = { status: "DRAFT", notes: null, transcription: null, audioStorageKey: null };
  it("notas/transcrição só com espaços contam como vazias; ARCHIVED/RECORDED nunca", () => {
    expect(isDisposableDraft({ ...empty, notes: "   " })).toBe(true);
    expect(isDisposableDraft({ ...empty, transcription: "\n" })).toBe(true);
    expect(isDisposableDraft({ ...empty, transcription: "texto" })).toBe(false);
    expect(isDisposableDraft({ ...empty, status: "ARCHIVED" })).toBe(false);
  });
});

describe("planTimeSuggestion — limites", () => {
  const now = new Date("2026-11-26T15:00:00Z");
  const mk = (o: Partial<SuggestionInput["event"]> = {}, extra: Partial<SuggestionInput> = {}): SuggestionInput => ({
    event: {
      startAt: new Date("2026-11-25T13:00:00Z"),
      endAt: new Date("2026-11-25T14:00:00Z"),
      isAllDay: false,
      isCancelled: false,
      organizerEmail: "ana@jump.com.br",
      attendees: [{ email: "joao@acme.com", name: null, type: "required", response: null }],
      ...o,
    },
    responseStatus: "accepted",
    allocations: [{ projectId: "p1", clientEmails: ["joao@acme.com"] }],
    internalDomains: new Set(["jump.com.br"]),
    publicDomains: PUBLIC_EMAIL_DOMAINS,
    now,
    ...extra,
  });
  const at = (startIso: string, minutes: number) => ({
    startAt: new Date(startIso),
    endAt: new Date(new Date(startIso).getTime() + minutes * 60_000),
  });

  it(`duração: ${MIN_MINUTES} e ${MAX_MINUTES} min sugerem; ${MIN_MINUTES - 1} e ${MAX_MINUTES + 1} não`, () => {
    expect(planTimeSuggestion(mk(at("2026-11-25T13:00:00Z", MIN_MINUTES)))?.minutes).toBe(MIN_MINUTES);
    expect(planTimeSuggestion(mk(at("2026-11-25T13:00:00Z", MIN_MINUTES - 1)))).toBeNull();
    expect(planTimeSuggestion(mk(at("2026-11-25T00:00:00Z", MAX_MINUTES)))?.minutes).toBe(MAX_MINUTES);
    expect(planTimeSuggestion(mk(at("2026-11-25T00:00:00Z", MAX_MINUTES + 1)))).toBeNull();
  });

  it("janela de 7 dias: termina exatamente agora ou exatamente há 7 dias → sugere; 1 ms além → não", () => {
    expect(planTimeSuggestion(mk({ startAt: new Date(now.getTime() - 3_600_000), endAt: now }))).not.toBeNull();
    const sevenDays = new Date(now.getTime() - 7 * 86_400_000);
    expect(planTimeSuggestion(mk({ startAt: new Date(sevenDays.getTime() - 3_600_000), endAt: sevenDays }))).not.toBeNull();
    const beyond = new Date(sevenDays.getTime() - 1);
    expect(planTimeSuggestion(mk({ startAt: new Date(beyond.getTime() - 3_600_000), endAt: beyond }))).toBeNull();
    expect(planTimeSuggestion(mk({ startAt: new Date(now.getTime() - 60_000), endAt: new Date(now.getTime() + 1) }))).toBeNull();
  });

  it("sala (resource) externa não conta como participante", () => {
    expect(
      planTimeSuggestion(mk({ attendees: [{ email: "sala@acme.com", name: null, type: "resource", response: null }] })),
    ).toBeNull();
  });

  it("e-mails com caixa/espaço diferentes ainda casam; contato inválido é ignorado", () => {
    expect(
      planTimeSuggestion(mk({ attendees: [{ email: "Joao@ACME.com", name: null, type: "required", response: null }] }, {
        allocations: [{ projectId: "p1", clientEmails: [" JOAO@acme.com ", "sem-arroba"] }],
      })),
    ).toMatchObject({ projectIds: ["p1"], matchKind: "EMAIL" });
  });

  it("subdomínio do cliente não casa por domínio (conservador)", () => {
    expect(
      planTimeSuggestion(mk({ attendees: [{ email: "x@br.acme.com", name: null, type: "required", response: null }] })),
    ).toBeNull();
  });

  it.each(["hotmail.com", "outlook.com.br", "yahoo.com.br", "icloud.com", "uol.com.br"])(
    "domínio público %s nunca conta, nem com e-mail exato cadastrado no cliente",
    (domain) => {
      const email = `cliente@${domain}`;
      expect(
        planTimeSuggestion(mk({ attendees: [{ email, name: null, type: "required", response: null }] }, {
          allocations: [{ projectId: "p1", clientEmails: [email] }],
        })),
      ).toBeNull();
    },
  );

  it("projetos ordenados e sem duplicar quando há vários contatos do mesmo projeto", () => {
    expect(
      planTimeSuggestion(mk({ attendees: [
        { email: "a@acme.com", name: null, type: "required", response: null },
        { email: "b@acme.com", name: null, type: "required", response: null },
      ] }, {
        allocations: [
          { projectId: "p2", clientEmails: ["a@acme.com", "b@acme.com"] },
          { projectId: "p1", clientEmails: ["b@acme.com"] },
        ],
      })),
    ).toEqual({ projectIds: ["p1", "p2"], matchKind: "EMAIL", minutes: 60 });
  });
});

describe("configuredInternalDomains", () => {
  it("normaliza lista com @, espaços e maiúsculas", () => {
    expect(configuredInternalDomains({ M365_INTERNAL_DOMAINS: " @Jump.com.br, jump.tec.br ,," } as unknown as NodeJS.ProcessEnv)).toEqual([
      "jump.com.br",
      "jump.tec.br",
    ]);
    expect(configuredInternalDomains({} as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("buildSuggestionPrefill — bordas", () => {
  const s = {
    startAt: new Date("2026-11-25T23:00:00Z"), // 20:00 em SP
    endAt: new Date("2026-11-26T04:00:00Z"), // 01:00 do dia seguinte em SP
    projectIds: ["p1"],
    subject: "x".repeat(400),
  };

  it("reunião que cruza a meia-noite local termina às 23:59 do dia de início", () => {
    const p = buildSuggestionPrefill(s, null, new Set(["p1"]));
    expect(p).toMatchObject({ date: "2026-11-25", clock: { startTime: "20:00", endTime: "23:59", hasBreak: false } });
  });

  it("descrição limitada a 200 caracteres; sem assunto vira 'Reunião'", () => {
    expect(buildSuggestionPrefill(s, "p1", new Set(["p1"]))!.description).toHaveLength(200);
    expect(buildSuggestionPrefill({ ...s, subject: null }, "p1", new Set(["p1"]))!.description).toBe("Reunião");
  });

  it("projeto da query que não está entre os candidatos não é aceito, mesmo se permitido ao consultor", () => {
    expect(buildSuggestionPrefill(s, "p-outro", new Set(["p1", "p-outro"]))).toBeNull();
  });

  it("dois candidatos, um deles não permitido mais → escolhe o restante sozinho", () => {
    expect(buildSuggestionPrefill({ ...s, projectIds: ["p1", "p2"] }, null, new Set(["p2"]))?.projectId).toBe("p2");
  });
});
