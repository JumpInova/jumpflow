import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { ScheduleForm } from "@/components/consultas/ScheduleForm";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";

export const metadata: Metadata = { title: "Novo envio agendado" };

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Novo envio agendado. `?visao=` / `?painel=` pré-selecionam o alvo (se aberto para quem agenda). */
export default async function NovoAgendamentoPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  if (!access.schedule) redirect("/app/consultas/visoes");
  if (!isDatabaseConfigured()) redirect("/app/consultas/agendamentos");

  const params = await searchParams;
  const { getScheduleFormOptions } = await import("@/lib/db/consultas-schedules");
  const options = await getScheduleFormOptions(user);
  const viewId = first(params.visao);
  const panelId = first(params.painel);
  const preset = viewId && options.views.some((view) => view.id === viewId)
    ? { target: `view:${viewId}`, name: options.views.find((view) => view.id === viewId)?.name ?? "" }
    : panelId && options.panels.some((panel) => panel.id === panelId)
      ? { target: `panel:${panelId}`, name: options.panels.find((panel) => panel.id === panelId)?.name ?? "" }
      : { target: "", name: "" };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Consultas"
        title="Novo envio agendado"
        description="Escolha a visão ou o painel, a frequência e quem recebe. Cada pessoa recebe a planilha com a própria permissão."
      />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
      <SectionPanel>
        <div className="p-4">
          <ScheduleForm
            views={options.views}
            panels={options.panels}
            users={options.users}
            initial={{
              name: preset.name,
              target: preset.target,
              frequency: "WEEKLY",
              hour: 8,
              weekday: 1,
              monthDay: 1,
              recipientUserIds: [],
              active: true,
            }}
          />
        </div>
      </SectionPanel>
    </div>
  );
}
