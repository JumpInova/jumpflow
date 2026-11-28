import { describe, expect, it } from "vitest";
import { isIsoDate, RELATIVE_DATE_LABELS, resolveRelativeDate } from "./dates";
import { RELATIVE_ANCHORS, type RelativeAnchor } from "./types";

describe("datas relativas (America/Sao_Paulo)", () => {
  // 2026-12-01 01:30 UTC = 2026-11-30 22:30 em São Paulo (segunda-feira).
  const lateNightUtc = new Date("2026-12-01T01:30:00.000Z");

  it("usa o dia de São Paulo, não o de UTC", () => {
    expect(resolveRelativeDate({ relative: "hoje" }, lateNightUtc)).toBe("2026-11-30");
    expect(resolveRelativeDate({ relative: "inicio_mes" }, lateNightUtc)).toBe("2026-11-01");
  });

  it("início da semana é segunda-feira", () => {
    expect(resolveRelativeDate({ relative: "inicio_semana" }, lateNightUtc)).toBe("2026-11-30");
    const sunday = new Date("2026-11-29T15:00:00.000Z");
    expect(resolveRelativeDate({ relative: "inicio_semana" }, sunday)).toBe("2026-11-23");
  });

  it("aplica deslocamento em dias atravessando mês/ano", () => {
    expect(resolveRelativeDate({ relative: "hoje", offsetDays: 32 }, lateNightUtc)).toBe("2027-01-01");
    expect(resolveRelativeDate({ relative: "inicio_mes", offsetDays: -1 }, lateNightUtc)).toBe("2026-10-31");
  });

  it("valida datas ISO de calendário", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("26-02-01")).toBe(false);
  });

  describe("âncoras de período (C3)", () => {
    const at = (iso: string) => new Date(iso);
    const r = (relative: RelativeAnchor, now: Date, offsetDays?: number) =>
      resolveRelativeDate({ relative, ...(offsetDays !== undefined ? { offsetDays } : {}) }, now);

    it("virada de ano no fuso de SP (31/12 23:30 SP já é 01/01 em UTC)", () => {
      // 2027-01-01T02:30Z = 31/12/2026 23:30 em SP.
      const eve = at("2027-01-01T02:30:00Z");
      expect(r("inicio_ano", eve)).toBe("2026-01-01");
      expect(r("inicio_ano_anterior", eve)).toBe("2025-01-01");
      expect(r("fim_ano_anterior", eve)).toBe("2025-12-31");
      expect(r("fim_mes", eve)).toBe("2026-12-31");
      // 2027-01-01T03:30Z = 01/01/2027 00:30 em SP.
      const newYear = at("2027-01-01T03:30:00Z");
      expect(r("inicio_ano", newYear)).toBe("2027-01-01");
      expect(r("inicio_mes_anterior", newYear)).toBe("2026-12-01");
      expect(r("fim_mes_anterior", newYear)).toBe("2026-12-31");
      expect(r("fim_ano_anterior", newYear)).toBe("2026-12-31");
    });

    it("fevereiro: fim do mês 28 (comum) e 29 (bissexto); mês anterior a março", () => {
      expect(r("fim_mes", at("2027-02-10T12:00:00Z"))).toBe("2027-02-28");
      expect(r("fim_mes", at("2028-02-10T12:00:00Z"))).toBe("2028-02-29");
      expect(r("inicio_mes_anterior", at("2028-03-31T12:00:00Z"))).toBe("2028-02-01");
      expect(r("fim_mes_anterior", at("2028-03-31T12:00:00Z"))).toBe("2028-02-29");
      expect(r("fim_mes_anterior", at("2027-03-01T12:00:00Z"))).toBe("2027-02-28");
    });

    it("dia 31: mês anterior de 30 dias não vira dia 31 inexistente", () => {
      const dec31 = at("2026-12-31T15:00:00Z");
      expect(r("inicio_mes_anterior", dec31)).toBe("2026-11-01");
      expect(r("fim_mes_anterior", dec31)).toBe("2026-11-30");
      expect(r("fim_mes", at("2026-05-31T15:00:00Z"))).toBe("2026-05-31");
      expect(r("fim_mes_anterior", at("2026-05-31T15:00:00Z"))).toBe("2026-04-30");
    });

    it("\"mês passado\" inclui o dia 1º; offsetDays continua valendo", () => {
      const now = at("2026-11-26T12:00:00Z");
      expect([r("inicio_mes_anterior", now), r("fim_mes_anterior", now)]).toEqual(["2026-10-01", "2026-10-31"]);
      expect(r("fim_mes_anterior", now, 1)).toBe("2026-11-01");
      expect(r("inicio_ano", now, -1)).toBe("2025-12-31");
    });

    it("próximo mês: dezembro→janeiro (vira o ano) e janeiro→fevereiro bissexto", () => {
      const dec = at("2026-12-31T15:00:00Z");
      expect([r("inicio_proximo_mes", dec), r("fim_proximo_mes", dec)]).toEqual(["2027-01-01", "2027-01-31"]);
      // 31/12 23:30 em SP (já 01/01 em UTC) ainda é dezembro.
      expect(r("inicio_proximo_mes", at("2027-01-01T02:30:00Z"))).toBe("2027-01-01");
      const jan = at("2028-01-31T15:00:00Z");
      expect([r("inicio_proximo_mes", jan), r("fim_proximo_mes", jan)]).toEqual(["2028-02-01", "2028-02-29"]);
      expect(r("fim_proximo_mes", at("2027-01-15T15:00:00Z"))).toBe("2027-02-28");
      expect(r("inicio_proximo_mes", at("2026-11-26T12:00:00Z"))).toBe("2026-12-01");
    });

    it("toda âncora tem rótulo PT-BR (construtor/explicação)", () => {
      for (const anchor of RELATIVE_ANCHORS) expect(RELATIVE_DATE_LABELS[anchor]).toBeTruthy();
    });
  });
});
