"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, Link2, Mail, Pause, Play, RefreshCw, Unplug } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { FeedbackBanner, useFeedback, type FeedbackTone } from "@/components/ui/Feedback";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import {
  disconnectM365,
  setM365Paused,
  syncM365Now,
} from "@/app/app/conta/microsoft-365/actions";
import type { M365ConnectionView } from "@/lib/db/m365";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<M365ConnectionView["status"], { label: string; tone: StatusTone }> = {
  ACTIVE: { label: "Conectado", tone: "success" },
  PAUSED: { label: "Pausado", tone: "neutral" },
  REAUTH_REQUIRED: { label: "Reconexão necessária", tone: "warning" },
  ERROR: { label: "Erro de configuração", tone: "danger" },
  DISCONNECTED: { label: "Desconectado", tone: "neutral" },
};

/** Rótulos legíveis dos escopos (o técnico fica entre parênteses). */
const SCOPE_LABEL: Record<string, string> = {
  openid: "Identificação da conta",
  profile: "Nome e perfil básico",
  offline_access: "Manter a conexão ativa (renovação automática)",
  "user.read": "Ler o seu perfil",
  "calendars.read": "Ler a sua agenda (somente leitura)",
  "mail.read": "Ler e-mails de ata de checkpoint (somente leitura)",
};

function scopeLabel(scope: string): string {
  const key = scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
  return SCOPE_LABEL[key] ?? scope;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

export interface Microsoft365ConnectionPanelProps {
  view: M365ConnectionView | null;
  connectHref: string;
  /** Configuração completa (credenciais/URL). Sem ela, "Conectar" fica desabilitado. */
  configured: boolean;
  notice: { tone: FeedbackTone; text: string } | null;
  /** M2: o usuário registra checkpoints (gestor) e pode ativar as atas por e-mail. */
  canEnableMinutes?: boolean;
}

function hasMail(view: M365ConnectionView | null): boolean {
  return Boolean(view?.scopes.some((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase() === "mail.read"));
}

export function Microsoft365ConnectionPanel({
  view,
  connectHref,
  configured,
  notice,
  canEnableMinutes = false,
}: Microsoft365ConnectionPanelProps) {
  const router = useRouter();
  const { feedback, notify } = useFeedback();
  const [pending, startTransition] = useTransition();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const shown = feedback ?? notice;

  const connected = view && view.status !== "DISCONNECTED";
  const needsConnect = !view || view.status === "DISCONNECTED" || view.status === "REAUTH_REQUIRED" || view.status === "ERROR";
  const status = view ? STATUS_LABEL[view.status] : STATUS_LABEL.DISCONNECTED;
  const mailEnabled = hasMail(view);
  // Reconectar mantém a fase consentida (com e-mail, se já estava ativo).
  const minutesHref = `${connectHref}?fase=M2`;
  const reconnectHref = mailEnabled && canEnableMinutes ? minutesHref : connectHref;

  function run(action: () => Promise<{ ok: boolean; message?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) notify("success", success);
      else notify("warning", result.message ?? "Não foi possível concluir a ação.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {shown ? <FeedbackBanner message={shown} /> : null}

      <SectionPanel
        title="Sua conexão"
        description="Conexão pessoal e opcional. Só você conecta, pausa ou desconecta a sua conta."
        action={
          <StatusBadge tone={status.tone} pill>
            {status.label}
          </StatusBadge>
        }
      >
        <div className="space-y-5 px-5 py-5">
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs font-semibold text-medium">Conta</dt>
              <dd className="mt-1 break-all text-strong">{connected ? (view?.mailbox ?? "—") : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-medium">Último sync</dt>
              <dd className="mt-1 text-strong">
                {view?.syncing ? "Sincronizando…" : formatDateTime(view?.lastSyncAt ?? null)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-medium">Último erro</dt>
              <dd className="mt-1 text-strong">
                {view?.lastError ? (
                  <span>
                    <code className="rounded bg-surface-muted px-1 text-xs">{view.lastError}</code>{" "}
                    <span className="text-soft">em {formatDateTime(view.lastErrorAt)}</span>
                  </span>
                ) : (
                  "Nenhum"
                )}
              </dd>
            </div>
          </dl>

          {connected && view.scopes.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-medium">Permissões concedidas</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {view.scopes.map((scope) => (
                  <li key={scope}>
                    <StatusBadge tone="info" pill>
                      {scopeLabel(scope)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {needsConnect ? (
              configured ? (
                <a
                  href={view && view.status !== "DISCONNECTED" ? reconnectHref : connectHref}
                  className={cn(
                    "inline-flex h-10 items-center gap-2 rounded-md bg-brand-fill px-4 text-sm font-semibold text-white transition-colors hover:opacity-90",
                    focusRing,
                  )}
                >
                  <Link2 aria-hidden="true" className="size-4" />
                  {view && view.status !== "DISCONNECTED" ? "Reconectar conta Microsoft" : "Conectar conta Microsoft"}
                </a>
              ) : (
                <p className="text-sm text-soft">
                  A integração ainda não foi configurada pelo administrador.
                </p>
              )
            ) : null}

            {view?.status === "ACTIVE" ? (
              <>
                <ActionButton
                  variant="secondary"
                  icon={RefreshCw}
                  disabled={pending}
                  onClick={() => run(syncM365Now, "Sincronização concluída.")}
                >
                  Sincronizar agora
                </ActionButton>
                <ActionButton
                  variant="secondary"
                  icon={Pause}
                  disabled={pending}
                  onClick={() => run(() => setM365Paused(true), "Conexão pausada. Nada será lido até você retomar.")}
                >
                  Pausar
                </ActionButton>
              </>
            ) : null}

            {view?.status === "PAUSED" ? (
              <ActionButton
                variant="secondary"
                icon={Play}
                disabled={pending}
                onClick={() => run(() => setM365Paused(false), "Conexão retomada.")}
              >
                Retomar
              </ActionButton>
            ) : null}

            {connected ? (
              confirmDisconnect ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-medium">Apagar os tokens e desconectar?</span>
                  <ActionButton
                    variant="danger"
                    icon={Unplug}
                    disabled={pending}
                    onClick={() => {
                      setConfirmDisconnect(false);
                      run(disconnectM365, "Conta desconectada. Os tokens foram apagados.");
                    }}
                  >
                    Confirmar
                  </ActionButton>
                  <ActionButton variant="secondary" disabled={pending} onClick={() => setConfirmDisconnect(false)}>
                    Cancelar
                  </ActionButton>
                </span>
              ) : (
                <ActionButton variant="danger" icon={Unplug} disabled={pending} onClick={() => setConfirmDisconnect(true)}>
                  Desconectar
                </ActionButton>
              )
            ) : null}
          </div>
        </div>
      </SectionPanel>

      {canEnableMinutes ? (
        <SectionPanel
          title="Atas por e-mail"
          description="Opcional, só para quem registra checkpoints. Pede a permissão extra de leitura de e-mail."
          action={
            <StatusBadge tone={mailEnabled ? "success" : "neutral"} pill>
              {mailEnabled ? "Ativo" : "Desligado"}
            </StatusBadge>
          }
        >
          <div className="space-y-4 px-5 py-5 text-sm text-medium">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Depois de um 1:1 ou checkpoint criado pela sua agenda, procuramos <strong>só na sua caixa</strong> o
                e-mail da ata: com a categoria “JumpFlow” ou com o assunto da reunião, enviado por você ou pelo
                consultor, até 7 dias depois.
              </li>
              <li>
                Do e-mail escolhido lemos o texto e anexos PDF/DOCX de até 10 MB (PDF escaneado não é lido). Os
                outros e-mails não são guardados, e se houver dúvida você escolhe qual usar.
              </li>
              <li>
                E-mails, telefones, CPF e CNPJ são mascarados antes da IA. A ata é gravada no checkpoint com a
                mesma visibilidade dele e guarda os dados reais; o texto original do e-mail fica guardado mascarado.
                As ações nascem pendentes para você validar.
              </li>
              <li>Nunca enviamos, apagamos ou movemos e-mails. A caixa do consultor nunca é lida.</li>
            </ul>
            {view?.status === "ACTIVE" && !mailEnabled ? (
              configured ? (
                <a
                  href={minutesHref}
                  className={cn(
                    "inline-flex h-10 items-center gap-2 rounded-md bg-brand-fill px-4 text-sm font-semibold text-white transition-colors hover:opacity-90",
                    focusRing,
                  )}
                >
                  <Mail aria-hidden="true" className="size-4" />
                  Ativar atas por e-mail
                </a>
              ) : null
            ) : null}
            {!view || view.status !== "ACTIVE" ? (
              <p className="text-xs text-soft">Conecte (ou retome) a sua conta para ativar as atas por e-mail.</p>
            ) : null}
            {mailEnabled ? (
              <p className="text-xs text-soft">
                Para desligar, desconecte a conta e conecte de novo sem ativar as atas, ou retire a permissão na sua
                conta Microsoft.
              </p>
            ) : null}
          </div>
        </SectionPanel>
      ) : null}

      <SectionPanel title="O que a integração faz" description="Leia antes de conectar.">
        <div className="grid gap-6 px-5 py-5 text-sm text-medium md:grid-cols-3">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-strong">
              <CalendarCheck aria-hidden="true" className="size-4" />
              O que é lido
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Sua agenda, somente leitura, de 30 dias atrás a 60 dias à frente.</li>
              <li>De cada reunião: assunto, data e hora, organizador, participantes e link do Teams.</li>
              <li>Seu perfil básico, só para confirmar que a conta é a sua.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-strong">O que nunca é feito</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Enviar e-mail em seu nome.</li>
              <li>Ler chats do Teams.</li>
              <li>Ler e-mails, a não ser as atas de checkpoint, se você (gestor) ativar.</li>
              <li>Criar, alterar ou apagar compromissos.</li>
              <li>Guardar o texto (corpo) dos convites.</li>
              <li>Guardar reuniões marcadas como particulares.</li>
              <li>Lançar horas sozinho. Sugestões só preenchem o formulário.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold text-strong">O que é guardado</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Os dados das reuniões listados ao lado.</li>
              <li>Rascunhos privados de checkpoint/1:1, só para o gestor que organizou a reunião.</li>
              <li>Sugestões de lançamento de horas, só para você.</li>
              <li>Tokens de acesso, sempre cifrados.</li>
            </ul>
            <p className="mt-3 text-xs text-soft">
              Ao desconectar, os tokens são apagados na hora. Rascunhos e registros já criados continuam como
              registro da empresa.
            </p>
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}
