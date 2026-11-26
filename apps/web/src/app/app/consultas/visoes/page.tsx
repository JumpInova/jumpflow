import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Bookmark, Database, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { SavedItemList, type SavedListItem } from "@/components/consultas/SavedItemList";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { VISUALIZATION_LABELS } from "@/lib/consultas/saved";
import { focusRing, tactileButton } from "@/lib/styles";
import { cn } from "@/lib/utils";
import type { SavedViewSummary } from "@/lib/db/consultas-saved";

export const metadata: Metadata = { title: "Visões salvas" };

function toItem(view: SavedViewSummary): SavedListItem {
  return {
    id: view.id,
    href: `/app/consultas/visoes/${view.id}`,
    name: view.name,
    description: view.description,
    meta: `${view.entityLabel} · ${VISUALIZATION_LABELS[view.visualization]}`,
    sharing: view.sharing,
    sharedRoles: view.sharedRoles,
    ownerName: view.ownerName,
    isOwner: view.isOwner,
    available: view.available,
    updatedAt: view.updatedAt,
  };
}

/**
 * Visões salvas: as minhas e as compartilhadas comigo. A lista já vem
 * filtrada para quem vê (compartilhamento + entidade + campos); visão privada
 * de outra pessoa nunca aparece.
 */
export default async function ConsultasVisoesPage() {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  const demo = !isDatabaseConfigured();

  let mine: SavedViewSummary[] = [];
  let shared: SavedViewSummary[] = [];
  if (!demo) {
    const { listSavedViews } = await import("@/lib/db/consultas-saved");
    ({ mine, shared } = await listSavedViews(user));
  }

  const newLink = access.create ? (
    <Link
      href="/app/consultas"
      className={cn(tactileButton, focusRing, "inline-flex h-10 items-center gap-2 rounded-md bg-brand-fill px-4 text-sm font-semibold text-white")}
    >
      <Plus aria-hidden="true" className="size-4" />
      Nova consulta
    </Link>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Consultas"
        title="Visões salvas"
        description="Consultas guardadas para abrir de novo, em tabela ou gráfico. Quem abre uma visão compartilhada vê só os dados que o próprio perfil permite."
        actions={newLink}
      />
      <ConsultasNav canCreate={access.create} />
      {demo ? (
        <EmptyState
          icon={Database}
          title="Ambiente de demonstração"
          description="Sem banco de dados, não há visões salvas para mostrar."
        />
      ) : (
        <>
          {access.create || mine.length > 0 ? (
            <SectionPanel title="Minhas visões" description="Criadas por você.">
              <div className="p-4">
                {mine.length === 0 ? (
                  <EmptyState
                    icon={Bookmark}
                    title="Você ainda não salvou nenhuma visão"
                    description="No construtor, monte a consulta e use “Salvar como visão”."
                  />
                ) : (
                  <SavedItemList items={mine.map(toItem)} showOwner={false} />
                )}
              </div>
            </SectionPanel>
          ) : null}
          <SectionPanel title="Compartilhadas comigo" description="Visões de outras pessoas que seu perfil pode abrir.">
            <div className="p-4">
              {shared.length === 0 ? (
                <EmptyState
                  icon={Bookmark}
                  title="Nenhuma visão compartilhada com você"
                  description="Quando alguém compartilhar uma visão com todos ou com o seu papel, ela aparece aqui."
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
