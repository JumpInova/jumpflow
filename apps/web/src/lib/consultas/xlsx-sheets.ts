/**
 * Abas XLSX de Consultas, comuns à exportação (rotas) e ao envio agendado
 * (C3). Recebe dados JÁ autorizados e auditados por `exportConsulta`.
 */
import { defineSheet, type XlsxSheetSpec } from "@/lib/export/xlsx";
import type { OutputColumn } from "./compile";
import { excelNumFmt, exportCell } from "./format";
import type { ResultRow } from "./result";
import type { ConsultaEntity } from "./types";

export interface SheetData {
  entity: ConsultaEntity;
  columns: OutputColumn[];
  measures: OutputColumn[];
  rows: ResultRow[];
  totals: ResultRow | null;
}

/** Nome de arquivo seguro (sem acentos/espaços/separadores). */
export function safeFilename(base: string): string {
  const cleaned = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || "consulta";
}

/** Excel: nome de aba ≤ 31, sem `[]:*?/\`, único no arquivo (sem diferenciar caixa). */
export function uniqueSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Planilha";
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Aba de dados de uma consulta. */
export function dataSheet(data: SheetData, name: string): XlsxSheetSpec {
  return defineSheet<ResultRow>({
    name,
    rows: data.rows,
    columns: data.columns.map((column) => ({
      header: column.label,
      value: (row) => exportCell(data.entity, column, row),
      numFmt: excelNumFmt(column),
      width: Math.max(14, column.label.length + 2),
    })),
  });
}

/** Linhas de totais (sobre todo o conjunto filtrado) de uma consulta. */
export function totalRows(data: SheetData, source?: string) {
  const totals = data.totals;
  if (!totals || data.measures.length === 0) return [];
  return data.measures.map((column) => ({
    source: source ?? "",
    label: column.label,
    value: exportCell(data.entity, column, totals),
  }));
}

/** Aba "Totais" (uma linha por medida; com `source` quando há várias visões). */
export function totalsSheet(
  rows: { source: string; label: string; value: string | number | null }[],
  name: string,
  withSource: boolean,
): XlsxSheetSpec {
  return defineSheet({
    name,
    rows,
    columns: [
      ...(withSource ? [{ header: "Visão", value: (row: (typeof rows)[number]) => row.source, width: 32 }] : []),
      { header: "Medida", value: (row: (typeof rows)[number]) => row.label, width: 36 },
      {
        header: "Total (todos os registros filtrados)",
        value: (row: (typeof rows)[number]) => row.value,
        numFmt: "#,##0.00",
        width: 34,
      },
    ],
  });
}
