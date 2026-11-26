/**
 * Histórico de projetos do consultor: visão DERIVADA das alocações (Allocation).
 * Não há tabela própria — projeto, perfil (Allocation.role), início, fim e status
 * já vivem na alocação, que continua sendo a fonte única (editada em Projetos).
 *
 * Módulo puro (sem Prisma) para a regra de "ativo no projeto" ser testável e
 * compartilhada entre a seção do cadastro e o relatório exportável.
 */

/** Espelha o enum Prisma `AllocationStatus`. */
export type AllocationStatusValue =
  | "ACTIVE"
  | "PLANNED"
  | "ENDED"
  | "CANCELLED"
  | "INACTIVE";

export type ProjectHistoryStatus = "ACTIVE" | "INACTIVE";

export const projectHistoryStatusLabels: Record<ProjectHistoryStatus, string> =
  {
    ACTIVE: "Ativo",
    INACTIVE: "Inativo",
  };

/** Uma linha do histórico (uma alocação). Datas em ISO `yyyy-mm-dd`. */
export interface ProjectHistoryEntry {
  allocationId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  /** Perfil do consultor no projeto (Allocation.role). */
  role: string;
  startDate: string;
  endDate: string | null;
  status: ProjectHistoryStatus;
}

/**
 * Ativo no projeto = alocação ACTIVE cuja vigência cobre `today` (início já
 * ocorreu e fim ausente ou não vencido). Uma alocação ACTIVE com fim no passado
 * conta como inativa: o fim registrado prevalece sobre o status esquecido.
 * PLANNED/ENDED/INACTIVE são inativas. `today` em ISO `yyyy-mm-dd`.
 */
export function deriveProjectHistoryStatus(
  allocation: {
    status: AllocationStatusValue;
    startDate: string;
    endDate: string | null;
  },
  today: string,
): ProjectHistoryStatus {
  if (allocation.status !== "ACTIVE") return "INACTIVE";
  if (allocation.startDate > today) return "INACTIVE";
  if (allocation.endDate && allocation.endDate < today) return "INACTIVE";
  return "ACTIVE";
}

/** Alocações canceladas nunca aconteceram: ficam fora do histórico. */
export function isHistoryRelevant(status: AllocationStatusValue): boolean {
  return status !== "CANCELLED";
}

/** Ordem de exibição: ativos primeiro, depois início mais recente. */
export function compareProjectHistory(
  a: Pick<ProjectHistoryEntry, "status" | "startDate" | "projectName">,
  b: Pick<ProjectHistoryEntry, "status" | "startDate" | "projectName">,
): number {
  if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? 1 : -1;
  return a.projectName.localeCompare(b.projectName, "pt-BR");
}
