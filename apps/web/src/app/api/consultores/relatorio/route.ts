import { hasRoleOrPermission, requireUser } from "@/lib/auth/guards";
import { CONSULTANT_REPORT_CODE } from "@/lib/auth/permission-codes";
import { CONSULTANT_REPORT_ROLES } from "@/lib/auth/roles";
import { isDatabaseConfigured } from "@/lib/db/config";
import { buildWorkbook, defineSheet, xlsxResponse } from "@/lib/export/xlsx";
import {
  consultantStatusLabels,
  seniorityLabels,
} from "@/lib/consultants/labels";
import type {
  ConsultantSeniority,
  ConsultantStatusValue,
} from "@/lib/consultants/schemas";
import { projectHistoryStatusLabels } from "@/lib/consultants/project-history";
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";
import {
  forbiddenResponse,
  invalidInputResponse,
  noDatabaseResponse,
} from "../../relatorios/shared";

export const dynamic = "force-dynamic";

const DATE_FMT = "dd/mm/yyyy";

/** ISO `yyyy-mm-dd` → Date UTC (ExcelJS serializa em UTC, sem desvio de fuso). */
function excelDate(iso: string | null | undefined): Date | null {
  return iso ? new Date(`${iso}T00:00:00.000Z`) : null;
}

/**
 * Relatório de consultores com o histórico de projetos (.xlsx): uma linha por
 * consultor × projeto, com perfil no projeto, início, fim e se está ativo.
 * Gate: CONSULTANT_REPORT_ROLES (ADMIN, Gestor de Área, People) OU
 * `CONSULTORES_RELATORIO` view na Matriz. Sem campos financeiros. Auditado como
 * `CONSULTANTS_REPORT_EXPORTED` com o filtro usado.
 */
export async function GET(request: Request) {
  const user = await requireUser();
  if (!isDatabaseConfigured()) return noDatabaseResponse();
  const allowed = await hasRoleOrPermission(
    user,
    CONSULTANT_REPORT_ROLES,
    CONSULTANT_REPORT_CODE,
    "view",
  );
  if (!allowed) return forbiddenResponse();

  const { consultantReportFilterSchema, getConsultantProjectReport } =
    await import("@/lib/db/consultant-project-history");
  const url = new URL(request.url);
  // Selects vazios chegam como "": tratados como "sem filtro".
  const params = Object.fromEntries(
    [...url.searchParams].filter(([, value]) => value !== ""),
  );
  const parsed = consultantReportFilterSchema.safeParse(params);
  if (!parsed.success) return invalidInputResponse();

  const rows = await getConsultantProjectReport(parsed.data);

  const buffer = await buildWorkbook([
    defineSheet({
      name: "Consultores",
      rows,
      columns: [
        { header: "Consultor", value: (r) => r.consultantName, width: 28 },
        { header: "E-mail", value: (r) => r.consultantEmail, width: 30 },
        { header: "Cargo", value: (r) => r.jobTitle ?? "", width: 22 },
        { header: "Área", value: (r) => r.area ?? "", width: 18 },
        {
          header: "Senioridade",
          value: (r) =>
            seniorityLabels[r.seniority as ConsultantSeniority] ?? r.seniority,
          width: 14,
        },
        {
          header: "Status do consultor",
          value: (r) =>
            consultantStatusLabels[r.consultantStatus as ConsultantStatusValue] ??
            r.consultantStatus,
          width: 18,
        },
        { header: "Cliente", value: (r) => r.project?.clientName ?? "", width: 22 },
        { header: "Projeto", value: (r) => r.project?.projectName ?? "", width: 28 },
        { header: "Perfil no projeto", value: (r) => r.project?.role ?? "", width: 22 },
        {
          header: "Início",
          value: (r) => excelDate(r.project?.startDate),
          numFmt: DATE_FMT,
          width: 12,
        },
        {
          header: "Fim",
          value: (r) => excelDate(r.project?.endDate),
          numFmt: DATE_FMT,
          width: 12,
        },
        {
          header: "Status no projeto",
          value: (r) =>
            r.project ? projectHistoryStatusLabels[r.project.status] : "",
          width: 16,
        },
      ],
    }),
  ]);

  const { resolveDbUser } = await import("@/lib/db/users");
  const { recordAuditEvent } = await import("@/lib/db/audit");
  const dbUser = await resolveDbUser(user);
  const today = isoDateInSaoPaulo(new Date());
  await recordAuditEvent({
    actorUserId: dbUser?.id ?? null,
    entityType: "ConsultantReport",
    entityId: `export-${today}`,
    action: "CONSULTANTS_REPORT_EXPORTED",
    after: { filter: parsed.data, rowCount: rows.length },
  });

  return xlsxResponse(buffer, `relatorio-consultores_${today}.xlsx`);
}
