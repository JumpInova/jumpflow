import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { CatalogBrowser } from "@/components/consultas/CatalogBrowser";
import { ConsultasNav } from "@/components/consultas/ConsultasNav";
import { requireUser } from "@/lib/auth/guards";
import { visibleCatalog } from "@/lib/consultas/access";
import { loadConsultaAccess } from "@/lib/consultas/page-access";

export const metadata: Metadata = { title: "Catálogo de dados" };

/**
 * Catálogo de dados de Consultas: entidades e campos que o usuário pode usar,
 * com significado, origem, tipo e sensibilidade. É o MESMO catálogo do
 * construtor (já filtrado no servidor): campo sem permissão não aparece.
 */
export default async function ConsultasCatalogoPage() {
  const user = await requireUser();
  const access = await loadConsultaAccess(user);
  if (!access.module) redirect("/access-denied");
  const entities = visibleCatalog(access);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Consultas"
        title="Catálogo de dados"
        description="O que cada entidade e cada campo significam, de onde vêm e quem pode vê-los. Use um campo ou exemplo para começar uma consulta."
      />
      <ConsultasNav canCreate={access.create} />
      {entities.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="Nenhuma entidade liberada"
          description="Seu perfil ainda não tem acesso a nenhuma entidade de Consultas."
        />
      ) : (
        <CatalogBrowser entities={entities} canCreate={access.create} />
      )}
    </div>
  );
}
