import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpenText, Lock } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConsultaBuilder } from "@/components/consultas/ConsultaBuilder";
import { requireUser } from "@/lib/auth/guards";
import { isDatabaseConfigured } from "@/lib/db/config";
import { visibleCatalog } from "@/lib/consultas/access";
import { initialSpec } from "@/lib/consultas/builder";
import { loadConsultaAccess } from "@/lib/consultas/page-access";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";
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
  const params = await searchParams;
  const entities = visibleCatalog(access);

  const header = (
    <PageHeader
      eyebrow="Gestão"
      title="Consultas"
      description="Monte relatórios próprios: escolha a entidade, filtre, agrupe e some. Cada campo está explicado no catálogo de dados."
      actions={
        <Link
          href="/app/consultas/catalogo"
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-strong hover:bg-surface-muted",
            focusRing,
          )}
        >
          <BookOpenText aria-hidden="true" className="size-4" />
          Catálogo de dados
        </Link>
      }
    />
  );

  if (!access.create) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Lock}
          title="Sem permissão para criar consultas"
          description="Seu perfil pode consultar o catálogo de dados. As visões compartilhadas com você aparecerão aqui quando estiverem disponíveis."
        />
      </div>
    );
  }

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
        entities={entities}
        canExport={access.export}
        demo={!isDatabaseConfigured()}
        initial={initialFromParams(entities, params)}
      />
    </div>
  );
}
