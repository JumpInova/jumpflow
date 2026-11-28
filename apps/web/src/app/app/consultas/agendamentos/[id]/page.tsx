import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { OwnerDeleteControl } from "@/components/consultas/OwnerDeleteControl";
import { ScheduleForm } from "@/components/consultas/ScheduleForm";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";

export const metadata: Metadata = { title: "Envio agendado" };

/** Edição do envio agendado — só o dono (não-dono recebe 404). Sem AGENDAR, só excluir. */
export default async function AgendamentoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  if (!isDatabaseConfigured()) redirect("/app/consultas/agendamentos");

  const { id } = await params;
  const { getMySchedule, getScheduleFormOptions } = await import("@/lib/db/consultas-schedules");
  const schedule = await getMySchedule(user, id);
  if (!schedule) notFound();

  const header = (
    <>
      <PageHeader eyebrow="Envio agendado" title={schedule.name} description={schedule.timing} />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
    </>
  );

  if (!access.schedule) {
    return (
      <div className="space-y-6">
        {header}
        <SectionPanel>
          <div className="p-4">
            <OwnerDeleteControl kind="agendamento" id={schedule.id} />
          </div>
        </SectionPanel>
      </div>
    );
  }

  const options = await getScheduleFormOptions(user);
  const target = `${schedule.targetKind}:${schedule.targetId}`;
  // Alvo que deixou de estar aberto para o dono: aparece marcado, e salvar
  // exige trocar por um disponível (o servidor recusa).
  const views =
    schedule.targetKind === "view" && !options.views.some((view) => view.id === schedule.targetId)
      ? [{ id: schedule.targetId, name: `${schedule.targetName} (indisponível)` }, ...options.views]
      : options.views;
  const panels =
    schedule.targetKind === "panel" && !options.panels.some((panel) => panel.id === schedule.targetId)
      ? [{ id: schedule.targetId, name: `${schedule.targetName} (indisponível)` }, ...options.panels]
      : options.panels;

  return (
    <div className="space-y-6">
      {header}
      <SectionPanel>
        <div className="p-4">
          <ScheduleForm
            scheduleId={schedule.id}
            views={views}
            panels={panels}
            users={options.users}
            initial={{
              name: schedule.name,
              target,
              frequency: schedule.frequency,
              hour: schedule.hour,
              weekday: schedule.weekday ?? 1,
              monthDay: schedule.monthDay ?? 1,
              recipientUserIds: schedule.recipients.map((recipient) => recipient.id),
              active: schedule.active,
            }}
          />
        </div>
      </SectionPanel>
    </div>
  );
}
