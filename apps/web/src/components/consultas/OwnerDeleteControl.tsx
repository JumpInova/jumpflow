"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { excluirPainel, excluirVisao } from "@/app/app/consultas/visoes/actions";
import { excluirAgendamento } from "@/app/app/consultas/agendamentos/actions";

export interface OwnerDeleteControlProps {
  kind: "visao" | "painel" | "agendamento";
  id: string;
  /** Envios agendados (de qualquer pessoa) que serão removidos junto. */
  scheduleCount?: number;
}

/** Aviso de exclusão quando há envios agendados usando o alvo. */
export function scheduleRemovalNotice(count: number, pronoun: "a" | "o" = "a"): string {
  if (count <= 0) return "";
  return count === 1
    ? ` 1 envio agendado que ${pronoun} usa também será removido.`
    : ` ${count} envios agendados que ${pronoun} usam também serão removidos.`;
}


/**
 * Exclusão pelo dono quando o perfil não pode mais EDITAR (sem CRIAR, para
 * visão/painel; sem AGENDAR, para agendamento): excluir segue liberado.
 */
export function OwnerDeleteControl({ kind, id, scheduleCount = 0 }: OwnerDeleteControlProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const noun = kind === "visao" ? "visão" : kind === "painel" ? "painel" : "agendamento";
  const article = kind === "visao" ? "esta" : "este";
  const plural = kind === "visao" ? "visões" : kind === "painel" ? "painéis" : "agendamentos";
  const permission = kind === "agendamento" ? "Agendar envio" : "Criar consultas";
  const listHref =
    kind === "visao"
      ? "/app/consultas/visoes"
      : kind === "painel"
        ? "/app/consultas/paineis"
        : "/app/consultas/agendamentos";

  function remove() {
    setError(null);
    startTransition(async () => {
      const response =
        kind === "visao"
          ? await excluirVisao(id)
          : kind === "painel"
            ? await excluirPainel(id)
            : await excluirAgendamento(id);
      if (!response.ok) {
        setError(response.error);
        setConfirming(false);
        return;
      }
      router.push(listHref);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-medium">
        Seu perfil não tem permissão para editar {plural} ({permission}). Você ainda pode excluir{" "}
        {article} {noun}.
      </p>
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <div role="alertdialog" aria-label="Confirmar exclusão" className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-medium">
            Excluir {article} {noun} para todos?{kind === "agendamento" ? "" : scheduleRemovalNotice(scheduleCount, kind === "visao" ? "a" : "o")}
          </span>
          <ActionButton size="sm" variant="danger" icon={Trash2} disabled={pending} onClick={remove}>
            {pending ? "Excluindo…" : "Sim, excluir"}
          </ActionButton>
          <ActionButton size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
            Cancelar
          </ActionButton>
        </div>
      ) : (
        <ActionButton size="sm" variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
          Excluir {noun}
        </ActionButton>
      )}
    </div>
  );
}
