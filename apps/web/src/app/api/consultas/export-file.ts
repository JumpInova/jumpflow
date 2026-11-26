/**
 * Arquivo de exportação de Consultas (XLSX ou CSV), comum às rotas do
 * construtor (`/api/consultas/exportar`) e das visões salvas
 * (`/api/consultas/visoes/[id]/exportar`). Recebe dados JÁ autorizados e
 * auditados por `exportConsulta`.
 */
import { buildWorkbook, defineSheet, xlsxResponse } from "@/lib/export/xlsx";
import { buildConsultaCsv } from "@/lib/consultas/csv";
import { ConsultaError } from "@/lib/consultas/errors";
import { excelNumFmt, exportCell } from "@/lib/consultas/format";
import type { ResultRow } from "@/lib/consultas/result";
import type { ConsultaExportData } from "@/lib/db/consultas";
import { csvResponse } from "../relatorios/shared";

export function consultaErrorResponse(error: ConsultaError): Response {
  return new Response(error.message, {
    status: error.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Nome de arquivo seguro (sem acentos/espaços/separadores). */
export function safeFilename(base: string): string {
  const cleaned = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || "consulta";
}

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

  const measures = data.measures;
  const sheets = [
    defineSheet<ResultRow>({
      name: entity.label,
      rows: data.rows,
      columns: data.columns.map((column) => ({
        header: column.label,
        value: (row) => exportCell(entity, column, row),
        numFmt: excelNumFmt(column),
        width: Math.max(14, column.label.length + 2),
      })),
    }),
  ];
  if (data.totals && measures.length > 0) {
    const totals = data.totals;
    sheets.push(
      defineSheet({
        name: "Totais",
        rows: measures,
        columns: [
          { header: "Medida", value: (column) => column.label, width: 36 },
          {
            header: "Total (todos os registros filtrados)",
            value: (column) => exportCell(entity, column, totals),
            numFmt: "#,##0.00",
            width: 34,
          },
        ],
      }),
    );
  }
  const buffer = await buildWorkbook(sheets);
  return xlsxResponse(buffer, `${filename}.xlsx`);
}
