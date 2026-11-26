import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { ConsultaError, isConsultaError } from "@/lib/consultas/errors";
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";
import { noDatabaseResponse } from "../../../../relatorios/shared";
import { consultaErrorResponse, consultaFileResponse, safeFilename } from "../../../export-file";

export const dynamic = "force-dynamic";

/**
 * Exportação de uma VISÃO SALVA (`?formato=xlsx|csv`). A spec é carregada no
 * servidor (nunca vem do cliente) e roda com a permissão e o escopo de quem
 * exporta: `exportConsulta(..., "saved_view")` exige `CONSULTAS_EXPORTAR`,
 * entidade e campos, mas não `CONSULTAS_CRIAR`. Sempre auditada.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return noDatabaseResponse();

  const { id } = await params;
  const formato = new URL(request.url).searchParams.get("formato");
  if (formato !== "xlsx" && formato !== "csv") {
    return consultaErrorResponse(new ConsultaError("INVALID", "Formato inválido."));
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return consultaErrorResponse(new ConsultaError("NOT_FOUND", "Visão não encontrada ou sem acesso."));
  }

  try {
    const { exportSavedView } = await import("@/lib/db/consultas-saved");
    const data = await exportSavedView(user, id, formato);
    const today = isoDateInSaoPaulo(new Date());
    return await consultaFileResponse(data, formato, `${safeFilename(data.viewName)}_${today}`);
  } catch (error) {
    if (isConsultaError(error)) return consultaErrorResponse(error);
    console.error("[consultas] falha na exportação da visão", error);
    return consultaErrorResponse(
      new ConsultaError("FAILED", "Não foi possível exportar a visão."),
    );
  }
}
