import type { AppUser } from "@/lib/auth/types";
import { canRegisterCheckpoint } from "@/lib/checkpoint/visibility";
import type { GraphClient } from "./graph/client";
import { errorCode, isGraphError, isInterruption } from "./graph/errors";
import { hasMailScope, hasTeamsScopes, type M365Capability } from "./scopes";
import {
  ConnectionChangedError,
  type M365ConnectionRecord,
  type M365Store,
  type UserContext,
} from "./store";

/**
 * Execução sob a conexão do GESTOR (M2 atas por e-mail, M3 transcrição do
 * Teams). Invariantes compartilhadas:
 *
 * - SÓ a conexão do próprio `managerUserId`, ACTIVE, com a capacidade exigida
 *   (e-mail ou Teams) e papel de quem registra checkpoint. A conta do consultor
 *   nunca é usada para ata.
 * - Lease no banco (o mesmo da conexão): job, acionamento manual e sync da
 *   agenda nunca usam a mesma conta ao mesmo tempo. Conexão relida após o
 *   claim (tokens/escopos atuais).
 * - Erros da conexão: reauth → REAUTH_REQUIRED; config → ERROR; interrupção
 *   (throttling/prazo) não marca nada. Logs só com códigos.
 */

export const MANAGER_LEASE_MS = 5 * 60_000;

export interface ManagerConnectionDeps {
  store: M365Store;
  graphFor: (connection: M365ConnectionRecord) => GraphClient;
  owner: string;
  now?: () => Date;
  leaseMs?: number;
}

export type ManagerSkipReason =
  | "no_connection"
  | "not_active"
  | "no_mail_scope"
  | "no_teams_scope"
  | "not_manager"
  | "connection_changed";

export type ManagerRunResult<T> =
  | { status: "ok"; value: T }
  | { status: "skipped"; reason: ManagerSkipReason }
  | { status: "busy" }
  | { status: "interrupted"; code: string }
  | { status: "error"; code: string };

export interface ManagerCtx {
  connection: M365ConnectionRecord;
  user: UserContext;
  graph: GraphClient;
  /** mailbox da conexão + e-mail do usuário (minúsculos). */
  managerEmails: string[];
}

function hasCapability(scopes: string[], capability: M365Capability): boolean {
  return capability === "MAIL" ? hasMailScope(scopes) : hasTeamsScopes(scopes);
}

function missingReason(capability: M365Capability): ManagerSkipReason {
  return capability === "MAIL" ? "no_mail_scope" : "no_teams_scope";
}

function nowOf(deps: ManagerConnectionDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/** Heartbeat do lease da conexão antes de cada fase de efeitos. */
export async function renewManagerLease(deps: ManagerConnectionDeps, connectionId: string): Promise<void> {
  const until = new Date(nowOf(deps).getTime() + (deps.leaseMs ?? MANAGER_LEASE_MS));
  if (!(await deps.store.renewSyncLease(connectionId, deps.owner, until))) throw new ConnectionChangedError();
}

export function isManagerUser(user: AppUser): boolean {
  return canRegisterCheckpoint(user.roles);
}

export async function runWithManagerConnection<T>(
  managerUserId: string,
  connectionId: string | null,
  deps: ManagerConnectionDeps,
  options: { capability: M365Capability; logOperation: string },
  fn: (ctx: ManagerCtx) => Promise<T>,
): Promise<ManagerRunResult<T>> {
  if (!connectionId) return { status: "skipped", reason: "no_connection" };
  const precheck = await deps.store.getConnection(connectionId);
  if (!precheck || precheck.userId !== managerUserId) return { status: "skipped", reason: "no_connection" };
  if (precheck.status !== "ACTIVE") return { status: "skipped", reason: "not_active" };
  if (!hasCapability(precheck.scopes, options.capability)) return { status: "skipped", reason: missingReason(options.capability) };
  const user = await deps.store.getUserContext(managerUserId);
  if (!user || !isManagerUser(user.user)) return { status: "skipped", reason: "not_manager" };

  const now = nowOf(deps);
  const until = new Date(now.getTime() + (deps.leaseMs ?? MANAGER_LEASE_MS));
  if (!(await deps.store.claimSyncLease(connectionId, deps.owner, until, now))) return { status: "busy" };
  const guard = { leaseOwner: deps.owner };
  try {
    const connection = await deps.store.getConnection(connectionId);
    if (!connection || connection.status !== "ACTIVE" || connection.userId !== managerUserId) {
      return { status: "skipped", reason: "not_active" };
    }
    if (!hasCapability(connection.scopes, options.capability)) {
      return { status: "skipped", reason: missingReason(options.capability) };
    }
    const managerEmails = [connection.mailbox, user.user.email]
      .filter((e): e is string => Boolean(e))
      .map((e) => e.toLowerCase());
    const value = await fn({ connection, user, graph: deps.graphFor(connection), managerEmails });
    return { status: "ok", value };
  } catch (error) {
    if (error instanceof ConnectionChangedError) return { status: "skipped", reason: "connection_changed" };
    const code = errorCode(error);
    if (isInterruption(error)) return { status: "interrupted", code };
    if (isGraphError(error) && error.kind === "reauth") {
      await deps.store.setStatus(connectionId, "REAUTH_REQUIRED", code, guard);
    } else if (isGraphError(error) && error.kind === "config") {
      await deps.store.setStatus(connectionId, "ERROR", code, guard);
    }
    await deps.store.logIntegrationEvent({
      operation: options.logOperation,
      status: "FAILED",
      entityType: "M365Connection",
      entityId: connectionId,
      error: code,
    });
    return { status: "error", code };
  } finally {
    await deps.store.releaseSyncLease(connectionId, deps.owner);
  }
}
