/**
 * Arquivo de exportação de Consultas (XLSX ou CSV), comum às rotas do
 * construtor (`/api/consultas/exportar`) e das visões salvas
 * (`/api/consultas/visoes/[id]/exportar`). Recebe dados JÁ autorizados e
 * auditados por `exportConsulta`.
 */
import { buildWorkbook, xlsxResponse } from "@/lib/export/xlsx";
import { buildConsultaCsv } from "@/lib/consultas/csv";
import { ConsultaError } from "@/lib/consultas/errors";
import { exportCell } from "@/lib/consultas/format";
import {
  dataSheet,
  safeFilename,
  totalRows,
  totalsSheet,
  uniqueSheetName,
} from "@/lib/consultas/xlsx-sheets";
import type { ConsultaExportData } from "@/lib/db/consultas";
import { csvResponse } from "../relatorios/shared";

export function consultaErrorResponse(error: ConsultaError): Response {
  return new Response(error.message, {
    status: error.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Nome de arquivo seguro (reexportado de `lib/consultas/xlsx-sheets`). */
export { safeFilename };

export async function consultaFileResponse(
  data: ConsultaExportData,
  format: "xlsx" | "csv",
  filename: string,
): Promise<Response> {
  const entity = data.validated.entity;
  if (format === "csv") {
    const csv = buildConsultaCsv(
      data.columns.map((column) => ({
        header: column.label,
        value: (row) => exportCell(entity, column, row),
      })),
      data.rows,
    );
    return csvResponse(csv, `${filename}.csv`);
  }

  const sheetData = { ...data, entity };
  const used = new Set<string>();
  const sheets = [dataSheet(sheetData, uniqueSheetName(entity.label, used))];
  const totals = totalRows(sheetData);
  if (totals.length > 0) {
    sheets.push(totalsSheet(totals, uniqueSheetName("Totais", used), false));
  }
  const buffer = await buildWorkbook(sheets);
  return xlsxResponse(buffer, `${filename}.xlsx`);
}
