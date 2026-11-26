import { randomUUID } from "node:crypto";
import { isDatabaseConfigured } from "@/lib/db/config";
import { isM365Enabled, resolveM365Credentials } from "./config";
import { syncCalendarConnection, type CalendarSyncResult } from "./calendar/sync";
import { createHttpGraphClient } from "./graph/client";
import { GraphError } from "./graph/errors";
import type { MinutesDeps, MinutesJobSummary } from "./minutes/run";
import type { M365ConnectionRecord, M365Store } from "./store";
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

/** Cliente Graph HTTP da conexão, com tokens sob o lease da rodada. */
function httpGraphFor(store: M365Store, owner: string, deadline: number) {
  const creds = resolveM365Credentials();
  return (connection: M365ConnectionRecord) => {
    if (!creds.ok) {
      throw new GraphError("config", "Credenciais ausentes.", { code: creds.reason });
    }
    return createHttpGraphClient({
      tokens: createTokenProvider({
        store,
        connection,
        credentials: creds.credentials,
        leaseOwner: owner,
      }),
      deadline,
    });
  };
}

async function syncOne(connectionId: string, deadline: number, owner: string): Promise<CalendarSyncResult> {
  const { prismaM365Store } = await import("@/lib/db/m365");
  return syncCalendarConnection(connectionId, {
    store: prismaM365Store,
    owner,
    graphFor: httpGraphFor(prismaM365Store, owner, deadline),
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

// ── M2: atas por e-mail ──────────────────────────────────────────────────────

async function minutesDeps(owner: string, deadline: number): Promise<MinutesDeps> {
  const { prismaM365Store } = await import("@/lib/db/m365");
  const { prismaMinutesStore, loadExtractionRow } = await import("@/lib/db/m365-minutes");
  const { getAiTextProvider } = await import("@/lib/ai/provider");
  const { runCheckpointExtraction } = await import("@/lib/checkpoint/run-extraction");
  return {
    store: prismaM365Store,
    minutes: prismaMinutesStore,
    graphFor: httpGraphFor(prismaM365Store, owner, deadline),
    // Sempre via a fábrica (DeepSeek → Gemini); nunca um provider direto.
    ai: getAiTextProvider(),
    runExtraction: async (checkpointId, input) => {
      const row = await loadExtractionRow(checkpointId);
      if (!row) return "skipped";
      // A IA da extração recebe a ata/fonte MASCARADAS desta execução; os cards
      // são desmascarados com o mesmo mapa antes de gravar.
      const result = await runCheckpointExtraction(row, {
        actorUserId: null,
        masked: { notes: input.maskedNotes, transcription: input.maskedTranscription, piiMap: input.piiMap },
      });
      return result.status;
    },
    owner,
    deadline,
  };
}

/** Job cron das atas por e-mail (lease por conexão do gestor). */
export async function runMeetingMinutesJob(options: { limit?: number; roundMs?: number } = {}): Promise<MinutesJobSummary> {
  const deadline = Date.now() + (options.roundMs ?? JOB_ROUND_MS);
  const { runMinutesRound } = await import("./minutes/run");
  return runMinutesRound(await minutesDeps(`job:${randomUUID()}`, deadline), options.limit ?? 50);
}

/** "Buscar ata no e-mail" na tela do Checkpoint (só o gestor do checkpoint). */
export async function searchCheckpointMinutesNow(checkpointId: string, actorUserId: string) {
  const { searchMinutesNow } = await import("./minutes/run");
  return searchMinutesNow(checkpointId, actorUserId, await minutesDeps(`user:${randomUUID()}`, Date.now() + JOB_ROUND_MS));
}

/** Candidatas (empate) lidas ao vivo da caixa do gestor; nada é persistido. */
export async function listCheckpointMinutesChoices(checkpointId: string, actorUserId: string) {
  const { listMinutesChoices } = await import("./minutes/run");
  return listMinutesChoices(checkpointId, actorUserId, await minutesDeps(`user:${randomUUID()}`, Date.now() + JOB_ROUND_MS));
}

/** O gestor escolheu o e-mail da ata. */
export async function chooseCheckpointMinutesMessage(checkpointId: string, messageId: string, actorUserId: string) {
  const { chooseMinutesMessage } = await import("./minutes/run");
  return chooseMinutesMessage(
    checkpointId,
    messageId,
    actorUserId,
    await minutesDeps(`user:${randomUUID()}`, Date.now() + JOB_ROUND_MS),
  );
}
