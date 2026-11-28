import { describe, expect, it } from "vitest";
import {
  dueOccurrence,
  firesOn,
  latestOccurrence,
  nextOccurrence,
  runStatus,
  scheduleInputSchema,
  zonedInstant,
  zonedParts,
  type ScheduleTiming,
} from "./schedule";

/**
 * Fase C3 (testador): janela e horário do envio agendado em America/Sao_Paulo
 * — virada de mês, dia 31 em mês de 30, fevereiro, semanal, horas extremas
 * (00h/23h, que caem em outro dia UTC) e entrada do formulário.
 */

const daily = (hour: number): ScheduleTiming => ({ frequency: "DAILY", hour });
const weekly = (weekday: number, hour: number): ScheduleTiming => ({ frequency: "WEEKLY", hour, weekday });
const monthly = (monthDay: number, hour: number): ScheduleTiming => ({ frequency: "MONTHLY", hour, monthDay });
const at = (iso: string) => new Date(iso);
const LONG_AGO = at("2020-01-01T00:00:00Z");

describe("horário em São Paulo (sem UTC−3 fixo no código, mas hoje = UTC−3)", () => {
  it("23:00 de SP cai no dia seguinte em UTC; a janela é o dia de SP", () => {
    expect(zonedInstant("2026-11-26", 23).toISOString()).toBe("2026-11-27T02:00:00.000Z");
    // 02:30Z do dia 27 = 23:30 do dia 26 em SP → janela 26.
    expect(latestOccurrence(daily(23), at("2026-11-27T02:30:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-26");
    // 01:59Z do dia 27 = 22:59 do dia 26 → ainda vale a do dia 25.
    expect(latestOccurrence(daily(23), at("2026-11-27T01:59:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-25");
  });

  it("00:00 de SP = 03:00Z; às 02:59Z ainda é o dia anterior em SP", () => {
    expect(zonedInstant("2026-11-26", 0).toISOString()).toBe("2026-11-26T03:00:00.000Z");
    expect(latestOccurrence(daily(0), at("2026-11-26T02:59:59Z"))?.windowKey.slice(0, 10)).toBe("2026-11-25");
    expect(latestOccurrence(daily(0), at("2026-11-26T03:00:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-26");
    expect(zonedParts(at("2026-11-26T02:59:59Z"))).toMatchObject({ day: 25, hour: 23 });
  });

  it("exatamente na hora conta como vencida (≤ now); um ms antes não", () => {
    const exact = zonedInstant("2026-11-26", 8);
    expect(latestOccurrence(daily(8), exact)?.windowKey.slice(0, 10)).toBe("2026-11-26");
    expect(latestOccurrence(daily(8), new Date(exact.getTime() - 1))?.windowKey.slice(0, 10)).toBe("2026-11-25");
  });
});

describe("mensal: virada de mês, dia 31 e fevereiro", () => {
  it("dia 31 em novembro (30 dias) dispara no dia 30; janela = mês", () => {
    expect(firesOn(monthly(31, 8), "2026-11-30")).toBe(true);
    expect(firesOn(monthly(31, 8), "2026-11-29")).toBe(false);
    expect(firesOn(monthly(31, 8), "2026-12-31")).toBe(true);
    expect(firesOn(monthly(31, 8), "2026-12-30")).toBe(false);
    expect((latestOccurrence(monthly(31, 8), at("2026-11-30T12:00:00Z")))?.windowKey.slice(0, 7)).toBe("2026-11");
  });

  it("dia 30/31 em fevereiro: dia 28 (2027) e 29 (2028, bissexto)", () => {
    expect(firesOn(monthly(30, 8), "2027-02-28")).toBe(true);
    expect(firesOn(monthly(31, 8), "2028-02-29")).toBe(true);
    expect(firesOn(monthly(31, 8), "2028-02-28")).toBe(false);
    expect(firesOn(monthly(29, 8), "2027-02-28")).toBe(true);
  });

  it("virada de mês no fuso: 30/11 22h SP = 01/12 01h UTC → janela de NOVEMBRO", () => {
    const timing = monthly(31, 22);
    const occurrence = latestOccurrence(timing, at("2026-12-01T01:30:00Z"));
    expect((occurrence)?.windowKey.slice(0, 7)).toBe("2026-11");
    expect(occurrence?.at.toISOString()).toBe("2026-12-01T01:00:00.000Z");
    // Uma hora antes (21:30 SP do dia 30) ainda não venceu a de novembro → a de outubro.
    expect(latestOccurrence(timing, at("2026-12-01T00:30:00Z"))?.windowKey.slice(0, 7)).toBe("2026-10");
  });

  it("dia 1 às 00h: 01/12 00:00 SP = 01/12 03:00Z; às 02:00Z de 01/12 ainda vale novembro", () => {
    const timing = monthly(1, 0);
    expect(latestOccurrence(timing, at("2026-12-01T02:00:00Z"))?.windowKey.slice(0, 7)).toBe("2026-11");
    expect(latestOccurrence(timing, at("2026-12-01T03:00:00Z"))?.windowKey.slice(0, 7)).toBe("2026-12");
  });

  it("próxima ocorrência (tela) do dia 31 a partir de 01/02/2027 = 28/02", () => {
    expect((nextOccurrence(monthly(31, 8), at("2027-02-01T12:00:00Z")))?.windowKey.slice(0, 7)).toBe("2027-02");
    expect(nextOccurrence(monthly(31, 8), at("2027-02-01T12:00:00Z"))?.at.toISOString()).toBe("2027-02-28T11:00:00.000Z");
  });

  it("mensal criado depois da ocorrência do mês só envia no mês seguinte", () => {
    const timing = monthly(5, 8);
    const created = at("2026-11-10T12:00:00Z");
    expect(dueOccurrence(timing, created, at("2026-11-20T12:00:00Z"))).toBeNull();
    expect((dueOccurrence(timing, created, at("2026-12-05T11:00:00Z")))?.windowKey.slice(0, 7)).toBe("2026-12");
  });
});

describe("semanal", () => {
  it("segunda 08h: no domingo a janela é a segunda anterior (chave = dia da segunda)", () => {
    // 29/11/2026 é domingo; 23/11 é segunda.
    expect(latestOccurrence(weekly(1, 8), at("2026-11-29T20:00:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-23");
    // Segunda 30/11 às 07:59 SP: ainda a de 23/11; às 08:00, a de 30/11.
    expect(latestOccurrence(weekly(1, 8), at("2026-11-30T10:59:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-23");
    expect(latestOccurrence(weekly(1, 8), at("2026-11-30T11:00:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-30");
  });

  it("domingo 23h SP = segunda 02h UTC: não confunde com a segunda", () => {
    expect(latestOccurrence(weekly(7, 23), at("2026-11-30T02:30:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-29");
    expect(latestOccurrence(weekly(1, 23), at("2026-11-30T02:30:00Z"))?.windowKey.slice(0, 10)).toBe("2026-11-23");
  });

  it("semanal atravessando virada de mês e de ano", () => {
    // 31/12/2026 é quinta.
    expect(latestOccurrence(weekly(4, 9), at("2027-01-02T15:00:00Z"))?.windowKey.slice(0, 10)).toBe("2026-12-31");
  });

  it("cada semana tem chave própria (sem colisão entre semanas)", () => {
    const keys = new Set<string>();
    for (let week = 0; week < 8; week++) {
      const now = new Date(at("2026-11-02T12:00:00Z").getTime() + week * 7 * 86_400_000);
      keys.add(latestOccurrence(weekly(1, 8), now)!.windowKey);
    }
    expect(keys.size).toBe(8);
  });
});

describe("activeSince e janela devida", () => {
  it("ocorrência no mesmo instante de activeSince é devida; antes, não", () => {
    const occurrence = zonedInstant("2026-11-26", 8);
    expect((dueOccurrence(daily(8), occurrence, at("2026-11-26T12:00:00Z")))?.windowKey.slice(0, 10)).toBe("2026-11-26");
    expect(dueOccurrence(daily(8), new Date(occurrence.getTime() + 1), at("2026-11-26T12:00:00Z"))).toBeNull();
    expect((dueOccurrence(daily(8), LONG_AGO, at("2026-11-26T12:00:00Z")))?.windowKey.slice(0, 10)).toBe("2026-11-26");
  });

  it("job parado vários dias: só a ocorrência MAIS RECENTE é enviada (sem rajada de atrasados)", () => {
    expect((dueOccurrence(daily(8), LONG_AGO, at("2026-11-30T12:00:00Z")))?.windowKey.slice(0, 10)).toBe("2026-11-30");
  });
});

describe("entrada do formulário e status", () => {
  const base = { name: "X", target: { kind: "view", id: "v1" }, frequency: "DAILY", hour: 8, recipientUserIds: ["u1"], active: true };

  it("recusa hora fora de 0–23, dia da semana fora de 1–7, dia do mês fora de 1–31 e não inteiros", () => {
    for (const bad of [
      { hour: 24 }, { hour: -1 }, { hour: 8.5 },
      { frequency: "WEEKLY", weekday: 0 }, { frequency: "WEEKLY", weekday: 8 },
      { frequency: "MONTHLY", monthDay: 0 }, { frequency: "MONTHLY", monthDay: 32 },
      { frequency: "HOURLY" },
    ]) {
      expect(scheduleInputSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });

  it("recusa id de alvo/destinatário com caracteres de injeção, >50 destinatários e alvo sem kind válido", () => {
    expect(scheduleInputSchema.safeParse({ ...base, target: { kind: "view", id: "v1' OR 1=1" } }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, target: { kind: "sql", id: "v1" } }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, recipientUserIds: ["../etc"] }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, recipientUserIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, recipientUserIds: Array.from({ length: 50 }, (_, i) => `u${i}`) }).success).toBe(true);
    expect(scheduleInputSchema.safeParse({ ...base, ownerId: "outro" }).success).toBe(false);
    expect(scheduleInputSchema.safeParse({ ...base, target: { kind: "view", id: "v1", ownerId: "x" } }).success).toBe(false);
  });

  it("status: falha de entrega domina; todos pulados → SKIPPED; misto → PARTIAL; vazio → SKIPPED", () => {
    expect(runStatus([{ userId: "a", status: "SENT", sheets: 1 }, { userId: "b", status: "FAILED", error: "x" }])).toBe("FAILED");
    expect(runStatus([{ userId: "a", status: "SKIPPED", reason: "sem_acesso_visao" }])).toBe("SKIPPED");
    expect(runStatus([{ userId: "a", status: "SENT", sheets: 1 }, { userId: "b", status: "SKIPPED", reason: "usuario_inativo" }])).toBe("PARTIAL");
    expect(runStatus([])).toBe("SKIPPED");
  });
});
