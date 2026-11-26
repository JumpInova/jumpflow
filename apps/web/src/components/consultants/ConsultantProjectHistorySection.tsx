"use client";

import { FolderKanban } from "lucide-react";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  projectHistoryStatusLabels,
  type ProjectHistoryEntry,
} from "@/lib/consultants/project-history";
import { formatDate } from "@/lib/format";

export interface ConsultantProjectHistorySectionProps {
  /** null = ainda carregando; `{ error }` = falha na leitura. */
  entries: ProjectHistoryEntry[] | { error: string } | null;
}

const columns: DataTableColumn<ProjectHistoryEntry>[] = [
  {
    key: "project",
    header: "Projeto",
    cell: (e) => (
      <div className="min-w-0">
        <p className="truncate font-semibold text-strong">{e.projectName}</p>
        <p className="truncate text-xs text-soft">{e.clientName}</p>
      </div>
    ),
  },
  { key: "role", header: "Perfil no projeto", cell: (e) => e.role || "—" },
  {
    key: "start",
    header: "Início",
    cell: (e) => <span className="tabular-nums">{formatDate(e.startDate)}</span>,
  },
  {
    key: "end",
    header: "Fim",
    cell: (e) => (
      <span className="tabular-nums">
        {e.endDate ? formatDate(e.endDate) : "Em aberto"}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (e) => (
      <StatusBadge tone={e.status === "ACTIVE" ? "success" : "neutral"}>
        {projectHistoryStatusLabels[e.status]}
      </StatusBadge>
    ),
  },
];

/**
 * Histórico de projetos do consultor (somente leitura). Derivado das alocações:
 * para alterar perfil, datas ou status, edite o vínculo em Projetos.
 */
export function ConsultantProjectHistorySection({
  entries,
}: ConsultantProjectHistorySectionProps) {
  if (entries === null) {
    return (
      <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-medium">
        Carregando histórico...
      </p>
    );
  }
  if (!Array.isArray(entries)) {
    return (
      <p
        role="alert"
        className="rounded-md border-2 border-danger bg-danger-soft px-3 py-2 text-sm font-medium text-danger"
      >
        Não foi possível carregar o histórico de projetos. {entries.error}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-soft">
        Vem dos vínculos (alocações) do consultor. Para alterar perfil, datas ou
        status, edite o vínculo em Projetos.
      </p>
      <DataTable
        columns={columns}
        rows={entries}
        rowKey={(e) => e.allocationId}
        caption="Histórico de projetos do consultor"
        empty={
          <EmptyState
            icon={FolderKanban}
            title="Sem projetos"
            description="Este consultor ainda não foi alocado em nenhum projeto."
          />
        }
      />
    </div>
  );
}
