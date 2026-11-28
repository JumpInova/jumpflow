/**
 * Acesso do usuário às telas de Consultas (servidor). Com banco, é o mesmo
 * contexto da execução (`getConsultaContext`); sem banco (demo), deriva da
 * matriz + papéis, só para mostrar o catálogo — nada é executado.
 */
import type { AppUser } from "@/lib/auth/types";
import { getCurrentMatrix } from "@/lib/auth/permissions";
import { FINANCIAL_ROLES, hasRole } from "@/lib/auth/route-permissions";
import { canAccessSensitiveCost } from "@/lib/auth/sensitive-data";
import { isDatabaseConfigured } from "@/lib/db/config";
import { buildConsultaAccess, type ConsultaAccess } from "./access";

export async function loadConsultaAccess(user: AppUser): Promise<ConsultaAccess> {
  if (isDatabaseConfigured()) {
    const { getConsultaContext } = await import("@/lib/db/consultas");
    return (await getConsultaContext(user)).access;
  }
  return buildConsultaAccess(await getCurrentMatrix(), {
    financial: hasRole(user, FINANCIAL_ROLES),
    sensitiveCost: canAccessSensitiveCost(user),
    // Mesmo critério de `resolveReportScope` (FINANCE sem papel mais amplo).
    financeHoursLimited:
      hasRole(user, "FINANCE") && !hasRole(user, ["ADMIN", "AREA_MANAGER"]),
  });
}
