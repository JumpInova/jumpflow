import type { AppUser } from "@/lib/auth/types";
import { draftRescheduleChange, isDisposableDraft } from "../calendar/detection";
import type {
  ConnectionWriteGuard,
  IntegrationLogInput,
  M365ConnectionRecord,
  M365Store,
  SightedEvent,
  TimeSuggestionInput,
} from "../store";
import type { NormalizedEvent } from "../calendar/normalize";
import type { SuggestionAllocation } from "../calendar/time-suggestions";

/**
 * SOMENTE PARA TESTES: implementação em memória do {@link M365Store}. Espelha
 * as garantias do banco (unique por iCalUId/sighting/(evento,consultor) e lease
 * condicional) para exercitar o sync sem Prisma. Nunca usada em produção.
 */

export interface MemoryCheckpoint {
  id: string;
  calendarEventId: string;
  consultantId: string;
  managerUserId: string;
  type: string;
  occurredAt: Date;
  title: string | null;
  status: string;
  visibility: string;
  notes: string | null;
  transcription: string | null;
  audioStorageKey: string | null;
}

export interface MemoryState {
  connections: Map<string, M365ConnectionRecord & { leaseUntil: Date | null; leaseOwner: string | null; lastSyncAt: Date | null; lastError: string | null }>;
  events: Map<string, NormalizedEvent & { id: string; redactedAt?: Date | null }>; // by iCalUId
  sightings: Map<string, { calendarEventId: string; responseStatus: string | null; removedAt: Date | null; categories: string[]; isCancelled: boolean }>; // key conn|graphId
  users: Map<string, { user: AppUser; consultantId: string | null }>;
  consultantsByEmail: Map<string, string>;
  targetable: Map<string, Set<string>>; // userId -> consultantIds
  allocations: Map<string, SuggestionAllocation[]>; // consultantId -> allocations
  checkpoints: MemoryCheckpoint[];
  suggestions: Map<string, TimeSuggestionInput & { status: "PENDING" | "DISMISSED" }>;
  logs: IntegrationLogInput[];
}

export function createMemoryStore(): { store: M365Store; state: MemoryState } {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const state: MemoryState = {
    connections: new Map(),
    events: new Map(),
    sightings: new Map(),
    users: new Map(),
    consultantsByEmail: new Map(),
    targetable: new Map(),
    allocations: new Map(),
    checkpoints: [],
    suggestions: new Map(),
    logs: [],
  };
  const eventById = (eventId: string) => [...state.events.values()].find((e) => e.id === eventId);
  // Espelha `guardedWhere` (lib/db/m365.ts).
  const allowed = (cid: string, guard: ConnectionWriteGuard) => {
    const c = state.connections.get(cid);
    if (!c) return false;
    if (guard) return c.leaseOwner === guard.leaseOwner && c.status === "ACTIVE";
    return c.status !== "DISCONNECTED" && c.status !== "PAUSED";
  };

  const store: M365Store = {
    async getConnection(cid) {
      const c = state.connections.get(cid);
      return c ? { ...c, scopes: [...c.scopes] } : null;
    },
    async saveTokens(cid, tokens, guard) {
      if (!allowed(cid, guard)) return false;
      Object.assign(state.connections.get(cid)!, tokens);
      return true;
    },
    async setStatus(cid, status, error, guard) {
      if (!allowed(cid, guard)) return false;
      const c = state.connections.get(cid)!;
      c.status = status;
      c.lastError = error;
      return true;
    },
    async claimSyncLease(cid, owner, until, now) {
      const c = state.connections.get(cid);
      if (!c || c.status !== "ACTIVE") return false;
      if (c.leaseUntil && c.leaseUntil >= now && c.leaseOwner !== owner) return false;
      c.leaseUntil = until;
      c.leaseOwner = owner;
      return true;
    },
    async releaseSyncLease(cid, owner) {
      const c = state.connections.get(cid);
      if (c && c.leaseOwner === owner) {
        c.leaseUntil = null;
        c.leaseOwner = null;
      }
    },
    async renewSyncLease(cid, owner, until) {
      const c = state.connections.get(cid);
      if (!c || c.status !== "ACTIVE" || c.leaseOwner !== owner) return false;
      c.leaseUntil = until;
      return true;
    },
    async findCalendarEventIdByICalUId(iCalUId) {
      return state.events.get(iCalUId)?.id ?? null;
    },
    async saveCalendarCursor(cid, cursor, guard) {
      if (!allowed(cid, guard)) return false;
      const c = state.connections.get(cid)!;
      c.calendarDeltaLink = cursor?.deltaLink ?? null;
      c.calendarWindowStart = cursor?.windowStart ?? null;
      c.calendarWindowEnd = cursor?.windowEnd ?? null;
      return true;
    },
    async recordSyncOutcome(cid, outcome, guard) {
      if (!allowed(cid, guard)) return false;
      const c = state.connections.get(cid)!;
      if (outcome.error) c.lastError = outcome.error;
      else {
        c.lastSyncAt = outcome.at;
        c.lastError = null;
      }
      return true;
    },
    async upsertCalendarEvent(cid, event, now, isOrganizerView) {
      const existing = state.events.get(event.iCalUId);
      const eventId = existing?.id ?? id("evt");
      // Espelha o Prisma: categories só no sighting; isCancelled do evento só
      // pela visão do organizador.
      const isCancelled = isOrganizerView ? event.isCancelled : existing ? existing.isCancelled : false;
      if (existing?.redactedAt && !isOrganizerView) {
        // Redigido pelo organizador: participante não reescreve nada do evento
        // (só o próprio sighting abaixo).
      } else {
        state.events.set(event.iCalUId, { ...event, categories: [], isCancelled, id: eventId, redactedAt: null });
      }
      state.sightings.set(`${cid}|${event.graphEventId}`, {
        calendarEventId: eventId,
        responseStatus: event.responseStatus,
        removedAt: null,
        categories: event.categories,
        isCancelled: event.isCancelled,
      });
      void now;
      if (isCancelled) return { calendarEventId: eventId, cancelled: true };
      if (!isOrganizerView && event.isCancelled) {
        return { calendarEventId: eventId, cancelled: await store.cancelIfNoActiveSighting(eventId) };
      }
      return { calendarEventId: eventId, cancelled: false };
    },
    async redactCalendarEvent(eventId) {
      const e = eventById(eventId);
      if (!e) return "deleted";
      if (!state.checkpoints.some((c) => c.calendarEventId === eventId)) {
        state.events.delete(e.iCalUId);
        for (const [k, s] of state.sightings) if (s.calendarEventId === eventId) state.sightings.delete(k);
        for (const [k, s] of state.suggestions) if (s.calendarEventId === eventId) state.suggestions.delete(k);
        return "deleted";
      }
      Object.assign(e, { subject: null, attendees: [], organizerName: null, joinUrl: null, redactedAt: new Date() });
      for (const s of state.sightings.values()) if (s.calendarEventId === eventId) s.categories = [];
      return "redacted";
    },
    async cancelIfNoActiveSighting(eventId) {
      const active = [...state.sightings.values()].some(
        (s) => s.calendarEventId === eventId && !s.removedAt && !s.isCancelled,
      );
      if (active) return false;
      const e = eventById(eventId);
      if (e) e.isCancelled = true;
      return true;
    },
    async markSightingRemoved(cid, graphEventId, now) {
      const s = state.sightings.get(`${cid}|${graphEventId}`);
      if (!s) return null;
      s.removedAt = now;
      return { calendarEventId: s.calendarEventId, organizerEmail: eventById(s.calendarEventId)?.organizerEmail ?? null };
    },
    async cancelCalendarEvent(eventId) {
      const e = eventById(eventId);
      if (e) e.isCancelled = true;
    },
    async getUserContext(userId) {
      return state.users.get(userId) ?? null;
    },
    async consultantIdsByEmail(emails) {
      const map = new Map<string, string>();
      for (const e of emails) {
        const cid = state.consultantsByEmail.get(e.toLowerCase());
        if (cid) map.set(e.toLowerCase(), cid);
      }
      return map;
    },
    async targetableConsultants(user, ids) {
      const allowed = state.targetable.get(user.id) ?? new Set<string>();
      return new Set(ids.filter((i) => allowed.has(i)));
    },
    async ensureCheckpointDraft(input) {
      const existing = state.checkpoints.find(
        (c) => c.calendarEventId === input.calendarEventId && c.consultantId === input.consultantId,
      );
      if (existing) {
        const change = draftRescheduleChange(existing, input);
        if (!change) return "exists";
        Object.assign(existing, change);
        return "updated";
      }
      state.checkpoints.push({
        id: id("chk"),
        ...input,
        status: "DRAFT",
        visibility: "PRIVATE",
        notes: null,
        transcription: null,
        audioStorageKey: null,
      });
      return "created";
    },
    async archiveDisposableDrafts(eventId) {
      let n = 0;
      for (const c of state.checkpoints) {
        if (c.calendarEventId === eventId && isDisposableDraft(c)) {
          c.status = "ARCHIVED";
          n += 1;
        }
      }
      return n;
    },
    async listRecentSightedEvents(cid, from, to) {
      const out: SightedEvent[] = [];
      for (const [key, s] of state.sightings) {
        if (!key.startsWith(`${cid}|`) || s.removedAt || s.isCancelled) continue;
        const e = eventById(s.calendarEventId);
        if (!e || e.isCancelled || e.endAt < from || e.endAt > to) continue;
        out.push({
          calendarEventId: e.id,
          startAt: e.startAt,
          endAt: e.endAt,
          isAllDay: e.isAllDay,
          isCancelled: e.isCancelled,
          organizerEmail: e.organizerEmail,
          attendees: e.attendees,
          responseStatus: s.responseStatus,
        });
      }
      return out;
    },
    async listSuggestionAllocations(consultantId) {
      return state.allocations.get(consultantId) ?? [];
    },
    async upsertTimeSuggestion(input) {
      const key = `${input.consultantId}|${input.calendarEventId}`;
      const existing = state.suggestions.get(key);
      if (!existing) {
        state.suggestions.set(key, { ...input, status: "PENDING" });
        return "created";
      }
      if (existing.status !== "PENDING") return "unchanged";
      if (existing.minutes === input.minutes && existing.projectIds.join() === input.projectIds.join()) return "unchanged";
      state.suggestions.set(key, { ...input, status: "PENDING" });
      return "updated";
    },
    async deletePendingSuggestions(eventId) {
      let n = 0;
      for (const [key, s] of state.suggestions) {
        if (s.calendarEventId === eventId && s.status === "PENDING") {
          state.suggestions.delete(key);
          n += 1;
        }
      }
      return n;
    },
    async logIntegrationEvent(input) {
      state.logs.push(input);
    },
  };
  return { store, state };
}

export function addConnection(
  state: MemoryState,
  partial: Partial<M365ConnectionRecord> & { id: string; userId: string },
) {
  state.connections.set(partial.id, {
    status: "ACTIVE",
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    expiresAt: null,
    scopes: ["Calendars.Read"],
    mailbox: null,
    calendarDeltaLink: null,
    calendarWindowStart: null,
    calendarWindowEnd: null,
    leaseUntil: null,
    leaseOwner: null,
    lastSyncAt: null,
    lastError: null,
    ...partial,
  });
}
