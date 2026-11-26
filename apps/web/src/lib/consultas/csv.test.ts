import { describe, expect, it } from "vitest";
import { buildConsultaCsv, csvCell } from "./csv";

describe("CSV de Consultas", () => {
  it("usa BOM, separador ; e CRLF", () => {
    const csv = buildConsultaCsv(
      [
        { header: "Projeto", value: (row) => row.projeto },
        { header: "Horas", value: (row) => row.horas },
      ],
      [{ projeto: "Atlas", horas: 12.5 }],
    );
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿"Projeto";"Horas"\r\n"Atlas";"12,5"\r\n');
  });

  it.each(["=SUM(A1:A9)", "+55 11", "-cmd", "@HYPERLINK(\"x\")", "\tTAB", "\rCR"])(
    "neutraliza fórmula em texto: %j",
    (value) => {
      expect(csvCell(value).startsWith(`"'`)).toBe(true);
    },
  );

  it("cabeçalho também é sanitizado e aspas são duplicadas", () => {
    const csv = buildConsultaCsv([{ header: "=x", value: (row) => row.a }], [{ a: 'diz "oi"' }]);
    expect(csv).toContain(`"'=x"`);
    expect(csv).toContain(`"diz ""oi"""`);
  });

  it("números não são tratados como fórmula; vazio e booleano formatados", () => {
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(true)).toBe('"Sim"');
  });
});
