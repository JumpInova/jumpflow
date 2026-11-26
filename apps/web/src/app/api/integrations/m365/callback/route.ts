import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  buildRedirectUri,
  resolveAppBaseUrl,
  resolveM365Credentials,
} from "@/lib/m365/config";
import { completeM365Callback, readOAuthCookie } from "@/lib/m365/connect-flow";
import { createHttpGraphClient } from "@/lib/m365/graph/client";
import { GraphError } from "@/lib/m365/graph/errors";
import { M365_OAUTH_COOKIE, resolveStateSecret } from "@/lib/m365/oauth";
import { clearOAuthCookie, redirectToAccount, redirectToPath } from "@/lib/m365/route-helpers";
import { m365RuntimeGate } from "@/lib/m365/runtime";
import { encryptTokenSet } from "@/lib/m365/tokens";
import { countExtraScopes } from "@/lib/m365/scopes";

export const dynamic = "force-dynamic";

/**
 * Callback do consentimento Microsoft 365. Confere state × sessão × cookie,
 * troca o code (PKCE), confere `tid` × M365_TENANT_ID e `/me` × e-mail do
 * usuário logado (só a própria conta), e grava os tokens CIFRADOS. A UI recebe
 * apenas códigos mapeados (`?erro=<código>`).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gate = m365RuntimeGate();
  if (!gate.ok && gate.reason === "disabled") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const user = await getCurrentUser();
  // Mesma base do redirect_uri; em produção sem AUTH_URL = null (falha fechado,
  // Location relativo — nunca o Host da requisição).
  const base = resolveAppBaseUrl(url.origin);
  if (!user) return redirectToPath(base, "/login");
  const creds = resolveM365Credentials();
  const stateSecret = resolveStateSecret();
  const jar = await cookies();
  const cookie = readOAuthCookie(jar.get(M365_OAUTH_COOKIE)?.value);

  const finish = (res: NextResponse) => {
    clearOAuthCookie(res);
    return res;
  };
  if (!gate.ok || !creds.ok || !stateSecret || !base) {
    return finish(redirectToAccount(base, { ok: false, code: "not_configured" }));
  }

  const { resolveDbUser } = await import("@/lib/db/users");
  const dbUser = await resolveDbUser(user);
  if (!dbUser) return finish(redirectToAccount(base, { ok: false, code: "user_not_found" }));

  const result = await completeM365Callback(
    {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      cookie,
      userId: dbUser.id,
      userEmail: dbUser.email,
      credentials: creds.credentials,
      redirectUri: buildRedirectUri(base),
      stateSecret,
    },
    {
      graphWithToken: (accessToken) =>
        createHttpGraphClient({
          tokens: {
            get: async () => accessToken,
            refresh: async () => {
              throw new GraphError("reauth", "Token recém-emitido recusado.");
            },
          },
        }),
    },
  );

  const { logM365Event, upsertM365Connection } = await import("@/lib/db/m365");
  if (!result.ok) {
    await logM365Event({
      operation: "oauth.callback",
      status: "FAILED",
      entityType: "User",
      entityId: dbUser.id,
      error: result.code,
    });
    return finish(redirectToAccount(base, result));
  }

  const encrypted = encryptTokenSet(result.account.tokens, null);
  const saved = await upsertM365Connection({
    userId: dbUser.id,
    ...encrypted,
    tenantId: result.account.tenantId,
    graphUserId: result.account.graphUserId,
    mailbox: result.account.mailbox,
  });
  const { recordAuditEvent } = await import("@/lib/db/audit");
  await recordAuditEvent({
    actorUserId: dbUser.id,
    entityType: "M365Connection",
    entityId: saved.id,
    action: saved.created ? "M365_CONNECTED" : "M365_RECONNECTED",
    after: { status: "ACTIVE", scopes: encrypted.scopes },
  });
  await logM365Event({
    operation: "oauth.callback",
    status: "SUCCESS",
    entityType: "M365Connection",
    entityId: saved.id,
    // `scopes` grava só o concedido dentro da M1 (encryptTokenSet). Extras
    // permitidos (já consentidos antes) só são contados aqui. Proibidos já
    // foram recusados antes de gravar qualquer token.
    meta: {
      created: saved.created,
      scopes: encrypted.scopes.length,
      extraScopes: countExtraScopes(result.account.tokens.scopes, "M1"),
    },
  });
  return finish(redirectToAccount(base, { ok: true }));
}
