import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Plug } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { StatTile } from "@/components/ui/StatTile";
import { requirePermission } from "@/lib/auth/guards";
import { M365_ADMIN_CODE } from "@/lib/auth/permission-codes";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isM365Enabled, resolveM365Credentials } from "@/lib/m365/config";

export const metadata: Metadata = { title: "Integração Microsoft 365" };
export const dynamic = "force-dynamic";

const STATUS_LABEL = {
  ACTIVE: "Conectados (ativos)",
  PAUSED: "Pausados",
  REAUTH_REQUIRED: "Reconexão necessária",
  ERROR: "Erro de configuração",
  DISCONNECTED: "Desconectados",
} as const;

/**
 * Visão admin da integração Microsoft 365: "N de M usuários conectados" e a
 * distribuição por status. Só contagens — nunca tokens, e-mails ou conteúdo.
 * Gate pela matriz (INTEGRACOES_M365, ADMIN por padrão) + flag.
 */
export default async function M365AdminPage() {
  if (!isM365Enabled()) notFound();
  await requirePermission(M365_ADMIN_CODE, "view");

  const header = (
    <PageHeader
      eyebrow="Administração"
      title="Integração Microsoft 365"
      description="Adesão à conexão pessoal (opt-in) com agenda do Microsoft 365."
    />
  );

  if (!isDatabaseConfigured()) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={Plug} title="Banco de dados não configurado" />
      </div>
    );
  }

  const { getM365AdminOverview } = await import("@/lib/db/m365");
  const overview = await getM365AdminOverview();
  const creds = resolveM365Credentials();

  return (
    <div className="space-y-6">
      {header}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Usuários conectados"
          value={`${overview.connected} de ${overview.activeUsers}`}
        />
        <StatTile label="Reconexão necessária" value={String(overview.byStatus.REAUTH_REQUIRED)} />
        <StatTile label="Falhas nos últimos 7 dias" value={String(overview.recentFailures)} />
      </div>
      <SectionPanel
        title="Conexões por status"
        description={
          creds.ok
            ? "Credenciais do app Entra configuradas."
            : "Credenciais do app Entra ausentes ou com tenant inválido: ninguém consegue conectar."
        }
      >
        <ul className="divide-y divide-border">
          {(Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>).map((status) => (
            <li key={status} className="flex items-center justify-between px-5 py-3 text-sm">
              <span className="text-medium">{STATUS_LABEL[status]}</span>
              <span className="font-semibold tabular-nums text-strong">{overview.byStatus[status]}</span>
            </li>
          ))}
        </ul>
      </SectionPanel>
    </div>
  );
}
