import { z } from "zod";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { ConsultaError, isConsultaError } from "@/lib/consultas/errors";
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";
import { noDatabaseResponse } from "../../relatorios/shared";
import { consultaErrorResponse, consultaFileResponse } from "../export-file";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  format: z.enum(["xlsx", "csv"]),
  spec: z.unknown(),
});

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
    return consultaErrorResponse(new ConsultaError("INVALID", "Requisição inválida."));
  }

  try {
    const { exportConsulta } = await import("@/lib/db/consultas");
    // Spec vinda do construtor = ad hoc (exige CRIAR). Visões salvas usam a
    // rota /api/consultas/visoes/[id]/exportar, que carrega a spec no servidor.
    const data = await exportConsulta(user, body.spec, body.format, "adhoc");
    const today = isoDateInSaoPaulo(new Date());
    return await consultaFileResponse(
      data,
      body.format,
      `consulta-${data.validated.entity.key}_${today}`,
    );
  } catch (error) {
    if (isConsultaError(error)) return consultaErrorResponse(error);
    console.error("[consultas] falha na exportação", error);
    return consultaErrorResponse(
      new ConsultaError("FAILED", "Não foi possível exportar a consulta."),
    );
  }
}
