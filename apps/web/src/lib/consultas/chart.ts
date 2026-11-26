/**
 * Dados de gráfico a partir do resultado de uma consulta (PURO). O resultado
 * já vem agregado do Postgres — aqui só há reorganização para desenhar
 * (categorias × séries), nunca agregação.
 */
import { formatCell } from "./format";
import type { CellValue } from "./result";
import type { Visualization } from "./saved";
import type { ConsultaEntity, FieldType } from "./types";

/** Colunas/linhas mínimas do resultado (mesmo formato de `ConsultaRunResult`). */
export interface ChartSourceColumn {
  key: string;
  label: string;
  type: FieldType;
  kind: "column" | "group" | "measure";
  field: string;
  agg?: "sum" | "avg" | "min" | "max" | "count";
  granularity?: "dia" | "semana" | "mes" | "ano";
}

export interface ChartSource {
  grouped: boolean;
  columns: ChartSourceColumn[];
  measures: ChartSourceColumn[];
  rows: Record<string, CellValue | undefined>[];
  totals: Record<string, CellValue> | null;
}

/** Máximo de categorias desenhadas (barras/linhas); o resto fica na tabela. */
export const MAX_CHART_CATEGORIES = 30;
/** Fatias da pizza antes de agrupar o restante em "Outros". */
export const MAX_PIE_SLICES = 8;
/** Séries (medidas) desenhadas em barras/linhas. */
export const MAX_CHART_SERIES = 3;

export type ChartAvailability = { ok: true } | { ok: false; reason: string };

const NON_NUMERIC_AGG = new Set(["min", "max"]);

function plottable(measure: ChartSourceColumn): boolean {
  // min/max de data viram data, não número.
  if (measure.agg && NON_NUMERIC_AGG.has(measure.agg) && measure.type === "data") return false;
  return true;
}

/** A visualização faz sentido para este resultado? */
export function chartAvailability(
  source: ChartSource,
  visualization: Visualization,
): ChartAvailability {
  if (visualization === "TABLE") return { ok: true };
  const measures = source.measures.filter(plottable);
  if (visualization === "INDICATOR") {
    return measures.length > 0 && source.totals
      ? { ok: true }
      : { ok: false, reason: "O indicador precisa de ao menos uma medida numérica." };
  }
  if (!source.grouped) {
    return { ok: false, reason: "Gráficos precisam de uma consulta agrupada (Agrupar e somar)." };
  }
  if (measures.length === 0) {
    return { ok: false, reason: "O gráfico precisa de ao menos uma medida numérica." };
  }
  if (source.rows.length === 0) {
    return { ok: false, reason: "Nenhum grupo para desenhar." };
  }
  if (visualization === "PIE") {
    const first = measures[0];
    if (source.rows.some((row) => Number(row[first.key] ?? 0) < 0)) {
      return { ok: false, reason: "Pizza não representa valores negativos; use barras." };
    }
  }
  return { ok: true };
}

export interface ChartSeries {
  key: string;
  label: string;
  column: ChartSourceColumn;
  values: number[];
}

export interface ChartData {
  categories: string[];
  series: ChartSeries[];
  /** Grupos além do teto desenhado (ficam fora do gráfico). */
  omitted: number;
}

function categoryLabel(entity: ConsultaEntity, groups: ChartSourceColumn[], row: ChartSource["rows"][number]): string {
  return groups
    .map((group) => formatCell(entity, group, row[group.key] ?? null))
    .join(" · ");
}

/**
 * Categorias (grupos) × séries (medidas). Linhas com 1º grupo de data são
 * ordenadas cronologicamente; demais mantêm a ordenação da consulta.
 */
export function buildChartData(
  entity: ConsultaEntity,
  source: ChartSource,
  visualization: Visualization,
): ChartData {
  const groups = source.columns.filter((column) => column.kind === "group");
  const measures = source.measures.filter(plottable);
  let rows = [...source.rows];
  if (visualization === "LINE" && groups[0]?.type === "data") {
    const key = groups[0].key;
    rows.sort((a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? "")));
  }

  if (visualization === "PIE") {
    const measure = measures[0];
    const sorted = rows
      .map((row) => ({ label: categoryLabel(entity, groups, row), value: Number(row[measure.key] ?? 0) }))
      .sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, MAX_PIE_SLICES);
    const tail = sorted.slice(MAX_PIE_SLICES);
    if (tail.length > 0) {
      head.push({ label: "Outros", value: tail.reduce((sum, item) => sum + item.value, 0) });
    }
    return {
      categories: head.map((item) => item.label),
      series: [{ key: measure.key, label: measure.label, column: measure, values: head.map((item) => item.value) }],
      omitted: 0,
    };
  }

  const omitted = Math.max(0, rows.length - MAX_CHART_CATEGORIES);
  rows = rows.slice(0, MAX_CHART_CATEGORIES);
  return {
    categories: rows.map((row) => categoryLabel(entity, groups, row)),
    series: measures.slice(0, MAX_CHART_SERIES).map((measure) => ({
      key: measure.key,
      label: measure.label,
      column: measure,
      values: rows.map((row) => {
        const value = Number(row[measure.key] ?? 0);
        return Number.isFinite(value) ? value : 0;
      }),
    })),
    omitted,
  };
}

/** Escala "bonita" (0 → teto arredondado) para o eixo de valores. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exponent = Math.floor(Math.log10(max));
  const base = 10 ** exponent;
  const fraction = max / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

export interface PieArc {
  label: string;
  value: number;
  fraction: number;
  /** Caminho SVG da fatia (rosca). */
  path: string;
}

/** Fatias de uma rosca centrada em (`center`, `center`). Valores ≤ 0 viram fatia vazia. */
export function pieArcs(
  categories: readonly string[],
  values: readonly number[],
  center: number,
  radius: number,
  inner: number,
): PieArc[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  const point = (r: number, a: number) =>
    `${(center + r * Math.cos(a)).toFixed(2)},${(center + r * Math.sin(a)).toFixed(2)}`;
  const arcs: PieArc[] = [];
  let angle = -Math.PI / 2;
  values.forEach((raw, index) => {
    const value = Math.max(0, raw);
    const fraction = total > 0 ? value / total : 0;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    const path =
      fraction >= 0.9999
        ? `M${point(radius, 0)} A${radius},${radius} 0 1 1 ${point(radius, Math.PI)} A${radius},${radius} 0 1 1 ${point(radius, 0)} M${point(inner, 0)} A${inner},${inner} 0 1 0 ${point(inner, Math.PI)} A${inner},${inner} 0 1 0 ${point(inner, 0)} Z`
        : `M${point(radius, start)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`;
    arcs.push({ label: categories[index] ?? "", value: raw, fraction, path });
  });
  return arcs;
}
