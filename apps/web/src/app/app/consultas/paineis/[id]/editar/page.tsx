import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { OwnerDeleteControl } from "@/components/consultas/OwnerDeleteControl";
import { PanelForm } from "@/components/consultas/PanelForm";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { panelViewOptions } from "../../view-options";

export const metadata: Metadata = { title: "Editar painel" };

/** Edição do painel — só o dono (não-dono recebe 404). */
export default async function EditarPainelPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  if (!isDatabaseConfigured()) redirect("/app/consultas/paineis");

  const { id } = await params;
  const { getPanelForViewer } = await import("@/lib/db/consultas-saved");
  const loaded = await getPanelForViewer(user, id);
  if (!loaded || !loaded.panel.isOwner) notFound();
  const { panel } = loaded;
  const { countSchedulesForTarget } = await import("@/lib/db/consultas-saved");
  const scheduleCount = await countSchedulesForTarget(user, { kind: "panel", id: panel.id });
  // Regra única de edição: sem CRIAR o dono só pode excluir o painel.
  if (!access.create) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Consultas" title={`Painel: ${panel.name}`} />
        <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
        <SectionPanel>
          <div className="p-4">
            <OwnerDeleteControl kind="painel" id={panel.id} scheduleCount={scheduleCount} />
          </div>
        </SectionPanel>
      </div>
    );
  }
  const views = await panelViewOptions(user);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Consultas" title={`Editar painel: ${panel.name}`} />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
      <SectionPanel>
        <div className="p-4">
          <PanelForm
            scheduleCount={scheduleCount}
            panelId={panel.id}
            unavailableCount={loaded.hiddenCount}
            views={views}
            canShare={access.share}
            initial={{
              name: panel.name,
              description: panel.description ?? "",
              items: loaded.ownerItems ?? [],
              sharing: panel.sharing,
              sharedRoles: panel.sharedRoles,
            }}
          />
        </div>
      </SectionPanel>
    </div>
  );
}
