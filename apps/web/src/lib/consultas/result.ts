/**
 * Pós-processamento PURO do resultado: paginação (limites da §4.5) e
 * normalização dos valores crus do Postgres (Decimal, bigint, Date) para JSON
 * serializável. Nenhuma agregação acontece aqui — só conversão de tipo.
 */
import type { OutputColumn } from "./compile";
import { MAX_EXPORT_ROWS, MAX_SCREEN_ROWS, PAGE_SIZE } from "./spec";
import type { FieldType } from "./types";

export type CellValue = string | number | boolean | null;
export type ResultRow = Record<string, CellValue>;

export interface ConsultaPage {
  page: number;
  pageSize: number;
  offset: number;
  /** Linhas a buscar nesta página (≤ pageSize). */
  take: number;
  /** Teto navegável: min(limit da spec, 1000). */
  maxRows: number;
}

/** Página da tela: 100 linhas por offset, no máximo 1000 navegáveis. */
export function resolveScreenPage(page: number, limit?: number): ConsultaPage {
  const maxRows = Math.min(limit ?? MAX_SCREEN_ROWS, MAX_SCREEN_ROWS);
  const lastPage = Math.max(1, Math.ceil(maxRows / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), lastPage);
  const offset = (safePage - 1) * PAGE_SIZE;
  return {
    page: safePage,
    pageSize: PAGE_SIZE,
    offset,
    take: Math.max(0, Math.min(PAGE_SIZE, maxRows - offset)),
    maxRows,
  };
}

/** Teto de linhas da exportação: min(limit da spec, 50.000). */
export function exportRowLimit(limit?: number): number {
  return Math.min(limit ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
}

function isDecimalLike(value: unknown): value is { toString(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  );
}

/** Converte um valor cru do driver para JSON conforme o tipo do campo. */
export function normalizeCell(value: unknown, type: FieldType): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === "bigint") return Number(value);
  if (isDecimalLike(value)) return Number(value.toString());
  if (type === "numero" || type === "moeda" || type === "horas") {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

/** Mapeia uma linha crua (aliases c0/g0/m0) para as chaves de saída. */
export function mapRow(
  raw: Record<string, unknown>,
  columns: ReadonlyArray<OutputColumn>,
): ResultRow {
  const row: ResultRow = {};
  for (const column of columns) {
    row[column.key] = normalizeCell(raw[column.alias], column.type);
  }
  return row;
}
