"use client";

import { useState, useTransition } from "react";
import { Check, CheckCheck, ExternalLink, Loader2, Mail, MailSearch, Video, X } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import type { FeedbackTone } from "@/components/ui/Feedback";
import {
  actionItemStatusLabels,
  canTransitionActionItem,
  emailMinutesStatusLabels,
  teamsTranscriptErrorLabel,
  teamsTranscriptStatusLabels,
  type ActionItemStatus,
  type TeamsTranscriptStatusView,
  type CheckpointActionItemView,
  type CheckpointM365View,
} from "@/lib/checkpoint/action-items";
import type { MinutesChoiceView } from "@/lib/m365/minutes/run";
import {
  chooseCheckpointMinutesEmail,
  decideCheckpointActionItem,
  fetchCheckpointTeamsTranscript,
  listCheckpointMinutesCandidates,
  searchCheckpointMinutes,
} from "@/app/app/checkpoints/m365-actions";

export interface CheckpointM365PanelProps {
  checkpointId: string;
  view: CheckpointM365View;
  /** Autor/PEOPLE/ADMIN: valida os cards de ação. */
  canManage: boolean;
  notify: (tone: FeedbackTone, text: string) => void;
}

const MINUTES_TONE: Record<NonNullable<CheckpointM365View["minutes"]>["status"], StatusTone> = {
  SEARCHING: "neutral",
  AMBIGUOUS: "warning",
  DONE: "success",
  FAILED: "danger",
};

const TEAMS_TONE: Record<TeamsTranscriptStatusView, StatusTone> = {
  PENDING: "neutral",
  WAITING_TRANSCRIPT: "neutral",
  GENERATING: "info",
  DONE: "success",
  NO_TRANSCRIPT: "warning",
  FAILED: "danger",
};

const ACTION_TONE: Record<ActionItemStatus, StatusTone> = {
  PENDING: "neutral",
  ACCEPTED: "info",
  DONE: "success",
  DISMISSED: "warning",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatDay(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Microsoft 365 (M2) na tela do Checkpoint: estado da ata por e-mail
 * ("Buscar ata no e-mail", escolha em caso de empate) e os cards de
 * Ação/próximo passo para o gestor validar. Só é renderizado para quem vê o
 * CRU do checkpoint (o servidor já não envia nada ao consultor avaliado).
 */
export function CheckpointM365Panel({ checkpointId, view, canManage, notify }: CheckpointM365PanelProps) {
  const [pending, startTransition] = useTransition();
  const [choices, setChoices] = useState<MinutesChoiceView[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [decided, setDecided] = useState<Record<string, ActionItemStatus>>({});
  const status = view.minutes?.status ?? null;
  const showMinutes = view.linkedToEvent || view.minutes !== null;

  function search() {
    startTransition(async () => {
      const result = await searchCheckpointMinutes(checkpointId);
      if (!result.ok) {
        notify("warning", result.message);
        return;
      }
      notify(result.data.outcome.startsWith("saved") ? "success" : "info", result.data.message);
      if (result.data.outcome === "ambiguous") loadChoices();
    });
  }

  function fetchTranscript() {
    startTransition(async () => {
      const result = await fetchCheckpointTeamsTranscript(checkpointId);
      if (!result.ok) {
        notify("warning", result.message);
        return;
      }
      notify(result.data.outcome.startsWith("saved") ? "success" : "info", result.data.message);
    });
  }

  function loadChoices() {
    startTransition(async () => {
      const result = await listCheckpointMinutesCandidates(checkpointId);
      if (!result.ok) {
        notify("warning", result.message);
        return;
      }
      setChoices(result.data);
      setSelected("");
      if (result.data.length === 0) notify("info", "Nenhum e-mail candidato encontrado agora.");
    });
  }

  function choose() {
    if (!selected) return;
    startTransition(async () => {
      const result = await chooseCheckpointMinutesEmail({ checkpointId, messageId: selected });
      if (!result.ok) {
        notify("warning", result.message);
        return;
      }
      notify(result.data.outcome.startsWith("saved") ? "success" : "warning", result.data.message);
      if (result.data.outcome.startsWith("saved")) setChoices(null);
    });
  }

  function decide(item: CheckpointActionItemView, next: "ACCEPTED" | "DONE" | "DISMISSED") {
    startTransition(async () => {
      const result = await decideCheckpointActionItem({ id: item.id, status: next });
      if (result.ok) {
        setDecided((prev) => ({ ...prev, [item.id]: result.data.status }));
        notify("success", `Ação marcada como ${actionItemStatusLabels[result.data.status].toLowerCase()}.`);
      } else {
        notify("warning", result.message);
      }
    });
  }

  const teams = view.teams ?? null;
  const teamsError = teams ? teamsTranscriptErrorLabel(teams.lastError) : null;

  return (
    <div className="space-y-4" data-testid="checkpoint-m365">
      {teams ? (
        <section aria-label="Transcrição do Teams" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold text-strong">
              <Video aria-hidden="true" className="size-4" />
              Transcrição do Teams
            </span>
            <StatusBadge tone={teams.status ? TEAMS_TONE[teams.status] : "neutral"}>
              {teams.status ? teamsTranscriptStatusLabels[teams.status] : "Não consultada"}
            </StatusBadge>
            {teams.action ? (
              <ActionButton
                variant="secondary"
                size="sm"
                icon={pending ? Loader2 : Video}
                disabled={pending}
                onClick={fetchTranscript}
                className="ml-auto"
              >
                {teams.action === "generate" ? "Buscar transcrição do Teams" : "Complementar com a transcrição do Teams"}
              </ActionButton>
            ) : null}
          </div>
          {teams.status === "DONE" ? (
            <p className="text-xs text-soft">
              {teams.mode === "SUPPLEMENT" ? "Complementou a ata existente" : "Gerou a ata deste checkpoint"}
              {teams.aiSummary ? " · resumida pela IA" : " · sem resumo da IA"}
              {teams.truncated ? " · reunião longa, resumida parcialmente" : ""}
            </p>
          ) : (
            <p className="text-xs text-soft">
              {teamsError ??
                (teams.action === "supplement"
                  ? "Este checkpoint já tem ata ou notas. A transcrição só entra se você pedir, como complemento — nada é sobrescrito."
                  : view.isOwnManager
                    ? "Para reuniões do Teams que você organizou, a transcrição é lida na sua conta (até 48 h após o fim), mascarada antes da IA e não é guardada em bruto."
                    : "A transcrição é lida só na conta do gestor que organizou a reunião.")}
            </p>
          )}
        </section>
      ) : null}

      {showMinutes ? (
        <section aria-label="Ata por e-mail" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold text-strong">
              <Mail aria-hidden="true" className="size-4" />
              Ata por e-mail
            </span>
            <StatusBadge tone={status ? MINUTES_TONE[status] : "neutral"}>
              {status ? emailMinutesStatusLabels[status] : "Aguardando a ata"}
            </StatusBadge>
            {view.isOwnManager && status !== "DONE" ? (
              <ActionButton
                variant="secondary"
                size="sm"
                icon={pending ? Loader2 : MailSearch}
                disabled={pending}
                onClick={search}
                className="ml-auto"
              >
                Buscar ata no e-mail
              </ActionButton>
            ) : null}
          </div>

          {view.minutes?.status === "DONE" ? (
            <p className="text-xs text-soft">
              Recebido em {formatDateTime(view.minutes.receivedAt)}
              {view.minutes.aiSummary ? " · resumido pela IA" : " · sem resumo da IA"}
              {view.minutes.attachmentsUsed > 0 ? ` · ${view.minutes.attachmentsUsed} anexo(s) lido(s)` : ""}
              {view.minutes.attachmentsSkipped > 0
                ? ` · ${view.minutes.attachmentsSkipped} anexo(s) não suportado(s)`
                : ""}
              {view.minutes.webLink ? (
                <>
                  {" · "}
                  <a
                    href={view.minutes.webLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-brand-dark underline underline-offset-2"
                  >
                    Abrir no Outlook
                    <ExternalLink aria-hidden="true" className="size-3" />
                  </a>
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-soft">
              {view.isOwnManager
                ? "Procuramos só na sua caixa: e-mails com a categoria “JumpFlow” ou com o assunto da reunião, até 7 dias depois dela. Nada além da ata escolhida é guardado."
                : "A ata é procurada só na caixa do gestor que registra este checkpoint."}
            </p>
          )}

          {view.isOwnManager && status === "AMBIGUOUS" && choices === null ? (
            <ActionButton variant="secondary" size="sm" disabled={pending} onClick={loadChoices}>
              Escolher o e-mail da ata
            </ActionButton>
          ) : null}

          {choices && choices.length > 0 ? (
            <fieldset className="space-y-2 rounded-md border border-border bg-surface-muted p-3">
              <legend className="px-1 text-xs font-semibold text-medium">
                Qual e-mail é a ata desta reunião?
              </legend>
              <p className="text-xs text-soft">
                Lidos agora da sua caixa. Os que você não escolher não são guardados.
              </p>
              <ul className="space-y-2">
                {choices.map((choice) => (
                  <li key={choice.messageId}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface p-2 text-sm">
                      <input
                        type="radio"
                        name={`minutes-${checkpointId}`}
                        value={choice.messageId}
                        checked={selected === choice.messageId}
                        onChange={() => setSelected(choice.messageId)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold text-strong">{choice.subject ?? "(sem assunto)"}</span>
                        <span className="block text-xs text-soft">
                          {choice.fromName ?? choice.fromEmail ?? "Remetente desconhecido"} ·{" "}
                          {formatDateTime(choice.receivedAt)}
                          {choice.hasAttachments ? " · com anexo" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <ActionButton size="sm" icon={Check} disabled={pending || !selected} onClick={choose}>
                  Usar este e-mail
                </ActionButton>
                <ActionButton variant="secondary" size="sm" disabled={pending} onClick={() => setChoices(null)}>
                  Cancelar
                </ActionButton>
              </div>
            </fieldset>
          ) : null}
        </section>
      ) : null}

      {view.actionItems.length > 0 ? (
        <section aria-label="Ações e próximos passos" className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-soft">Ações / próximos passos</h4>
          <ul className="space-y-2">
            {view.actionItems.map((item) => {
              const current = decided[item.id] ?? item.status;
              return (
                <li key={item.id} className="rounded-md border border-border bg-surface p-3" data-testid="action-item">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={ACTION_TONE[current]}>{actionItemStatusLabels[current]}</StatusBadge>
                    <span className="text-sm font-semibold text-strong">{item.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-soft">
                    Responsável: {item.ownerText ?? "não informado"} · Prazo:{" "}
                    {item.dueDate ? formatDay(item.dueDate) : (item.dueText ?? "não informado")}
                  </p>
                  {item.sourceQuote ? (
                    <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs italic text-soft">
                      “{item.sourceQuote}”
                    </blockquote>
                  ) : null}
                  {canManage && (canTransitionActionItem(current, "ACCEPTED") || canTransitionActionItem(current, "DONE")) ? (
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      {canTransitionActionItem(current, "ACCEPTED") ? (
                        <ActionButton variant="success" size="sm" icon={Check} disabled={pending} onClick={() => decide(item, "ACCEPTED")}>
                          Aceitar
                        </ActionButton>
                      ) : null}
                      <ActionButton variant="secondary" size="sm" icon={CheckCheck} disabled={pending} onClick={() => decide(item, "DONE")}>
                        Concluir
                      </ActionButton>
                      <ActionButton variant="secondary" size="sm" icon={X} disabled={pending} onClick={() => decide(item, "DISMISSED")}>
                        Descartar
                      </ActionButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
