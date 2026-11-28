"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, X } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { FeedbackBanner, useFeedback } from "@/components/ui/Feedback";
import { SectionPanel, type SectionPanelVariant } from "@/components/ui/SectionPanel";
import { dismissM365TimeSuggestion } from "@/app/app/horas/m365-suggestion-actions";
import type { TimeSuggestionView } from "@/lib/db/m365";
import { formatHours } from "@/lib/format";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

export interface Microsoft365TimeSuggestionsPanelProps {
  suggestions: TimeSuggestionView[];
  /** yyyy-mm-dd da segunda-feira da semana visível. */
  weekStart: string;
  /** Sem a tela cheia de lançamento, "Usar" não aparece (só ignorar). */
  canPrefill: boolean;
  presentation: SectionPanelVariant;
}

function when(s: TimeSuggestionView): string {
  const opts = { timeZone: "America/Sao_Paulo" } as const;
  const day = new Date(s.startAt).toLocaleDateString("pt-BR", { ...opts, weekday: "short", day: "2-digit", month: "2-digit" });
  const start = new Date(s.startAt).toLocaleTimeString("pt-BR", { ...opts, hour: "2-digit", minute: "2-digit" });
  const end = new Date(s.endAt).toLocaleTimeString("pt-BR", { ...opts, hour: "2-digit", minute: "2-digit" });
  return `${day} · ${start}–${end}`;
}

/**
 * Sugestões de lançamento vindas da agenda (Microsoft 365). Nunca lança nada:
 * "Usar" abre o formulário de lançamento já preenchido (projeto, data e horário)
 * para o consultor revisar e enviar; com mais de um projeto possível, ele
 * escolhe. "Ignorar" esconde a sugestão.
 */
export function Microsoft365TimeSuggestionsPanel({
  suggestions,
  weekStart,
  canPrefill,
  presentation,
}: Microsoft365TimeSuggestionsPanelProps) {
  const router = useRouter();
  const { feedback, notify } = useFeedback();
  const [pending, startTransition] = useTransition();

  if (suggestions.length === 0) return null;

  function dismiss(id: string) {
    startTransition(async () => {
      const result = await dismissM365TimeSuggestion(id);
      if (!result.ok) notify("warning", result.message);
      router.refresh();
    });
  }

  return (
    <SectionPanel
      variant={presentation}
      title="Sugestões da sua agenda"
      description="Reuniões com clientes dos seus projetos. Nada é lançado sem você revisar e enviar."
    >
      {feedback ? (
        <div className="px-5 pt-4">
          <FeedbackBanner message={feedback} />
        </div>
      ) : null}
      <ul className="divide-y divide-border">
        {suggestions.map((s) => (
          <li key={s.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-semibold text-strong">
                <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-medium" />
                <span className="truncate">{s.subject ?? "Reunião"}</span>
              </p>
              <p className="mt-0.5 text-xs text-soft">
                {when(s)} · {formatHours(s.minutes / 60)}
                {s.matchKind === "DOMAIN" ? " · vínculo pelo domínio do cliente" : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canPrefill
                ? s.projects.map((p) => (
                    <Link
                      key={p.id}
                      href={`/app/horas/lancamento?semana=${weekStart}&sugestao=${encodeURIComponent(s.id)}&projeto=${encodeURIComponent(p.id)}`}
                      className={cn(
                        "inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-xs font-semibold text-strong transition-colors hover:bg-surface-muted",
                        focusRing,
                      )}
                      title={`Pré-preencher o lançamento em ${p.name}`}
                    >
                      {s.projects.length > 1 ? `Usar em ${p.name}` : `Usar · ${p.name}`}
                    </Link>
                  ))
                : null}
              <ActionButton
                size="sm"
                variant="secondary"
                tactile={presentation !== "quiet"}
                icon={X}
                disabled={pending}
                onClick={() => dismiss(s.id)}
              >
                Ignorar
              </ActionButton>
            </div>
          </li>
        ))}
      </ul>
    </SectionPanel>
  );
}
