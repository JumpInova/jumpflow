import { describe, expect, it } from "vitest";
import { getEntity } from "./catalog";
import {
  buildChartData,
  chartAvailability,
  MAX_CHART_CATEGORIES,
  MAX_PIE_SLICES,
  niceMax,
  pieArcs,
  type ChartSource,
  type ChartSourceColumn,
} from "./chart";

const horas = getEntity("horas")!;

const group: ChartSourceColumn = { key: "projeto", label: "Projeto", type: "texto", kind: "group", field: "projeto" };
const dateGroup: ChartSourceColumn = {
  key: "data",
  label: "Data (mês)",
  type: "data",
  kind: "group",
  field: "data",
  granularity: "mes",
};
const sum: ChartSourceColumn = { key: "sum:horas", label: "Soma de Horas", type: "horas", kind: "measure", field: "horas", agg: "sum" };
const maxDate: ChartSourceColumn = { key: "max:data", label: "Máximo de Data", type: "data", kind: "measure", field: "data", agg: "max" };

function source(rows: Record<string, number | string>[], columns = [group, sum], measures = [sum]): ChartSource {
  return { grouped: true, columns, measures, rows, totals: { "sum:horas": 10 } };
}

describe("chartAvailability", () => {
  it("tabela sempre; gráficos exigem agrupamento e medida numérica", () => {
    expect(chartAvailability({ ...source([]), grouped: false }, "TABLE").ok).toBe(true);
    expect(chartAvailability({ ...source([{ projeto: "A", "sum:horas": 1 }]), grouped: false }, "BAR").ok).toBe(false);
    expect(chartAvailability(source([]), "BAR").ok).toBe(false);
    expect(chartAvailability(source([{ projeto: "A", "max:data": "2026-01-01" }], [group, maxDate], [maxDate]), "BAR").ok).toBe(false);
    expect(chartAvailability(source([{ projeto: "A", "sum:horas": 1 }]), "BAR").ok).toBe(true);
  });

  it("pizza recusa negativos; indicador só precisa de totais", () => {
    expect(chartAvailability(source([{ projeto: "A", "sum:horas": -1 }]), "PIE").ok).toBe(false);
    expect(chartAvailability({ ...source([]), grouped: false }, "INDICATOR").ok).toBe(true);
    expect(chartAvailability({ ...source([]), grouped: false, totals: null }, "INDICATOR").ok).toBe(false);
  });
});

describe("buildChartData", () => {
  it(`barras: até ${MAX_CHART_CATEGORIES} categorias, informa as omitidas`, () => {
    const rows = Array.from({ length: MAX_CHART_CATEGORIES + 5 }, (_, i) => ({ projeto: `P${i}`, "sum:horas": i }));
    const data = buildChartData(horas, source(rows), "BAR");
    expect(data.categories).toHaveLength(MAX_CHART_CATEGORIES);
    expect(data.omitted).toBe(5);
    expect(data.series[0].values[3]).toBe(3);
  });

  it(`pizza: ${MAX_PIE_SLICES} maiores + "Outros" com a soma do resto`, () => {
    const rows = Array.from({ length: MAX_PIE_SLICES + 3 }, (_, i) => ({ projeto: `P${i}`, "sum:horas": i + 1 }));
    const data = buildChartData(horas, source(rows), "PIE");
    expect(data.categories).toHaveLength(MAX_PIE_SLICES + 1);
    expect(data.categories.at(-1)).toBe("Outros");
    expect(data.series[0].values.at(-1)).toBe(1 + 2 + 3);
    expect(data.series[0].values[0]).toBe(MAX_PIE_SLICES + 3);
  });

  it("linhas com 1º grupo de data ficam em ordem cronológica e com rótulo da granularidade", () => {
    const rows = [
      { data: "2026-03-01", "sum:horas": 3 },
      { data: "2026-01-01", "sum:horas": 1 },
    ];
    const data = buildChartData(horas, source(rows, [dateGroup, sum]), "LINE");
    expect(data.categories).toEqual(["01/2026", "03/2026"]);
    expect(data.series[0].values).toEqual([1, 3]);
  });
});

describe("escala e pizza", () => {
  it("niceMax arredonda para 1/2/5 × 10^n", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(140)).toBe(200);
    expect(niceMax(4100)).toBe(5000);
  });

  it("frações somam 1 e negativos não desenham fatia", () => {
    const arcs = pieArcs(["a", "b", "c"], [1, 3, -2], 100, 80, 40);
    expect(arcs.reduce((total, arc) => total + arc.fraction, 0)).toBeCloseTo(1);
    expect(arcs[2].fraction).toBe(0);
    expect(arcs[1].path.startsWith("M")).toBe(true);
  });
});
