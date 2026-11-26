import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConsultaBuilder } from "@/components/consultas/ConsultaBuilder";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import type { EditingView } from "@/components/consultas/SaveViewDialog";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isAiProviderConfigured } from "@/lib/ai/provider";
import { visibleCatalog } from "@/lib/consultas/access";
import { initialSpec } from "@/lib/consultas/builder";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import type { ConsultaEntity, ConsultaSpec } from "@/lib/consultas/types";

export const metadata: Metadata = { title: "Consultas" };

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Spec inicial vinda do catálogo ("Usar na consulta"): `?entidade=` com
 * `campo=` (acrescenta a coluna) ou `exemplo=` (índice do exemplo). Só
 * considera o catálogo JÁ filtrado para o usuário.
 */
function initialFromParams(
  entities: ConsultaEntity[],
  params: RawParams,
): ConsultaSpec | undefined {
  const entity = entities.find((e) => e.key === first(params.entidade));
  if (!entity) return undefined;
  const example = Number(first(params.exemplo));
  if (Number.isInteger(example) && entity.examples[example]) {
    return entity.examples[example].spec;
  }
  const spec = initialSpec(entity);
  const field = entity.fields.find((f) => f.key === first(params.campo));
  if (field && !spec.columns.includes(field.key)) {
    spec.columns = [...spec.columns, field.key];
  }
  return spec;
}

/**
 * Consultas: construtor visual sobre o catálogo de dados. O acesso ao módulo é
 * gated pela matriz (`CONSULTAS`, no layout); aqui exigimos `CONSULTAS_CRIAR`
 * para montar consultas próprias. Entidade, colunas, escopo de linha e timeout
 * são revalidados no servidor a cada execução.
 */
export default async function ConsultasPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  // Sem CRIAR, o módulo é das visões compartilhadas.
  if (!access.create) redirect("/app/consultas/visoes");
  const params = await searchParams;
  const entities = visibleCatalog(access);
  const demo = !isDatabaseConfigured();

  // `?visao=<id>`: abre a PRÓPRIA visão no construtor para editar. A spec é
  // lida no servidor e só vale se a visão roda com a permissão atual.
  let editing: EditingView | undefined;
  let initial = initialFromParams(entities, params);
  const viewId = first(params.visao);
  if (viewId && !demo) {
    const { getSavedViewForViewer } = await import("@/lib/db/consultas-saved");
    const loaded = await getSavedViewForViewer(user, viewId);
    if (loaded?.summary.isOwner && loaded.summary.available) {
      editing = {
        id: loaded.summary.id,
        name: loaded.summary.name,
        description: loaded.summary.description ?? "",
        visualization: loaded.summary.visualization,
        sharing: loaded.summary.sharing,
        sharedRoles: loaded.summary.sharedRoles,
      };
      initial = loaded.spec as ConsultaSpec;
    }
  }

  const header = (
    <>
      <PageHeader
        eyebrow="Gestão"
        title={editing ? `Editar visão: ${editing.name}` : "Consultas"}
        description="Monte relatórios próprios: escolha a entidade, filtre, agrupe e some. Cada campo está explicado no catálogo de dados."
      />
      <ConsultasNav canCreate={access.create} canSchedule={access.schedule} />
    </>
  );

  if (entities.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Lock}
          title="Nenhuma entidade liberada"
          description="Seu perfil ainda não tem acesso a nenhuma entidade de Consultas. Fale com um administrador para ajustar a Matriz de Permissões."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <ConsultaBuilder
        key={editing?.id ?? "nova"}
        entities={entities}
        canExport={access.export}
        canShare={access.share}
        demo={demo}
        initial={initial}
        editing={editing}
        assistant={access.ai && !demo ? (isAiProviderConfigured() ? "on" : "off") : undefined}
      />
    </div>
  );
}
