"use client";

import { useId, useState, useTransition } from "react";
import { Play, Sparkles, Wrench, X } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { gerarConsultaComIA } from "@/app/app/consultas/actions";
import { AI_REQUEST_LIMITS } from "@/lib/consultas/ai";
import type { ConsultaSpec } from "@/lib/consultas/types";
import { focusRingInput } from "@/lib/styles";
import { cn } from "@/lib/utils";

export interface ConsultaAssistantProps {
  /** Provider de IA configurado no servidor. Sem ele, só o aviso. */
  available: boolean;
  /** Aplica a spec confirmada no construtor (e opcionalmente roda). */
  onApply: (spec: ConsultaSpec, runNow: boolean) => void;
}

interface Proposal {
  spec: ConsultaSpec;
  entityLabel: string;
  explanation: string[];
}

/**
 * Assistente de IA (C3): o usuário descreve a consulta; o servidor devolve uma
 * spec validada + explicação determinística. Nada roda sem confirmação.
 */
export function ConsultaAssistant({ available, onApply }: ConsultaAssistantProps) {
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [pending, startTransition] = useTransition();

  if (!available) {
    return (
      <SectionPanel title="Assistente de IA">
        <p className="p-4 text-sm text-medium">
          O assistente de IA está indisponível no momento. Monte a consulta no construtor abaixo.
        </p>
      </SectionPanel>
    );
  }

  const trimmed = text.trim();
  const tooShort = trimmed.length < AI_REQUEST_LIMITS.min;

  function ask() {
    if (tooShort || pending) return;
    setError(null);
    setProposal(null);
    startTransition(async () => {
      let response: Awaited<ReturnType<typeof gerarConsultaComIA>>;
      try {
        response = await gerarConsultaComIA(trimmed);
      } catch {
        // Falha de rede/servidor (a action rejeitou): mensagem fixa, construtor segue.
        setError("Não foi possível falar com o assistente agora. Tente de novo ou use o construtor.");
        return;
      }
      if (response.ok) {
        setProposal({
          spec: response.spec,
          entityLabel: response.entityLabel,
          explanation: response.explanation,
        });
      } else {
        setError(response.error);
      }
    });
  }

  function apply(runNow: boolean) {
    if (!proposal) return;
    onApply(proposal.spec, runNow);
    setProposal(null);
  }

  return (
    <SectionPanel
      title="Assistente de IA"
      description="Descreva o que quer ver. Você confere o que foi montado antes de rodar."
    >
      <form
        className="space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <label htmlFor={inputId} className="block text-sm font-semibold text-strong">
          O que você quer consultar?
        </label>
        <textarea
          id={inputId}
          aria-describedby={hintId}
          rows={2}
          maxLength={AI_REQUEST_LIMITS.max}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              ask();
            }
          }}
          placeholder="Ex.: horas aprovadas por projeto neste mês, do maior para o menor"
          className={cn(
            "w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm text-strong",
            focusRingInput,
          )}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={hintId} className="text-xs text-soft">
            A IA recebe só o catálogo de dados que seu perfil pode ver — nunca os dados.{" "}
            {text.length}/{AI_REQUEST_LIMITS.max}
          </p>
          <ActionButton type="submit" size="sm" icon={Sparkles} disabled={tooShort || pending}>
            {pending ? "Montando…" : "Montar consulta"}
          </ActionButton>
        </div>

        <div aria-live="polite" className="space-y-3">
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-medium text-danger"
            >
              {error}
            </p>
          ) : null}
          {proposal ? (
            <div className="space-y-3 rounded-md border border-border bg-surface-muted p-3">
              <p className="text-sm font-semibold text-strong">
                Consulta montada sobre {proposal.entityLabel}. Confira:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-medium">
                {proposal.explanation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <ActionButton type="button" size="sm" icon={Play} onClick={() => apply(true)}>
                  Confirmar e rodar
                </ActionButton>
                <ActionButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  icon={Wrench}
                  onClick={() => apply(false)}
                >
                  Ajustar no construtor
                </ActionButton>
                <ActionButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  icon={X}
                  onClick={() => setProposal(null)}
                >
                  Descartar
                </ActionButton>
              </div>
            </div>
          ) : null}
        </div>
      </form>
    </SectionPanel>
  );
}
