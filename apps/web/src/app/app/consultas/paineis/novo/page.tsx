import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { PanelForm } from "@/components/consultas/PanelForm";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { panelViewOptions } from "../view-options";

export const metadata: Metadata = { title: "Novo painel" };

/** Criação de painel (exige CONSULTAS_CRIAR; o servidor revalida ao salvar). */
export default async function NovoPainelPage() {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  if (!access.create || !isDatabaseConfigured()) redirect("/app/consultas/paineis");

  const views = await panelViewOptions(user);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Consultas" title="Novo painel" description="Escolha até 24 visões salvas e a ordem em que aparecem." />
      <ConsultasNav canCreate={access.create} />
      <SectionPanel>
        <div className="p-4">
          <PanelForm
            views={views}
            canShare={access.share}
            initial={{ name: "", description: "", items: [], sharing: "PRIVATE", sharedRoles: [] }}
          />
        </div>
      </SectionPanel>
    </div>
  );
}
