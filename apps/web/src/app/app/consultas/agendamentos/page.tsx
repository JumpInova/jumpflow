import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Database, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { focusRing, tactileButton } from "@/lib/styles";
import { cn } from "@/lib/utils";
import type { ScheduleSummary } from "@/lib/db/consultas-schedules";

export const metadata: Metadata = { title: "Envios agendados" };

const DATE_TIME = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

const RUN_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  SENT: { label: "Enviado", tone: "success" },
  PARTIAL: { label: "Enviado em parte", tone: "warning" },
  SKIPPED: { label: "Ninguém recebeu", tone: "warning" },
  FAILED: { label: "Falhou", tone: "danger" },
  RUNNING: { label: "Em andamento", tone: "info" },
};

function lastRunText(run: NonNullable<ScheduleSummary["lastRun"]>): string {
  const parts = [`${run.sent} enviado(s)`];
  if (run.skipped > 0) parts.push(`${run.skipped} pulado(s) por permissão`);
  if (run.failed > 0) parts.push(`${run.failed} com falha`);
  return parts.join(" · ");
}

/**
 * Envios agendados do próprio usuário (visão/painel por e-mail com XLSX).
 * Criar e editar exigem `CONSULTAS_AGENDAR`; sem ele, o dono ainda vê e exclui
 * os que criou.
 */
export default async function AgendamentosPage() {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  const demo = !isDatabaseConfigured();

  let schedules: ScheduleSummary[] = [];
  if (!demo) {
    const { listMySchedules } = await import("@/lib/db/consultas-schedules");
    schedules = await listMySchedules(user).catch(() => []);
  }
  if (!access.schedule && schedules.length === 0) redirect("/app/consultas/visoes");

  const newLink =
    access.schedule && !demo ? (
      <Link
        href="/app/consultas/agendamentos/novo"
        className={cn(
          tactileButton,
          focusRing,
          "inline-flex h-10 items-center gap-2 rounded-md bg-brand-fill px-4 text-sm font-semibold text-white",
        )}
      >
        <Plus aria-hidden="true" className="size-4" />
        Novo agendamento
      </Link>
    ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Consultas"
        title="Envios agendados"
        description="Visões e painéis enviados por e-mail com planilha (XLSX), no horário de São Paulo. Cada destinatário recebe só os dados que o próprio perfil permite."
        actions={newLink}
      />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
      {demo ? (
        <EmptyState
          icon={Database}
          title="Ambiente de demonstração"
          description="Sem banco de dados, não há envios agendados."
        />
      ) : (
        <SectionPanel title="Meus agendamentos" description="Criados por você.">
          <div className="p-4">
            {schedules.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                title="Nenhum envio agendado"
                description="Agende uma visão ou um painel para chegar por e-mail todo dia, semana ou mês."
              />
            ) : (
              <ul className="divide-y divide-border">
                {schedules.map((schedule) => {
                  const status = schedule.lastRun ? RUN_STATUS[schedule.lastRun.status] : null;
                  return (
                    <li key={schedule.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <Link
                          href={`/app/consultas/agendamentos/${encodeURIComponent(schedule.id)}`}
                          className={cn("font-semibold text-strong hover:underline", focusRing)}
                        >
                          {schedule.name}
                        </Link>
                        <p className="text-sm text-medium">
                          {schedule.targetKind === "view" ? "Visão" : "Painel"}: {schedule.targetName} ·{" "}
                          {schedule.timing}
                        </p>
                        <p className="text-xs text-soft">
                          {schedule.recipients.length} destinatário(s)
                          {schedule.nextAt ? ` · Próximo envio: ${DATE_TIME.format(new Date(schedule.nextAt))}` : ""}
                          {schedule.lastRun ? ` · Último (${schedule.lastRun.windowKey}): ${lastRunText(schedule.lastRun)}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-1.5">
                        {schedule.active ? (
                          <StatusBadge tone="success">Ativo</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">Pausado</StatusBadge>
                        )}
                        {status ? <StatusBadge tone={status.tone}>{status.label}</StatusBadge> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SectionPanel>
      )}
    </div>
  );
}
