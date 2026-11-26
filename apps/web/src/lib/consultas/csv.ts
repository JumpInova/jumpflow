/**
 * CSV da exportação de Consultas, gerado NO SERVIDOR (ESPECIFICAÇÃO §6 C1 e
 * §9): separador `;` (Excel pt-BR), BOM UTF-8, `\r\n`, todo campo entre aspas
 * e escape de fórmula — célula de texto começando com `=`, `+`, `-`, `@`, TAB
 * ou CR ganha prefixo `'` (reusa `sanitizeText` dos Relatórios).
 */
import { sanitizeText } from "@/lib/reports/csv";
import type { CellValue } from "./result";

const BOM = "﻿";
const EOL = "\r\n";

export interface CsvColumn {
  header: string;
  /** Valor já formatado para exibição (texto) ou número. */
  value: (row: Record<string, CellValue>) => CellValue;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Número com vírgula decimal (pt-BR), sem separador de milhar. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(".", ",");
}

export function csvCell(value: CellValue): string {
  if (value === null || value === undefined) return quote("");
  if (typeof value === "number") return quote(formatNumber(value));
  if (typeof value === "boolean") return quote(value ? "Sim" : "Não");
  return quote(sanitizeText(value));
}

export function buildConsultaCsv(
  columns: ReadonlyArray<CsvColumn>,
  rows: ReadonlyArray<Record<string, CellValue>>,
): string {
  const lines = [columns.map((column) => quote(sanitizeText(column.header))).join(";")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column.value(row))).join(";"));
  }
  return BOM + lines.join(EOL) + EOL;
}
