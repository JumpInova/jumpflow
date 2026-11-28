import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CalendarClock, EyeOff, LayoutDashboard, Pencil } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { SavedViewRunner } from "@/components/consultas/SavedViewRunner";
import { SharingBadge } from "@/components/consultas/SavedItemList";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { visibleCatalog } from "@/lib/consultas/access";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { VISUALIZATION_LABELS } from "@/lib/consultas/saved";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Painel de consultas" };

const linkButton = cn(
  "inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-strong hover:bg-surface-muted",
  focusRing,
);

/**
 * Painel: cada visão é revalidada para QUEM VÊ (compartilhamento + entidade +
 * campos) antes de aparecer. As inacessíveis somem — só a quantidade é
 * informada, nunca o nome. Cada cartão executa a própria visão no servidor.
 */
export default async function ConsultaPainelPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  if (!isDatabaseConfigured()) redirect("/app/consultas/paineis");

  const { id } = await params;
  const { getPanelForViewer } = await import("@/lib/db/consultas-saved");
  const loaded = await getPanelForViewer(user, id);
  if (!loaded) notFound();
  const { panel, items, hiddenCount } = loaded;
  const catalog = visibleCatalog(access);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Painel"
        title={panel.name}
        description={panel.description ?? (panel.isOwner ? "Seu painel." : `Compartilhado por ${panel.ownerName}.`)}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/app/consultas/paineis" className={linkButton}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Painéis
            </Link>
            {access.schedule ? (
              <Link
                href={`/app/consultas/agendamentos/novo?painel=${encodeURIComponent(panel.id)}`}
                className={linkButton}
              >
                <CalendarClock aria-hidden="true" className="size-4" />
                Agendar envio
              </Link>
            ) : null}
            {panel.isOwner ? (
              <Link href={`/app/consultas/paineis/${encodeURIComponent(panel.id)}/editar`} className={linkButton}>
                <Pencil aria-hidden="true" className="size-4" />
                {access.create ? "Editar painel" : "Gerenciar painel"}
              </Link>
            ) : null}
          </div>
        }
      />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-soft">
        <SharingBadge sharing={panel.sharing} sharedRoles={panel.sharedRoles} />
        <span>Cada visão mostra os dados conforme o seu perfil de acesso.</span>
      </div>

      {hiddenCount > 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-medium">
          <EyeOff aria-hidden="true" className="size-4 shrink-0 text-soft" />
          {hiddenCount === 1
            ? "1 item deste painel não está disponível para o seu perfil."
            : `${hiddenCount} itens deste painel não estão disponíveis para o seu perfil.`}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="Nada para mostrar"
          description="Nenhuma visão deste painel está disponível para o seu perfil."
        />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {items.map((item) => {
            const entity = catalog.find((candidate) => candidate.key === item.view.entity);
            if (!entity) return null;
            return (
              <li
                key={item.viewId}
                className={cn(
                  "flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4",
                  item.size === "largo" && "lg:col-span-2",
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold text-strong">
                    <Link
                      href={`/app/consultas/visoes/${encodeURIComponent(item.viewId)}`}
                      className={cn("underline-offset-2 hover:underline", focusRing)}
                    >
                      {item.view.name}
                    </Link>
                  </h2>
                  <span className="text-xs text-soft">
                    {item.view.entityLabel} · {VISUALIZATION_LABELS[item.view.visualization]}
                  </span>
                </div>
                <SavedViewRunner
                  viewId={item.viewId}
                  name={item.view.name}
                  entity={entity}
                  visualization={item.view.visualization}
                  compact
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
