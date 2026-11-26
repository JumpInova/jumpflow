import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  buildRedirectUri,
  resolveAppBaseUrl,
  resolveM365Credentials,
} from "@/lib/m365/config";
import { startM365Connect } from "@/lib/m365/connect-flow";
import { resolveStateSecret } from "@/lib/m365/oauth";
import { canRegisterCheckpoint } from "@/lib/checkpoint/visibility";
import type { M365Phase } from "@/lib/m365/scopes";
import { redirectToAccount, redirectToPath, setOAuthCookie } from "@/lib/m365/route-helpers";
import { m365RuntimeGate } from "@/lib/m365/runtime";

export const dynamic = "force-dynamic";

/**
 * Início do consentimento Microsoft 365. `?fase=M2` = consentimento INCREMENTAL
 * de `Mail.Read` ("Ativar atas por e-mail", só para gestores); sem parâmetro =
 * M1 (agenda). Qualquer outro valor é tratado como M1. Separado do login:
 * o usuário já está autenticado e conecta, por opt-in, a PRÓPRIA conta.
 * Gera PKCE + state assinado, guarda o code_verifier em cookie httpOnly cifrado
 * (path restrito) e redireciona para a Microsoft.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const gate = m365RuntimeGate();
  if (!gate.ok && gate.reason === "disabled") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const user = await getCurrentUser();
  const base = resolveAppBaseUrl(origin);
  if (!user) return redirectToPath(base, "/login");
  const creds = resolveM365Credentials();
  const stateSecret = resolveStateSecret();
  if (!gate.ok || !creds.ok || !base || !stateSecret) {
    return redirectToAccount(base, { ok: false, code: "not_configured" });
  }

  const phase: M365Phase = new URL(request.url).searchParams.get("fase") === "M2" ? "M2" : "M1";
  // Atas por e-mail: só quem registra checkpoint (a caixa do consultor nunca
  // alimenta ata — nem chega a pedir Mail.Read).
  if (phase === "M2" && !canRegisterCheckpoint(user.roles)) {
    return redirectToAccount(base, { ok: false, code: "mail_not_allowed" });
  }

  const { resolveDbUser } = await import("@/lib/db/users");
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return redirectToAccount(base, { ok: false, code: "user_not_found" });

  const start = startM365Connect({
    phase,
    userId: dbUser.id,
    userEmail: dbUser.email,
    credentials: creds.credentials,
    redirectUri: buildRedirectUri(base),
    stateSecret,
  });
  const { logM365Event } = await import("@/lib/db/m365");
  await logM365Event({
    operation: "oauth.start",
    status: "SUCCESS",
    entityType: "User",
    entityId: dbUser.id,
    meta: { phase },
  });
  const res = NextResponse.redirect(start.authorizeUrl);
  setOAuthCookie(res, start.cookieValue, start.maxAgeSeconds);
  return res;
}
