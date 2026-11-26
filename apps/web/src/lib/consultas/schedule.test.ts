import { describe, expect, it } from "vitest";
import {
  describeTiming,
  dueOccurrence,
  firesOn,
  latestOccurrence,
  nextOccurrence,
  normalizeTiming,
  runStatus,
  scheduleInputSchema,
  zonedInstant,
  zonedParts,
  type ScheduleTiming,
} from "./schedule";

const daily: ScheduleTiming = { frequency: "DAILY", hour: 8 };
const weeklyMonday: ScheduleTiming = { frequency: "WEEKLY", hour: 8, weekday: 1 };
const monthly31: ScheduleTiming = { frequency: "MONTHLY", hour: 7, monthDay: 31 };

describe("agendamento: fuso de São Paulo (via Intl, sem offset fixo)", () => {
  it("08:00 em SP = 11:00Z; partes de parede corretas na virada do dia UTC", () => {
    expect(zonedInstant("2026-11-26", 8).toISOString()).toBe("2026-11-26T11:00:00.000Z");
    expect(zonedInstant("2026-01-01", 0).toISOString()).toBe("2026-01-01T03:00:00.000Z");
    // 01:30Z do dia 27 ainda é 22:30 do dia 26 em SP.
    expect(zonedParts(new Date("2026-11-27T01:30:00Z"))).toMatchObject({ year: 2026, month: 11, day: 26, hour: 22 });
  });

  it("respeita horário de verão histórico (2018: SP em UTC−2)", () => {
    // 2018-12-01 estava em horário de verão: 08:00 local = 10:00Z.
    expect(zonedInstant("2018-12-01", 8).toISOString()).toBe("2018-12-01T10:00:00.000Z");
  });
});

describe("agendamento: ocorrências e janela", () => {
  it("diário: antes das 08:00 de SP a janela é a de ontem; depois, a de hoje", () => {
    expect(latestOccurrence(daily, new Date("2026-11-26T10:59:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-25");
    expect(latestOccurrence(daily, new Date("2026-11-26T11:00:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-26");
    expect(nextOccurrence(daily, new Date("2026-11-26T11:00:00Z"))?.at.toISOString()).toBe("2026-11-27T11:00:00.000Z");
  });

  it("23h UTC de domingo ainda é domingo em SP (não dispara a de segunda)", () => {
    // 2026-11-30 é segunda. Domingo 29/11 23:00Z = 20:00 SP de domingo.
    expect(latestOccurrence(weeklyMonday, new Date("2026-11-29T23:00:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-23");
    expect(latestOccurrence(weeklyMonday, new Date("2026-11-30T11:05:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-30");
  });

  it("mensal dia 31: meses curtos usam o último dia; janela = mês", () => {
    expect(firesOn(monthly31, "2027-02-28")).toBe(true);
    expect(firesOn(monthly31, "2028-02-29")).toBe(true);
    expect(firesOn(monthly31, "2028-02-28")).toBe(false);
    expect(firesOn(monthly31, "2026-11-30")).toBe(true);
    expect(latestOccurrence(monthly31, new Date("2026-12-15T12:00:00Z"))?.windowKey.slice(0, 7)).toBe("2026-11");
    expect(latestOccurrence(monthly31, new Date("2026-12-31T10:00:00Z"))?.windowKey.slice(0, 7)).toBe("2026-12");
  });

  it("não envia ocorrência anterior a activeSince (criação/reativação/mudança de horário)", () => {
    const now = new Date("2026-11-26T12:00:00Z");
    expect(dueOccurrence(daily, new Date("2026-11-26T11:30:00Z"), now)).toBeNull();
    expect(dueOccurrence(daily, new Date("2026-11-26T10:00:00Z"), now)?.windowKey.slice(0, 10)).toBe("2026-11-26");
    // Atraso do job: ainda envia a mais recente (uma só).
    expect(dueOccurrence(daily, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-28T15:00:00Z"))?.windowKey).toBe(
      "2026-11-28T08",
    );
  });

  it("janela = ocorrência efetiva (data + hora): mudar dia/hora gera nova janela", () => {
    expect(latestOccurrence(daily, new Date("2026-11-26T12:00:00Z"))?.windowKey).toBe("2026-11-26T08");
    expect(latestOccurrence({ ...daily, hour: 9 }, new Date("2026-11-26T12:30:00Z"))?.windowKey).toBe("2026-11-26T09");
    expect(latestOccurrence({ frequency: "MONTHLY", hour: 8, monthDay: 5 }, new Date("2026-11-20T12:00:00Z"))?.windowKey).toBe("2026-11-05T08");
    expect(latestOccurrence({ frequency: "MONTHLY", hour: 8, monthDay: 20 }, new Date("2026-11-20T12:00:00Z"))?.windowKey).toBe("2026-11-20T08");
  });

  it("normaliza campos que não valem para a frequência", () => {
    expect(normalizeTiming({ frequency: "DAILY", hour: 9, weekday: 3, monthDay: 5 })).toEqual({
      frequency: "DAILY",
      hour: 9,
      weekday: null,
      monthDay: null,
    });
  });

  it("descreve em PT-BR", () => {
    expect(describeTiming(daily)).toBe("Todos os dias às 08:00");
    expect(describeTiming(weeklyMonday)).toBe("Toda segunda-feira às 08:00");
    expect(describeTiming({ frequency: "WEEKLY", hour: 18, weekday: 6 })).toBe("Todo sábado às 18:00");
    expect(describeTiming(monthly31)).toBe("Todo dia 31 às 07:00 (ou o último dia do mês)");
  });
});

describe("agendamento: entrada e status", () => {
  const base = {
    name: "Horas",
    target: { kind: "view", id: "v1" },
    frequency: "WEEKLY",
    hour: 8,
    weekday: 1,
    recipientUserIds: ["u1", "u2"],
    active: true,
  };

  it("aceita entrada válida e recusa e-mail livre, repetidos, semanal sem dia e chaves extras", () => {
    expect(scheduleInputSchema.safeParse(base).success).toBe(true);
    expect(scheduleInputSchema.safeParse({ ...base, recipientUserIds: ["fulano@externo.com"] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, recipientUserIds: ["u1", "u1"] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, weekday: null }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, frequency: "MONTHLY" }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, emails: ["x@y.z"] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, hour: 24 }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, recipientUserIds: [] }).success).toBe(false);
    expect(
      scheduleInputSchema.safeParse({ ...base, recipientUserIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }).success,
    ).toBe(false);
  });

  it("nome (vai ao assunto do e-mail): recusa quebras de linha e caracteres de controle", () => {
    for (const name of ["Horas\r\nBcc: x@y.z", "Horas\nX", "Horas\tX", "Horas\u0000", "Horas\u2028X", "Horas\u0085X"]) {
      expect(scheduleInputSchema.safeParse({ ...base, name }).success).toBe(false);
    }
    expect(scheduleInputSchema.safeParse({ ...base, name: "Horas — semana (SP) · R$" }).success).toBe(true);
  });

  it("status do run", () => {
    expect(runStatus([{ userId: "a", status: "SENT", sheets: 1 }])).toBe("SENT");
    expect(
      runStatus([
        { userId: "a", status: "SENT", sheets: 1 },
        { userId: "b", status: "SKIPPED", reason: "sem_acesso_visao" },
      ]),
    ).toBe("PARTIAL");
    expect(runStatus([{ userId: "b", status: "SKIPPED", reason: "sem_acesso_visao" }])).toBe("SKIPPED");
    expect(
      runStatus([
        { userId: "a", status: "SENT", sheets: 1 },
        { userId: "c", status: "FAILED", error: "x" },
      ]),
    ).toBe("FAILED");
  });
});

describe("e-mail agendado: assunto em linha única (defesa em profundidade)", () => {
  it("nome legado com CRLF não injeta cabeçalho", async () => {
    const { buildConsultaAgendadaEmail } = await import("@/lib/automation/email/templates");
    const email = buildConsultaAgendadaEmail({
      scheduleName: "Horas\r\nBcc: atacante@x.com\u2028Y",
      targetKind: "view",
      targetName: "Visão",
      timing: "Todos os dias às 08:00",
      sheetCount: 1,
      hiddenViews: 0,
      truncated: false,
      link: null,
    });
    expect(email.subject).not.toMatch(/[\r\n\u2028]/);
    expect(email.subject).toContain("Horas Bcc: atacante@x.com Y");
  });
});
