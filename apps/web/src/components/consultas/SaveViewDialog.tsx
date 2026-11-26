"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { atualizarVisao, salvarVisao } from "@/app/app/consultas/visoes/actions";
import type { ConsultaSpec } from "@/lib/consultas/types";
import { ViewForm, type ViewFormValue } from "./ViewForm";

export interface EditingView extends ViewFormValue {
  id: string;
}

export interface SaveViewDialogProps {
  open: boolean;
  onClose: () => void;
  spec: ConsultaSpec;
  canShare: boolean;
  /** Visão aberta no construtor (dono): permite atualizar em vez de criar. */
  editing?: EditingView;
}

/**
 * Salva a consulta do construtor como visão. A spec vai para o servidor, que a
 * valida de novo com a permissão do dono antes de gravar.
 */
export function SaveViewDialog({ open, onClose, spec, canShare, editing }: SaveViewDialogProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"update" | "create">(editing ? "update" : "create");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const grouped = spec.groupBy.length > 0;

  const initial: ViewFormValue =
    editing && mode === "update"
      ? editing
      : {
          name: editing ? `${editing.name} (cópia)` : "",
          description: editing?.description ?? "",
          visualization: editing?.visualization ?? (grouped ? "BAR" : "TABLE"),
          sharing: "PRIVATE",
          sharedRoles: [],
        };

  function submit(value: ViewFormValue) {
    setError(null);
    startTransition(async () => {
      const form = { ...value, description: value.description || null };
      if (editing && mode === "update") {
        const response = await atualizarVisao(editing.id, form, spec);
        if (!response.ok) {
          setError(response.error);
          return;
        }
        onClose();
        router.push(`/app/consultas/visoes/${editing.id}`);
        return;
      }
      const response = await salvarVisao(spec, form);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      onClose();
      router.push(`/app/consultas/visoes/${response.data.id}`);
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing && mode === "update" ? "Atualizar visão" : "Salvar como visão"}
      description="A visão guarda a consulta (filtros, colunas, agrupamentos e medidas), não os dados: cada abertura roda de novo."
    >
      {editing ? (
        <fieldset className="mb-4 space-y-1.5">
          <legend className="sr-only">O que fazer</legend>
          <label className="flex items-center gap-2 text-sm text-medium">
            <input type="radio" name="save-mode" checked={mode === "update"} onChange={() => setMode("update")} />
            Atualizar “{editing.name}”
          </label>
          <label className="flex items-center gap-2 text-sm text-medium">
            <input type="radio" name="save-mode" checked={mode === "create"} onChange={() => setMode("create")} />
            Salvar como nova visão
          </label>
        </fieldset>
      ) : null}
      <ViewForm
        key={mode}
        idPrefix="save-view"
        initial={initial}
        canShare={canShare}
        chartHint={grouped ? undefined : "Gráficos precisam de uma consulta agrupada (Agrupar e somar)."}
        submitLabel={editing && mode === "update" ? "Salvar alterações" : "Salvar visão"}
        pending={pending}
        error={error}
        onSubmit={submit}
      />
    </Modal>
  );
}
