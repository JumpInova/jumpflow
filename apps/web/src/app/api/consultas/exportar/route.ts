import { z } from "zod";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { buildWorkbook, defineSheet, xlsxResponse } from "@/lib/export/xlsx";
import { buildConsultaCsv } from "@/lib/consultas/csv";
import { ConsultaError, isConsultaError } from "@/lib/consultas/errors";
import { excelNumFmt, exportCell } from "@/lib/consultas/format";
import type { ResultRow } from "@/lib/consultas/result";
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";
import { csvResponse, noDatabaseResponse } from "../../relatorios/shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  format: z.enum(["xlsx", "csv"]),
  spec: z.unknown(),
});

function errorResponse(error: ConsultaError): Response {
  return new Response(error.message, {
    status: error.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Exportação de Consultas (XLSX ou CSV) gerada no servidor. Recebe só a spec
 * (nunca SQL); permissão (`CONSULTAS_EXPORTAR` + entidade + colunas), escopo de
 * linha, limite de 50.000 linhas e auditoria ficam em `exportConsulta`.
 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return noDatabaseResponse();

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return errorResponse(new ConsultaError("INVALID", "Requisição inválida."));
  }

  try {
    const { exportConsulta } = await import("@/lib/db/consultas");
    // Spec vinda do construtor = ad hoc (exige CRIAR). Visões salvas (C2)
    // terão rota própria que carrega a spec no servidor e usa "saved_view".
    const data = await exportConsulta(user, body.spec, body.format, "adhoc");
    const entity = data.validated.entity;
    const today = isoDateInSaoPaulo(new Date());
    const filename = `consulta-${entity.key}_${today}`;

    if (body.format === "csv") {
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
  } catch (error) {
    if (isConsultaError(error)) return errorResponse(error);
    console.error("[consultas] falha na exportação", error);
    return errorResponse(
      new ConsultaError("FAILED", "Não foi possível exportar a consulta."),
    );
  }
}
