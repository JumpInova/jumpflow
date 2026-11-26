import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  buildRedirectUri,
  resolveAppBaseUrl,
  resolveM365Credentials,
} from "@/lib/m365/config";
import { startM365Connect } from "@/lib/m365/connect-flow";
import { resolveStateSecret } from "@/lib/m365/oauth";
import { redirectToAccount, redirectToPath, setOAuthCookie } from "@/lib/m365/route-helpers";
import { m365RuntimeGate } from "@/lib/m365/runtime";

export const dynamic = "force-dynamic";

/**
 * Início do consentimento Microsoft 365 (M1: agenda). Separado do login:
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

  const { resolveDbUser } = await import("@/lib/db/users");
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return redirectToAccount(base, { ok: false, code: "user_not_found" });

  const start = startM365Connect({
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
    meta: { phase: "M1" },
  });
  const res = NextResponse.redirect(start.authorizeUrl);
  setOAuthCookie(res, start.cookieValue, start.maxAgeSeconds);
  return res;
}
