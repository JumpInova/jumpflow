import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Microsoft365ConnectionPanel } from "@/components/m365/M365ConnectionPanel";
import { requireUser } from "@/lib/auth/guards";
import { can } from "@/lib/auth/permissions";
import { M365_ADMIN_CODE } from "@/lib/auth/permission-codes";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { isDatabaseConfigured } from "@/lib/db/config";
import {
  M365_ADMIN_PATH,
  M365_CONNECT_PATH,
  isM365Enabled,
  resolveAppBaseUrl,
  resolveM365Credentials,
} from "@/lib/m365/config";
import { M365_ERROR_MESSAGES, isM365ErrorCode } from "@/lib/m365/messages";

export const metadata: Metadata = { title: "Microsoft 365" };
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Microsoft 365 — conexão pessoal (área de conta do usuário). Opt-in, separado
 * do login: conectar / pausar / desconectar, escopos concedidos, último sync e
 * último erro, com o texto de consentimento. Com a flag desligada, 404.
 */
export default async function Microsoft365Page({ searchParams }: PageProps) {
  if (!isM365Enabled()) notFound();
  const user = await requireUser();
  const params = await searchParams;

  // Em produção a base pública (AUTH_URL) é obrigatória; fora dela o connect
  // usa a origem da requisição.
  const configured =
    isDatabaseConfigured() &&
    resolveM365Credentials().ok &&
    (resolveAppBaseUrl(null) !== null || process.env.NODE_ENV !== "production");

  let view = null;
  if (isDatabaseConfigured()) {
    const { resolveDbUser } = await import("@/lib/db/users");
    const dbUser = await resolveDbUser(user);
    if (dbUser) {
      const { getM365ConnectionView } = await import("@/lib/db/m365");
      view = await getM365ConnectionView(dbUser.id);
    }
  }

  const erro = typeof params.erro === "string" ? params.erro : null;
  const status = typeof params.status === "string" ? params.status : null;
  const notice: { tone: "success" | "warning"; text: string } | null = isM365ErrorCode(erro)
    ? { tone: "warning", text: M365_ERROR_MESSAGES[erro] }
    : status === "conectado"
      ? {
          tone: "success",
          text: "Conta Microsoft conectada. A primeira sincronização da agenda acontece em instantes, ou use “Sincronizar agora”.",
        }
      : null;

  const canSeeAdmin = await can(M365_ADMIN_CODE, "view");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Minha conta"
        title="Microsoft 365"
        description="Conecte sua agenda para gerar rascunhos de checkpoint/1:1 e sugestões de lançamento de horas."
        actions={
          canSeeAdmin ? (
            <Link
              href={M365_ADMIN_PATH}
              className={cn(
                "inline-flex h-9 items-center rounded-md border border-border bg-surface px-4 text-sm font-semibold text-medium transition-colors hover:bg-surface-muted hover:text-strong",
                focusRing,
              )}
            >
              Visão administrativa
            </Link>
          ) : undefined
        }
      />
      <Microsoft365ConnectionPanel
        view={view}
        connectHref={M365_CONNECT_PATH}
        configured={configured}
        notice={notice}
      />
    </div>
  );
}
