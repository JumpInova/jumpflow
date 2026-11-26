"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/actions/result";
import { requireUser } from "@/lib/auth/guards";
import { M365_ACCOUNT_PATH } from "@/lib/m365/config";
import { m365RuntimeGate } from "@/lib/m365/runtime";

/**
 * Ações da tela "Microsoft 365" — sempre sobre a conexão do PRÓPRIO usuário
 * (resolvida no servidor pela sessão; nenhum id vem do cliente).
 */

async function ownUserId(): Promise<string | null> {
  const user = await requireUser();
  const { resolveDbUser } = await import("@/lib/db/users");
  const dbUser = await resolveDbUser(user);
  return dbUser?.id ?? null;
}

function gateFailure(): ActionResult<never> | null {
  const gate = m365RuntimeGate();
  if (gate.ok) return null;
  return {
    ok: false,
    error: gate.reason === "no_database" ? "NO_DATABASE" : "FORBIDDEN",
    message: "A integração com o Microsoft 365 não está disponível.",
  };
}

export async function setM365Paused(paused: boolean): Promise<ActionResult<{ paused: boolean }>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const userId = await ownUserId();
  if (!userId) return { ok: false, error: "NOT_FOUND", message: "Usuário não encontrado." };
  const { setOwnConnectionPaused, findConnectionIdForUser, logM365Event } = await import("@/lib/db/m365");
  const changed = await setOwnConnectionPaused(userId, paused);
  if (!changed) {
    return { ok: false, error: "NOT_EDITABLE", message: "A conexão não está em um estado que permita essa ação." };
  }
  const connectionId = await findConnectionIdForUser(userId);
  const { recordAuditEvent } = await import("@/lib/db/audit");
  if (connectionId) {
    await recordAuditEvent({
      actorUserId: userId,
      entityType: "M365Connection",
      entityId: connectionId,
      action: paused ? "M365_PAUSED" : "M365_RESUMED",
    });
    await logM365Event({
      operation: paused ? "connection.pause" : "connection.resume",
      status: "SUCCESS",
      entityType: "M365Connection",
      entityId: connectionId,
    });
  }
  revalidatePath(M365_ACCOUNT_PATH);
  return { ok: true, data: { paused } };
}

export async function disconnectM365(): Promise<ActionResult<null>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const userId = await ownUserId();
  if (!userId) return { ok: false, error: "NOT_FOUND", message: "Usuário não encontrado." };
  const { disconnectOwnConnection, logM365Event } = await import("@/lib/db/m365");
  const connectionId = await disconnectOwnConnection(userId);
  if (!connectionId) return { ok: false, error: "NOT_FOUND", message: "Nenhuma conexão encontrada." };
  const { recordAuditEvent } = await import("@/lib/db/audit");
  await recordAuditEvent({
    actorUserId: userId,
    entityType: "M365Connection",
    entityId: connectionId,
    action: "M365_DISCONNECTED",
    after: { status: "DISCONNECTED", tokensDeleted: true },
  });
  await logM365Event({
    operation: "connection.disconnect",
    status: "SUCCESS",
    entityType: "M365Connection",
    entityId: connectionId,
  });
  revalidatePath(M365_ACCOUNT_PATH);
  return { ok: true, data: null };
}

export async function syncM365Now(): Promise<ActionResult<{ status: string }>> {
  const blocked = gateFailure();
  if (blocked) return blocked;
  const userId = await ownUserId();
  if (!userId) return { ok: false, error: "NOT_FOUND", message: "Usuário não encontrado." };
  const { findConnectionIdForUser } = await import("@/lib/db/m365");
  const connectionId = await findConnectionIdForUser(userId);
  if (!connectionId) return { ok: false, error: "NOT_FOUND", message: "Nenhuma conexão encontrada." };
  const { syncConnectionNow } = await import("@/lib/m365/runtime");
  const result = await syncConnectionNow(connectionId);
  revalidatePath(M365_ACCOUNT_PATH);
  switch (result.status) {
    case "ok":
      return { ok: true, data: { status: "ok" } };
    case "busy":
      return { ok: true, data: { status: "busy" } };
    case "interrupted":
      return { ok: true, data: { status: "interrupted" } };
    case "skipped":
      return { ok: false, error: "NOT_EDITABLE", message: "A conexão não está ativa." };
    default:
      return {
        ok: false,
        error: "UNEXPECTED",
        message:
          result.connectionStatus === "REAUTH_REQUIRED"
            ? "A Microsoft pediu uma nova autorização. Reconecte sua conta."
            : "Não foi possível sincronizar agora. Tente de novo em instantes.",
      };
  }
}
