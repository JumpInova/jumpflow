import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CalendarClock, FileSpreadsheet, FileText, Pencil, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { SavedViewRunner } from "@/components/consultas/SavedViewRunner";
import { SharingBadge } from "@/components/consultas/SavedItemList";
import { OwnerDeleteControl } from "@/components/consultas/OwnerDeleteControl";
import { ViewOwnerPanel } from "@/components/consultas/ViewOwnerPanel";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { visibleCatalog } from "@/lib/consultas/access";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { VISUALIZATION_LABELS } from "@/lib/consultas/saved";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Visão salva" };

const linkButton = cn(
  "inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-strong hover:bg-surface-muted",
  focusRing,
);

/**
 * Uma visão salva. A spec é lida e executada no servidor com a permissão de
 * QUEM VÊ; visão inexistente ou sem acesso responde 404 (sem distinguir).
 */
export default async function ConsultaVisaoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  if (!isDatabaseConfigured()) redirect("/app/consultas/visoes");

  const { id } = await params;
  const { countSchedulesForTarget, getSavedViewForViewer } = await import("@/lib/db/consultas-saved");
  const loaded = await getSavedViewForViewer(user, id);
  if (!loaded) notFound();
  const { summary, spec } = loaded;
  const scheduleCount = summary.isOwner
    ? await countSchedulesForTarget(user, { kind: "view", id: summary.id })
    : 0;
  const entity = visibleCatalog(access).find((item) => item.key === summary.entity);
  if (!entity) notFound();
  const grouped =
    typeof spec === "object" && spec !== null && Array.isArray((spec as { groupBy?: unknown }).groupBy)
      ? ((spec as { groupBy: unknown[] }).groupBy.length > 0)
      : false;

  const exportHref = (formato: "xlsx" | "csv") =>
    `/api/consultas/visoes/${encodeURIComponent(summary.id)}/exportar?formato=${formato}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Visão · ${entity.label} · ${VISUALIZATION_LABELS[summary.visualization]}`}
        title={summary.name}
        description={summary.description ?? (summary.isOwner ? "Sua visão salva." : `Compartilhada por ${summary.ownerName}.`)}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/app/consultas/visoes" className={linkButton}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              Visões
            </Link>
            {summary.isOwner && access.create && summary.available ? (
              <Link href={`/app/consultas?visao=${encodeURIComponent(summary.id)}`} className={linkButton}>
                <Pencil aria-hidden="true" className="size-4" />
                Editar consulta
              </Link>
            ) : null}
            {access.schedule && summary.available ? (
              <Link
                href={`/app/consultas/agendamentos/novo?visao=${encodeURIComponent(summary.id)}`}
                className={linkButton}
              >
                <CalendarClock aria-hidden="true" className="size-4" />
                Agendar envio
              </Link>
            ) : null}
            {access.export && summary.available ? (
              <>
                <a href={exportHref("xlsx")} className={linkButton} download>
                  <FileSpreadsheet aria-hidden="true" className="size-4" />
                  Excel
                </a>
                <a href={exportHref("csv")} className={linkButton} download>
                  <FileText aria-hidden="true" className="size-4" />
                  CSV
                </a>
              </>
            ) : null}
          </div>
        }
      />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-soft">
        <SharingBadge sharing={summary.sharing} sharedRoles={summary.sharedRoles} />
        {!summary.isOwner ? <span>Dados exibidos conforme o seu perfil de acesso.</span> : null}
      </div>

      <div className={cn("grid gap-6", summary.isOwner && "xl:grid-cols-[1fr_minmax(300px,360px)]")}>
        <SectionPanel title="Resultado">
          <div className="p-4">
            {summary.available ? (
              <SavedViewRunner
                viewId={summary.id}
                name={summary.name}
                entity={entity}
                visualization={summary.visualization}
              />
            ) : (
              <EmptyState
                icon={TriangleAlert}
                title="Visão indisponível para o seu perfil"
                description="Ela usa campos que seu perfil não pode mais consultar. Você pode excluí-la nos ajustes ao lado ou pedir a revisão da Matriz de Permissões."
              />
            )}
          </div>
        </SectionPanel>
        {summary.isOwner ? (
          <SectionPanel title="Ajustes da visão" description="Só você, como dono, vê esta área.">
            {access.create ? (
            <ViewOwnerPanel
              viewId={summary.id}
              scheduleCount={scheduleCount}
              canShare={access.share}
              grouped={grouped}
              initial={{
                name: summary.name,
                description: summary.description ?? "",
                visualization: summary.visualization,
                sharing: summary.sharing,
                sharedRoles: summary.sharedRoles,
              }}
            />
            ) : (
              <div className="p-4">
                <OwnerDeleteControl kind="visao" id={summary.id} scheduleCount={scheduleCount} />
              </div>
            )}
          </SectionPanel>
        ) : null}
      </div>
    </div>
  );
}
