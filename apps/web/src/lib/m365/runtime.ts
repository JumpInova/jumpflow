import { randomUUID } from "node:crypto";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isM365Enabled, resolveM365Credentials } from "./config";
import { syncCalendarConnection, type CalendarSyncResult } from "./calendar/sync";
import { createHttpGraphClient } from "./graph/client";
import { GraphError } from "./graph/errors";
import { createTokenProvider } from "./tokens";

/**
 * Composição real (Prisma + Graph HTTP) dos fluxos de sync. Os testes exercitam
 * `syncCalendarConnection` direto com store em memória e Graph fake; este
 * arquivo só liga as peças de produção.
 */

/** Prazo de uma rodada do job (abaixo do timeout típico de requisição). */
export const JOB_ROUND_MS = 50_000;
export const JOB_MAX_CONNECTIONS = 25;

export type M365RuntimeGate =
  | { ok: true }
  | { ok: false; reason: "disabled" | "no_database" | "missing_credentials" | "forbidden_tenant" };

export function m365RuntimeGate(): M365RuntimeGate {
  if (!isM365Enabled()) return { ok: false, reason: "disabled" };
  if (!isDatabaseConfigured()) return { ok: false, reason: "no_database" };
  const creds = resolveM365Credentials();
  if (!creds.ok) return { ok: false, reason: creds.reason };
  return { ok: true };
}

async function syncOne(connectionId: string, deadline: number, owner: string): Promise<CalendarSyncResult> {
  const creds = resolveM365Credentials();
  const { prismaM365Store } = await import("@/lib/db/m365");
  return syncCalendarConnection(connectionId, {
    store: prismaM365Store,
    owner,
    graphFor: (connection) => {
      if (!creds.ok) {
        throw new GraphError("config", "Credenciais ausentes.", { code: creds.reason });
      }
      return createHttpGraphClient({
        tokens: createTokenProvider({
          store: prismaM365Store,
          connection,
          credentials: creds.credentials,
          leaseOwner: owner,
        }),
        deadline,
      });
    },
  });
}

export interface CalendarJobSummary {
  processed: number;
  ok: number;
  busy: number;
  interrupted: number;
  errors: number;
  skipped: number;
}

/** Job cron: sincroniza as conexões ACTIVE mais atrasadas dentro do prazo. */
export async function runCalendarSyncJob(
  options: { limit?: number; roundMs?: number } = {},
): Promise<CalendarJobSummary> {
  const summary: CalendarJobSummary = { processed: 0, ok: 0, busy: 0, interrupted: 0, errors: 0, skipped: 0 };
  const deadline = Date.now() + (options.roundMs ?? JOB_ROUND_MS);
  const owner = `job:${randomUUID()}`;
  const { listDueConnectionIds } = await import("@/lib/db/m365");
  const ids = await listDueConnectionIds(options.limit ?? JOB_MAX_CONNECTIONS);
  for (const id of ids) {
    if (Date.now() >= deadline) break;
    const result = await syncOne(id, deadline, owner);
    summary.processed += 1;
    if (result.status === "ok") summary.ok += 1;
    else if (result.status === "busy") summary.busy += 1;
    else if (result.status === "interrupted") summary.interrupted += 1;
    else if (result.status === "error") summary.errors += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** "Sincronizar agora" da tela do usuário (mesmo lease do job). */
export async function syncConnectionNow(connectionId: string): Promise<CalendarSyncResult> {
  return syncOne(connectionId, Date.now() + JOB_ROUND_MS, `user:${randomUUID()}`);
}
