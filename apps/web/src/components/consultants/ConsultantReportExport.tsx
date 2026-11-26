"use client";

import { useState, type FormEvent } from "react";
import { FileSpreadsheet } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { Modal } from "@/components/ui/Modal";
import { SearchableSelect } from "@/components/ui/SearchableSelect";
import { focusRingInput } from "@/lib/styles";
import { cn } from "@/lib/utils";

/** Endpoint do relatório (RBAC recomputado no servidor a partir do usuário real). */
export const CONSULTANT_REPORT_ENDPOINT = "/api/consultores/relatorio";
const FORM_ID = "consultant-report-export-form";

export interface ConsultantReportExportProps {
  /** Áreas distintas para o filtro (derivadas da listagem). */
  areas: string[];
}

function selectClass() {
  return cn(
    "h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-strong",
    focusRingInput,
  );
}

const ERROR_MESSAGES: Record<number, string> = {
  400: "Filtro inválido. Revise as opções e tente novamente.",
  403: "Você não tem permissão para exportar este relatório.",
  503: "Banco de dados indisponível neste ambiente.",
};

/** Nome do arquivo vindo do Content-Disposition (fallback genérico). */
function filenameFrom(response: Response): string {
  const header = response.headers.get("Content-Disposition") ?? "";
  return /filename="([^"]+)"/.exec(header)?.[1] ?? "relatorio-consultores.xlsx";
}

/**
 * "Exportar relatório": XLSX de consultores × projetos (perfil, início, fim e
 * se está ativo). Baixa via fetch + blob para manter o usuário na tela e
 * mostrar erros (403/400/503) no próprio modal. Visível apenas a quem tem o
 * gate do relatório (decidido na página; o endpoint revalida).
 */
export function ConsultantReportExport({ areas }: ConsultantReportExportProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const query = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && value !== "") query.set(key, value);
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${CONSULTANT_REPORT_ENDPOINT}?${query.toString()}`,
      );
      if (!response.ok) {
        setError(
          ERROR_MESSAGES[response.status] ??
            "Não foi possível gerar o relatório. Tente novamente.",
        );
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response);
      link.click();
      URL.revokeObjectURL(url);
      close();
    } catch {
      setError("Falha de conexão ao gerar o relatório. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ActionButton
        variant="secondary"
        size="sm"
        icon={FileSpreadsheet}
        onClick={() => setOpen(true)}
      >
        Exportar relatório
      </ActionButton>
      <Modal
        open={open}
        onClose={close}
        title="Relatório de consultores"
        description="Planilha com o histórico de projetos de cada consultor: projeto, perfil, início, fim e status."
        footer={
          <div className="flex justify-end gap-2">
            <ActionButton variant="secondary" onClick={close}>
              Cancelar
            </ActionButton>
            <ActionButton
              type="submit"
              form={FORM_ID}
              icon={FileSpreadsheet}
              disabled={busy}
            >
              {busy ? "Gerando..." : "Exportar Excel"}
            </ActionButton>
          </div>
        }
      >
        <form
          id={FORM_ID}
          onSubmit={handleSubmit}
          className="grid gap-3 md:grid-cols-3"
        >
          {error ? (
            <p
              role="alert"
              className="rounded-md border-2 border-danger bg-danger-soft px-3 py-2 text-sm font-medium text-danger md:col-span-3"
            >
              {error}
            </p>
          ) : null}
          <label className="space-y-1 text-sm font-medium text-medium">
            Área
            <SearchableSelect name="area" defaultValue="" className={selectClass()}>
              <option value="">Todas</option>
              {areas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="space-y-1 text-sm font-medium text-medium">
            Status do consultor
            <SearchableSelect
              name="consultantStatus"
              defaultValue="ACTIVE"
              className={selectClass()}
            >
              <option value="">Todos</option>
              <option value="ACTIVE">Ativo</option>
              <option value="ON_LEAVE">Afastado</option>
              <option value="INACTIVE">Inativo</option>
            </SearchableSelect>
          </label>
          <label className="space-y-1 text-sm font-medium text-medium">
            Status no projeto
            <SearchableSelect
              name="projectStatus"
              defaultValue=""
              className={selectClass()}
            >
              <option value="">Todos (histórico completo)</option>
              <option value="ACTIVE">Somente ativos</option>
              <option value="INACTIVE">Somente inativos</option>
            </SearchableSelect>
          </label>
        </form>
      </Modal>
    </>
  );
}
