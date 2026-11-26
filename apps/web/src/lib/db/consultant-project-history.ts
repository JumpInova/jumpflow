import { prisma } from "@jumpflow/database";
import { z } from "zod";
import {
  compareProjectHistory,
  deriveProjectHistoryStatus,
  isHistoryRelevant,
  type AllocationStatusValue,
  type ProjectHistoryEntry,
  type ProjectHistoryStatus,
} from "@/lib/consultants/project-history";
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";

/**
 * Leituras do histórico de projetos do consultor (derivado de Allocation).
 * RBAC é responsabilidade do CHAMADOR (action/route handler); estas funções não
 * expõem nenhum campo financeiro (nem valor/hora, nem custo).
 */

/** Data UTC da alocação em ISO (datas de alocação são gravadas à meia-noite UTC). */
function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const allocationSelect = {
  id: true,
  role: true,
  startDate: true,
  endDate: true,
  status: true,
  project: {
    select: { id: true, name: true, client: { select: { name: true } } },
  },
} as const;

type AllocationRow = {
  id: string;
  role: string;
  startDate: Date;
  endDate: Date | null;
  status: string;
  project: { id: string; name: string; client: { name: string } };
};

function toEntry(row: AllocationRow, today: string): ProjectHistoryEntry {
  const startDate = toIso(row.startDate);
  const endDate = row.endDate ? toIso(row.endDate) : null;
  return {
    allocationId: row.id,
    projectId: row.project.id,
    projectName: row.project.name,
    clientName: row.project.client.name,
    role: row.role,
    startDate,
    endDate,
    status: deriveProjectHistoryStatus(
      { status: row.status as AllocationStatusValue, startDate, endDate },
      today,
    ),
  };
}

function relevant(rows: AllocationRow[], today: string): ProjectHistoryEntry[] {
  return rows
    .filter((row) => isHistoryRelevant(row.status as AllocationStatusValue))
    .map((row) => toEntry(row, today))
    .sort(compareProjectHistory);
}

/** Histórico de projetos de um consultor (ativos primeiro, mais recentes antes). */
export async function getConsultantProjectHistory(
  consultantId: string,
  now: Date = new Date(),
): Promise<ProjectHistoryEntry[]> {
  const rows = await prisma.allocation.findMany({
    where: { consultantId },
    select: allocationSelect,
  });
  return relevant(rows, isoDateInSaoPaulo(now));
}

/** Filtros do relatório de consultores (query string do export). */
export const consultantReportFilterSchema = z.object({
  area: z.string().trim().max(120).optional(),
  consultantStatus: z.enum(["ACTIVE", "INACTIVE", "ON_LEAVE"]).optional(),
  projectStatus: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
export type ConsultantReportFilter = z.infer<typeof consultantReportFilterSchema>;

/** Uma linha do relatório: consultor × projeto (sem projeto = colunas vazias). */
export interface ConsultantReportRow {
  consultantName: string;
  consultantEmail: string;
  jobTitle: string | null;
  area: string | null;
  seniority: string;
  consultantStatus: string;
  project: ProjectHistoryEntry | null;
}

/**
 * Relatório de consultores com o histórico de projetos. Uma linha por alocação;
 * consultores sem alocação saem com uma linha só (projeto vazio), a menos que o
 * filtro de status no projeto esteja ativo. Ordenado por nome do consultor.
 */
export async function getConsultantProjectReport(
  filter: ConsultantReportFilter,
  now: Date = new Date(),
): Promise<ConsultantReportRow[]> {
  const today = isoDateInSaoPaulo(now);
  const consultants = await prisma.consultant.findMany({
    where: filter.consultantStatus ? { status: filter.consultantStatus } : {},
    orderBy: { name: "asc" },
    select: {
      name: true,
      email: true,
      jobTitle: true,
      area: true,
      seniority: true,
      status: true,
      allocations: { select: allocationSelect },
    },
  });

  // Área comparada em memória com trim + sem diferenciar maiúsculas: uma área
  // gravada como "Dados " ou "dados" casa com a opção "Dados" do seletor.
  const areaKey = filter.area?.trim().toLowerCase();
  const rows: ConsultantReportRow[] = [];
  for (const consultant of consultants) {
    if (areaKey && (consultant.area?.trim().toLowerCase() ?? "") !== areaKey) {
      continue;
    }
    const base = {
      consultantName: consultant.name,
      consultantEmail: consultant.email,
      jobTitle: consultant.jobTitle,
      area: consultant.area,
      seniority: consultant.seniority,
      consultantStatus: consultant.status,
    };
    const history = relevant(consultant.allocations, today).filter(
      (entry) =>
        !filter.projectStatus ||
        entry.status === (filter.projectStatus as ProjectHistoryStatus),
    );
    if (history.length === 0) {
      if (!filter.projectStatus) rows.push({ ...base, project: null });
      continue;
    }
    for (const project of history) rows.push({ ...base, project });
  }
  return rows;
}
