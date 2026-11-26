import { describe, expect, it } from "vitest";
import { isIsoDate, resolveRelativeDate } from "./dates";

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
});
