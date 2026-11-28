import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Database, LayoutDashboard, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { SavedItemList, type SavedListItem } from "@/components/consultas/SavedItemList";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { focusRing, tactileButton } from "@/lib/styles";
import { cn } from "@/lib/utils";
import type { SavedPanelSummary } from "@/lib/db/consultas-saved";

export const metadata: Metadata = { title: "Painéis de consultas" };

function toItem(panel: SavedPanelSummary): SavedListItem {
  return {
    id: panel.id,
    href: `/app/consultas/paineis/${panel.id}`,
    name: panel.name,
    description: panel.description,
    meta: "Painel",
    sharing: panel.sharing,
    sharedRoles: panel.sharedRoles,
    ownerName: panel.ownerName,
    isOwner: panel.isOwner,
    updatedAt: panel.updatedAt,
  };
}

/** Painéis: conjuntos de até 24 visões, revalidadas para quem vê. */
export default async function ConsultasPaineisPage() {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  const demo = !isDatabaseConfigured();

  let mine: SavedPanelSummary[] = [];
  let shared: SavedPanelSummary[] = [];
  if (!demo) {
    const { listPanels } = await import("@/lib/db/consultas-saved");
    ({ mine, shared } = await listPanels(user));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Consultas"
        title="Painéis"
        description="Reúna visões salvas numa única tela. Cada visão do painel roda com o perfil de quem abre."
        actions={
          access.create && !demo ? (
            <Link
              href="/app/consultas/paineis/novo"
              className={cn(tactileButton, focusRing, "inline-flex h-10 items-center gap-2 rounded-md bg-brand-fill px-4 text-sm font-semibold text-white")}
            >
              <Plus aria-hidden="true" className="size-4" />
              Novo painel
            </Link>
          ) : null
        }
      />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
      {demo ? (
        <EmptyState
          icon={Database}
          title="Ambiente de demonstração"
          description="Sem banco de dados, não há painéis para mostrar."
        />
      ) : (
        <>
          {access.create || mine.length > 0 ? (
            <SectionPanel title="Meus painéis">
              <div className="p-4">
                {mine.length === 0 ? (
                  <EmptyState
                    icon={LayoutDashboard}
                    title="Você ainda não criou nenhum painel"
                    description="Salve algumas visões e reúna-as em “Novo painel”."
                  />
                ) : (
                  <SavedItemList items={mine.map(toItem)} showOwner={false} />
                )}
              </div>
            </SectionPanel>
          ) : null}
          <SectionPanel title="Compartilhados comigo">
            <div className="p-4">
              {shared.length === 0 ? (
                <EmptyState
                  icon={LayoutDashboard}
                  title="Nenhum painel compartilhado com você"
                  description="Quando alguém compartilhar um painel com todos ou com o seu papel, ele aparece aqui."
                />
              ) : (
                <SavedItemList items={shared.map(toItem)} showOwner />
              )}
            </div>
          </SectionPanel>
        </>
      )}
    </div>
  );
}
