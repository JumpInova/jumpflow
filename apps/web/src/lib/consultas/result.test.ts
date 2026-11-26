import { describe, expect, it } from "vitest";
import { exportRowLimit, mapRow, normalizeCell, resolveScreenPage } from "./result";

describe("paginação (§4.5)", () => {
  it("100 por página, máximo 1000 navegáveis", () => {
    expect(resolveScreenPage(1)).toMatchObject({ page: 1, offset: 0, take: 100, maxRows: 1000 });
    expect(resolveScreenPage(10)).toMatchObject({ page: 10, offset: 900, take: 100 });
    expect(resolveScreenPage(11)).toMatchObject({ page: 10, offset: 900 });
    expect(resolveScreenPage(-3)).toMatchObject({ page: 1, offset: 0 });
  });

  it("respeita o limit da spec", () => {
    expect(resolveScreenPage(1, 30)).toMatchObject({ take: 30, maxRows: 30 });
    expect(resolveScreenPage(2, 150)).toMatchObject({ page: 2, offset: 100, take: 50 });
    expect(resolveScreenPage(1, 5000).maxRows).toBe(1000);
  });

  it("exportação limitada a 50.000", () => {
    expect(exportRowLimit()).toBe(50_000);
    expect(exportRowLimit(10)).toBe(10);
  });
});

describe("normalização de valores", () => {
  it("converte Decimal, bigint e Date", () => {
    const decimal = { toNumber: () => 1.5, toString: () => "1.50" };
    expect(normalizeCell(decimal, "moeda")).toBe(1.5);
    expect(normalizeCell(BigInt(7), "numero")).toBe(7);
    expect(normalizeCell(new Date("2026-11-03T00:00:00.000Z"), "data")).toBe("2026-11-03");
    expect(normalizeCell(null, "texto")).toBeNull();
    expect(normalizeCell("12.25", "horas")).toBe(12.25);
  });

  it("mapeia aliases para as chaves de saída", () => {
    const row = mapRow({ c0: "Atlas", m0: BigInt(3) }, [
      { key: "projeto", label: "Projeto", type: "texto", kind: "column", field: "projeto", alias: "c0" },
      { key: "count:projeto", label: "Contagem", type: "numero", kind: "measure", field: "projeto", agg: "count", alias: "m0" },
    ]);
    expect(row).toEqual({ projeto: "Atlas", "count:projeto": 3 });
  });
});
