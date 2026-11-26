"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { atualizarVisao, excluirVisao } from "@/app/app/consultas/visoes/actions";
import { scheduleRemovalNotice } from "./OwnerDeleteControl";
import { ViewForm, type ViewFormValue } from "./ViewForm";

export interface ViewOwnerPanelProps {
  viewId: string;
  initial: ViewFormValue;
  canShare: boolean;
  grouped: boolean;
  /** Envios agendados que usam a visão (removidos junto ao excluir). */
  scheduleCount?: number;
}

/** Ajustes do dono: nome, visualização, compartilhamento e exclusão. */
export function ViewOwnerPanel({ viewId, initial, canShare, grouped, scheduleCount = 0 }: ViewOwnerPanelProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function save(value: ViewFormValue) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const response = await atualizarVisao(viewId, { ...value, description: value.description || null });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setNotice("Visão atualizada.");
      router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const response = await excluirVisao(viewId);
      if (!response.ok) {
        setError(response.error);
        setConfirming(false);
        return;
      }
      router.push("/app/consultas/visoes");
    });
  }

  return (
    <div className="space-y-4 p-4">
      <ViewForm
        idPrefix="view-settings"
        initial={initial}
        canShare={canShare}
        chartHint={grouped ? undefined : "Gráficos precisam de uma consulta agrupada (Agrupar e somar)."}
        submitLabel="Salvar ajustes"
        pending={pending}
        error={error}
        onSubmit={save}
      />
      {notice ? (
        <p role="status" className="text-sm font-medium text-success">
          {notice}
        </p>
      ) : null}
      <div className="border-t border-border pt-4">
        {confirming ? (
          <div role="alertdialog" aria-label="Confirmar exclusão" className="space-y-2">
            <p className="text-sm text-medium">
              Excluir esta visão? Ela some para todos com quem foi compartilhada e dos painéis que a usam.
              {scheduleRemovalNotice(scheduleCount)}
            </p>
            <div className="flex flex-wrap gap-2">
              <ActionButton size="sm" variant="danger" icon={Trash2} disabled={pending} onClick={remove}>
                {pending ? "Excluindo…" : "Sim, excluir"}
              </ActionButton>
              <ActionButton size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
                Cancelar
              </ActionButton>
            </div>
          </div>
        ) : (
          <ActionButton size="sm" variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
            Excluir visão
          </ActionButton>
        )}
      </div>
    </div>
  );
}
