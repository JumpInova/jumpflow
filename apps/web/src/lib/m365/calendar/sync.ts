import { canRegisterCheckpoint } from "@/lib/checkpoint/visibility";
import { PUBLIC_EMAIL_DOMAINS, configuredInternalDomains } from "../config";
import type { GraphClient } from "../graph/client";
import { GraphError, errorCode, isGraphError, isInterruption } from "../graph/errors";
import type { GraphEvent } from "../graph/types";
import {
  ConnectionChangedError,
  type ConnectionWriteGuard,
  type M365ConnectionRecord,
  type M365Store,
} from "../store";
import { detectCheckpoint } from "./detection";
import { domainOf, normalizeGraphEvent, type NormalizedEvent } from "./normalize";
import { localDateAsUtcMidnight } from "./time";
import { SUGGESTION_LOOKBACK_DAYS, planTimeSuggestion } from "./time-suggestions";

/**
 * Sync delta da agenda de UMA conexão (`/me/calendarView/delta`).
 *
 * - Janela −30/+60 dias. O cursor (deltaLink) é por conexão e só é gravado ao
 *   fim da paginação; uma rodada interrompida recomeça do cursor anterior
 *   (reprocessar é idempotente).
 * - 410/resync → descarta o cursor e recomeça a janela (uma vez por rodada).
 * - A janela "rola": se o cursor foi aberto há mais de {@link WINDOW_ROLLOVER_DAYS}
 *   dias, recomeça a janela para continuar cobrindo −30/+60 a partir de hoje.
 * - Lease no banco (claim atômico): duas instâncias nunca sincronizam a mesma
 *   conexão ao mesmo tempo.
 * - Efeitos: rascunhos de Checkpoint (agenda de gestor) e sugestões de horas
 *   (agenda de consultor). Logs só com contadores/códigos.
 */

export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 60;
export const WINDOW_ROLLOVER_DAYS = 7;
export const SYNC_LEASE_MS = 5 * 60_000;
export const MAX_PAGES_PER_ROUND = 100;

const DAY_MS = 86_400_000;

export interface CalendarSyncDeps {
  store: M365Store;
  /** Cria o cliente Graph da conexão (tokens já ligados). */
  graphFor: (connection: M365ConnectionRecord) => GraphClient;
  now?: () => Date;
  /** Identificador desta rodada/instância (dono do lease). */
  owner: string;
  leaseMs?: number;
  internalDomains?: string[];
}

export type CalendarSyncResult =
  | { status: "skipped"; reason: "not_found" | "not_active" | "connection_changed" }
  | { status: "busy" }
  | {
      status: "ok";
      restarted: boolean;
      upserted: number;
      removed: number;
      skipped: number;
      draftsCreated: number;
      draftsArchived: number;
      suggestions: number;
    }
  | { status: "interrupted"; code: string }
  | { status: "error"; code: string; connectionStatus: string | null };

export function calendarWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - WINDOW_PAST_DAYS * DAY_MS),
    end: new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS),
  };
}

/** O cursor atual precisa recomeçar a janela? (sem cursor ou janela velha). */
export function shouldRestartWindow(connection: M365ConnectionRecord, now: Date): boolean {
  if (!connection.calendarDeltaLink || !connection.calendarWindowStart) return true;
  const expectedStart = now.getTime() - WINDOW_PAST_DAYS * DAY_MS;
  return expectedStart - connection.calendarWindowStart.getTime() > WINDOW_ROLLOVER_DAYS * DAY_MS;
}

interface RoundStats {
  redacted: number;
  upserted: number;
  removed: number;
  skipped: number;
  changed: NormalizedEvent[];
  changedIds: Map<string, string>;
  cancelledIds: Set<string>;
}

async function pullDelta(
  deps: CalendarSyncDeps,
  connection: M365ConnectionRecord,
  graph: GraphClient,
  now: Date,
  restart: boolean,
  stats: RoundStats,
): Promise<void> {
  const window = restart
    ? calendarWindow(now)
    : { start: connection.calendarWindowStart!, end: connection.calendarWindowEnd ?? calendarWindow(now).end };
  let request: Parameters<GraphClient["calendarViewDelta"]>[0] = restart
    ? { startDateTime: window.start.toISOString(), endDateTime: window.end.toISOString() }
    : { link: connection.calendarDeltaLink! };

  for (let page = 0; page < MAX_PAGES_PER_ROUND; page += 1) {
    const result = await graph.calendarViewDelta(request);
    for (const raw of result.value) await applyItem(deps, connection, raw, now, stats);
    if (result.nextLink) {
      request = { link: result.nextLink };
      continue;
    }
    if (result.deltaLink) {
      const saved = await deps.store.saveCalendarCursor(
        connection.id,
        { deltaLink: result.deltaLink, windowStart: window.start, windowEnd: window.end },
        { leaseOwner: deps.owner },
      );
      if (!saved) throw new ConnectionChangedError();
      return;
    }
    throw new GraphError("http", "Delta sem nextLink nem deltaLink.", { code: "missing_delta_link" });
  }
  throw new GraphError("http", "Paginação do delta excedeu o limite.", { code: "too_many_pages" });
}

async function applyItem(
  deps: CalendarSyncDeps,
  connection: M365ConnectionRecord,
  raw: GraphEvent,
  now: Date,
  stats: RoundStats,
): Promise<void> {
  const result = normalizeGraphEvent(raw);
  const mailbox = connection.mailbox?.toLowerCase() ?? null;
  if (result.kind === "event") {
    const isOrganizerView = Boolean(mailbox && result.event.organizerEmail === mailbox);
    const { calendarEventId, cancelled } = await deps.store.upsertCalendarEvent(
      connection.id,
      result.event,
      now,
      isOrganizerView,
    );
    stats.upserted += 1;
    stats.changed.push(result.event);
    stats.changedIds.set(result.event.iCalUId, calendarEventId);
    if (cancelled) stats.cancelledIds.add(calendarEventId);
    return;
  }
  if (!result.graphEventId) {
    stats.skipped += 1;
    return;
  }
  // Removido OU passou a ser privado/series master: some desta agenda.
  const removed = await deps.store.markSightingRemoved(connection.id, result.graphEventId, now);
  // O ORGANIZADOR marcou como privado/confidencial: o evento deixa de guardar
  // assunto/participantes (ou é apagado, se não houver Checkpoint vinculado).
  if (
    removed &&
    result.kind === "skip" &&
    result.reason === "private" &&
    mailbox &&
    (result.organizerEmail === mailbox || removed.organizerEmail === mailbox)
  ) {
    await deps.store.redactCalendarEvent(removed.calendarEventId);
    stats.redacted += 1;
    return;
  }
  if (result.kind === "removed") stats.removed += 1;
  else stats.skipped += 1;
  if (!removed) return;
  // Organizador apagou o evento da própria agenda = cancelamento. Removido de
  // um participante só cancela se nenhuma outra caixa ainda o tiver ativo.
  if (result.kind === "removed" && mailbox && removed.organizerEmail === mailbox) {
    await deps.store.cancelCalendarEvent(removed.calendarEventId);
    stats.cancelledIds.add(removed.calendarEventId);
  } else if (await deps.store.cancelIfNoActiveSighting(removed.calendarEventId)) {
    stats.cancelledIds.add(removed.calendarEventId);
  }
}

async function applyCheckpointDrafts(
  deps: CalendarSyncDeps,
  connection: M365ConnectionRecord,
  stats: RoundStats,
): Promise<number> {
  const ctx = await deps.store.getUserContext(connection.userId);
  if (!ctx || !canRegisterCheckpoint(ctx.user.roles)) return 0;
  const managerEmails = [connection.mailbox, ctx.user.email]
    .filter((e): e is string => Boolean(e))
    .map((e) => e.toLowerCase());
  const managerSet = new Set(managerEmails);
  const organized = stats.changed.filter(
    (e) => !e.isCancelled && e.organizerEmail && managerSet.has(e.organizerEmail),
  );
  if (organized.length === 0) return 0;

  const emails = [...new Set(organized.flatMap((e) => e.attendees.map((a) => a.email)))];
  const byEmail = await deps.store.consultantIdsByEmail(emails);
  const inScope = await deps.store.targetableConsultants(ctx.user, [...new Set(byEmail.values())]);

  let created = 0;
  for (const event of organized) {
    const detection = detectCheckpoint({
      event,
      managerEmails,
      consultantIdByEmail: byEmail,
      inScopeConsultantIds: inScope,
    });
    if (detection.kind !== "checkpoint") continue;
    const outcome = await deps.store.ensureCheckpointDraft({
      calendarEventId: stats.changedIds.get(event.iCalUId)!,
      consultantId: detection.consultantId,
      managerUserId: ctx.user.id,
      type: detection.type,
      occurredAt: event.startAt,
      title: event.subject,
    });
    if (outcome === "created") created += 1;
  }
  return created;
}

async function applyTimeSuggestions(
  deps: CalendarSyncDeps,
  connection: M365ConnectionRecord,
  now: Date,
): Promise<number> {
  const ctx = await deps.store.getUserContext(connection.userId);
  if (!ctx?.consultantId) return 0;
  const internal = new Set(deps.internalDomains ?? configuredInternalDomains());
  for (const email of [connection.mailbox, ctx.user.email]) {
    const domain = email ? domainOf(email.toLowerCase()) : null;
    if (domain) internal.add(domain);
  }
  const from = new Date(now.getTime() - SUGGESTION_LOOKBACK_DAYS * DAY_MS);
  const events = await deps.store.listRecentSightedEvents(connection.id, from, now);
  let count = 0;
  const allocationsByDate = new Map<string, Awaited<ReturnType<M365Store["listSuggestionAllocations"]>>>();
  for (const event of events) {
    const date = localDateAsUtcMidnight(event.startAt);
    const key = date.toISOString();
    let allocations = allocationsByDate.get(key);
    if (!allocations) {
      allocations = await deps.store.listSuggestionAllocations(ctx.consultantId, date);
      allocationsByDate.set(key, allocations);
    }
    const plan = planTimeSuggestion({
      event,
      responseStatus: event.responseStatus,
      allocations,
      internalDomains: internal,
      publicDomains: PUBLIC_EMAIL_DOMAINS,
      now,
    });
    if (!plan) continue;
    const outcome = await deps.store.upsertTimeSuggestion({
      consultantId: ctx.consultantId,
      calendarEventId: event.calendarEventId,
      date,
      startAt: event.startAt,
      endAt: event.endAt,
      minutes: plan.minutes,
      projectIds: plan.projectIds,
      matchKind: plan.matchKind,
    });
    if (outcome !== "unchanged") count += 1;
  }
  return count;
}

/** Sincroniza a agenda de uma conexão. Nunca lança: devolve o resultado. */
export async function syncCalendarConnection(
  connectionId: string,
  deps: CalendarSyncDeps,
): Promise<CalendarSyncResult> {
  const now = (deps.now ?? (() => new Date()))();
  const store = deps.store;
  const precheck = await store.getConnection(connectionId);
  if (!precheck) return { status: "skipped", reason: "not_found" };
  if (precheck.status !== "ACTIVE") return { status: "skipped", reason: "not_active" };

  const leaseUntil = new Date(now.getTime() + (deps.leaseMs ?? SYNC_LEASE_MS));
  if (!(await store.claimSyncLease(precheck.id, deps.owner, leaseUntil, now))) {
    return { status: "busy" };
  }
  const guard: ConnectionWriteGuard = { leaseOwner: deps.owner };
  // Relê DEPOIS do claim: outra rodada pode ter rotacionado o refresh token ou
  // gravado um cursor novo entre a leitura acima e o lease.
  const connection = await store.getConnection(connectionId);
  if (!connection || connection.status !== "ACTIVE") {
    await store.releaseSyncLease(precheck.id, deps.owner);
    return { status: "skipped", reason: connection ? "not_active" : "not_found" };
  }

  const stats: RoundStats = {
    redacted: 0,
    upserted: 0,
    removed: 0,
    skipped: 0,
    changed: [],
    changedIds: new Map(),
    cancelledIds: new Set(),
  };
  try {
    const graph = deps.graphFor(connection);
    let restarted = shouldRestartWindow(connection, now);
    try {
      await pullDelta(deps, connection, graph, now, restarted, stats);
    } catch (error) {
      if (!(isGraphError(error) && error.kind === "resync") || restarted) throw error;
      // 410: o estado do delta expirou → recomeça a janela (uma vez por rodada).
      if (!(await store.saveCalendarCursor(connection.id, null, guard))) {
        throw new ConnectionChangedError();
      }
      restarted = true;
      await pullDelta(deps, connection, graph, now, true, stats);
    }

    let draftsArchived = 0;
    for (const calendarEventId of stats.cancelledIds) {
      draftsArchived += await store.archiveDisposableDrafts(calendarEventId);
      await store.deletePendingSuggestions(calendarEventId);
    }
    const draftsCreated = await applyCheckpointDrafts(deps, connection, stats);
    const suggestions = await applyTimeSuggestions(deps, connection, now);

    if (!(await store.recordSyncOutcome(connection.id, { at: now, error: null }, guard))) {
      throw new ConnectionChangedError();
    }
    await store.logIntegrationEvent({
      operation: "calendar.sync",
      status: "SUCCESS",
      entityType: "M365Connection",
      entityId: connection.id,
      meta: {
        restarted,
        redacted: stats.redacted,
        upserted: stats.upserted,
        removed: stats.removed,
        skipped: stats.skipped,
        draftsCreated,
        draftsArchived,
        suggestions,
      },
    });
    return {
      status: "ok",
      restarted,
      upserted: stats.upserted,
      removed: stats.removed,
      skipped: stats.skipped,
      draftsCreated,
      draftsArchived,
      suggestions,
    };
  } catch (error) {
    if (error instanceof ConnectionChangedError) {
      // Desconectada/pausada no meio da rodada: nada mais é gravado na conexão.
      await store.logIntegrationEvent({
        operation: "calendar.sync",
        status: "RETRYING",
        entityType: "M365Connection",
        entityId: connection.id,
        error: "connection_changed",
      });
      return { status: "skipped", reason: "connection_changed" };
    }
    const code = errorCode(error);
    if (isInterruption(error)) {
      await store.logIntegrationEvent({
        operation: "calendar.sync",
        status: "RETRYING",
        entityType: "M365Connection",
        entityId: connection.id,
        error: code,
      });
      return { status: "interrupted", code };
    }
    let connectionStatus: string | null = null;
    if (isGraphError(error) && error.kind === "reauth") {
      connectionStatus = "REAUTH_REQUIRED";
      await store.setStatus(connection.id, "REAUTH_REQUIRED", code, guard);
    } else if (isGraphError(error) && error.kind === "config") {
      connectionStatus = "ERROR";
      await store.setStatus(connection.id, "ERROR", code, guard);
    } else {
      await store.recordSyncOutcome(connection.id, { at: now, error: code }, guard);
    }
    await store.logIntegrationEvent({
      operation: "calendar.sync",
      status: "FAILED",
      entityType: "M365Connection",
      entityId: connection.id,
      error: code,
    });
    return { status: "error", code, connectionStatus };
  } finally {
    await store.releaseSyncLease(connection.id, deps.owner);
  }
}
