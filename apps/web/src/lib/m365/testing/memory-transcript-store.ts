import { filterNewActionItems } from "@/lib/checkpoint/action-items";
import type { ActionItemInput } from "../minutes/generate";
import {
  TRANSCRIPT_GRACE_MS,
  TRANSCRIPT_HARD_LIMIT_MS,
  hasContent,
} from "../transcripts/schedule";
import type {
  SaveTranscriptMinutesInput,
  TranscriptCheckpoint,
  TranscriptRecord,
  TranscriptStore,
} from "../transcripts/store";

/**
 * SOMENTE PARA TESTES: {@link TranscriptStore} em memória. Espelha as garantias
 * do banco: registro único por checkpoint, claim condicional (lease livre/
 * vencido + estado), gravações só do dono e update condicional do checkpoint.
 */

export interface MemoryTranscriptState {
  checkpoints: Map<string, Omit<TranscriptCheckpoint, "transcript">>;
  records: Map<string, TranscriptRecord & { aiSummary: boolean; transcriptsUsed: number; truncated: boolean }>;
  connectionsByUser: Map<string, string>;
  /** Usuários cuja conexão está ACTIVE com os escopos do Teams. */
  teamsUsers: Set<string>;
  actionItems: Array<ActionItemInput & { checkpointId: string; status: "PENDING" }>;
  notifications: Array<{ userId: string; checkpointId: string; kind: "ready" | "missing" }>;
  saves: SaveTranscriptMinutesInput[];
  claims: Array<{ checkpointId: string; owner: string; ok: boolean }>;
}

export function createMemoryTranscriptStore(): { transcripts: TranscriptStore; state: MemoryTranscriptState } {
  const state: MemoryTranscriptState = {
    checkpoints: new Map(),
    records: new Map(),
    connectionsByUser: new Map(),
    teamsUsers: new Set(),
    actionItems: [],
    notifications: [],
    saves: [],
    claims: [],
  };
  const view = (id: string): TranscriptCheckpoint | null => {
    const cp = state.checkpoints.get(id);
    if (!cp) return null;
    const rec = state.records.get(id);
    return {
      ...cp,
      transcript: rec
        ? {
            status: rec.status,
            mode: rec.mode,
            attempts: rec.attempts,
            nextAttemptAt: rec.nextAttemptAt,
            lastError: rec.lastError,
            accessDeniedAt: rec.accessDeniedAt,
            leaseOwner: rec.leaseOwner,
            leaseUntil: rec.leaseUntil,
          }
        : null,
    };
  };
  const leaseFree = (rec: TranscriptRecord, now: Date, owner: string) =>
    rec.leaseUntil === null || rec.leaseUntil.getTime() < now.getTime() || rec.leaseOwner === owner;
  const newRecord = (nextAttemptAt: Date) => ({
    status: "PENDING" as const,
    mode: null,
    attempts: 0,
    nextAttemptAt,
    lastError: null,
    accessDeniedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    aiSummary: false,
    transcriptsUsed: 0,
    truncated: false,
  });

  const transcripts: TranscriptStore = {
    async enrollDueCheckpoints(now, limit) {
      let created = 0;
      for (const cp of state.checkpoints.values()) {
        if (created >= limit) break;
        if (state.records.has(cp.checkpointId)) continue;
        if (cp.checkpointStatus !== "DRAFT" || hasContent(cp)) continue;
        if (!cp.eventJoinUrl || cp.eventCancelled) continue;
        const end = cp.eventEndAt.getTime();
        if (end > now.getTime() || now.getTime() - end >= TRANSCRIPT_HARD_LIMIT_MS) continue;
        if (!cp.managerUserId || !state.teamsUsers.has(cp.managerUserId)) continue;
        state.records.set(cp.checkpointId, newRecord(new Date(end + TRANSCRIPT_GRACE_MS)));
        created += 1;
      }
      return created;
    },
    async listDue(now, limit) {
      const out: TranscriptCheckpoint[] = [];
      for (const [id, rec] of state.records) {
        const cp = state.checkpoints.get(id);
        if (!cp || !cp.managerUserId || !state.teamsUsers.has(cp.managerUserId)) continue;
        const end = cp.eventEndAt.getTime();
        if (end > now.getTime() || now.getTime() - end >= TRANSCRIPT_HARD_LIMIT_MS) continue;
        const leaseExpired = rec.leaseUntil === null || rec.leaseUntil.getTime() < now.getTime();
        const due =
          ((rec.status === "PENDING" || rec.status === "WAITING_TRANSCRIPT") &&
            rec.nextAttemptAt !== null &&
            rec.nextAttemptAt.getTime() <= now.getTime() &&
            leaseExpired) ||
          // GENERATING sem lease vivo (nulo ou vencido) é retomado.
          (rec.status === "GENERATING" && leaseExpired);
        if (due) out.push(view(id)!);
        if (out.length >= limit) break;
      }
      return out;
    },
    async getTranscriptCheckpoint(id) {
      return view(id);
    },
    async connectionIdForUser(userId) {
      return state.connectionsByUser.get(userId) ?? null;
    },
    async ensureRecord(checkpointId, nextAttemptAt) {
      if (!state.records.has(checkpointId)) state.records.set(checkpointId, newRecord(nextAttemptAt));
    },
    async claim(checkpointId, owner, until, now, force) {
      const rec = state.records.get(checkpointId);
      let ok = false;
      if (rec && rec.status !== "DONE" && leaseFree(rec, now, owner)) {
        ok = force
          ? true
          : ((rec.status === "PENDING" || rec.status === "WAITING_TRANSCRIPT") &&
              rec.nextAttemptAt !== null &&
              rec.nextAttemptAt.getTime() <= now.getTime()) ||
            rec.status === "GENERATING";
      }
      if (ok && rec) {
        rec.leaseOwner = owner;
        rec.leaseUntil = until;
      }
      state.claims.push({ checkpointId, owner, ok });
      return ok;
    },
    async markGenerating(checkpointId, owner, until) {
      const rec = state.records.get(checkpointId);
      if (!rec || rec.leaseOwner !== owner || rec.status === "DONE") return false;
      rec.status = "GENERATING";
      rec.leaseUntil = until;
      return true;
    },
    async recordAttempt(checkpointId, owner, outcome) {
      const rec = state.records.get(checkpointId);
      if (!rec || rec.leaseOwner !== owner || rec.status === "DONE") return false;
      rec.status = outcome.status;
      rec.nextAttemptAt = outcome.nextAttemptAt;
      rec.lastError = outcome.error;
      if (outcome.accessDeniedAt) rec.accessDeniedAt = outcome.accessDeniedAt;
      rec.attempts += 1;
      rec.leaseOwner = null;
      rec.leaseUntil = null;
      return true;
    },
    async releaseClaim(checkpointId, owner, ifGenerating) {
      const rec = state.records.get(checkpointId);
      if (!rec || rec.leaseOwner !== owner) return;
      if (rec.status === "GENERATING") {
        rec.status = ifGenerating.status;
        rec.nextAttemptAt = ifGenerating.nextAttemptAt;
        rec.lastError = ifGenerating.error;
        rec.attempts += 1;
      }
      rec.leaseOwner = null;
      rec.leaseUntil = null;
    },
    async expireStale(now) {
      let n = 0;
      for (const [id, rec] of state.records) {
        const cp = state.checkpoints.get(id);
        if (!cp) continue;
        if (rec.status !== "PENDING" && rec.status !== "WAITING_TRANSCRIPT" && rec.status !== "GENERATING") continue;
        if (rec.leaseUntil !== null && rec.leaseUntil.getTime() >= now.getTime()) continue;
        if (now.getTime() - cp.eventEndAt.getTime() <= TRANSCRIPT_HARD_LIMIT_MS) continue;
        Object.assign(rec, { status: "NO_TRANSCRIPT", nextAttemptAt: null, lastError: "expired", leaseOwner: null, leaseUntil: null });
        n += 1;
      }
      return n;
    },
    async saveTranscriptMinutes(input) {
      state.saves.push(input);
      const rec = state.records.get(input.checkpointId);
      if (!rec || rec.leaseOwner !== input.owner || rec.status !== "GENERATING") return "lease_lost";
      const cp = state.checkpoints.get(input.checkpointId);
      if (!cp) return "checkpoint_changed";
      const same = cp.notes === input.expected.notes && cp.transcription === input.expected.transcription;
      const ok =
        input.mode === "GENERATE"
          ? cp.checkpointStatus === "DRAFT" && same && cp.audioStorageKey === null
          : cp.checkpointStatus === input.expected.checkpointStatus && cp.checkpointStatus !== "ARCHIVED" && same;
      if (!ok) return "checkpoint_changed";
      cp.notes = input.notes;
      cp.transcription = input.transcription;
      if (cp.checkpointStatus === "DRAFT") cp.checkpointStatus = "RECORDED";
      Object.assign(rec, {
        status: "DONE",
        mode: input.mode,
        aiSummary: input.aiSummary,
        transcriptsUsed: input.transcriptsUsed,
        truncated: input.truncated,
        lastError: null,
        nextAttemptAt: null,
        attempts: rec.attempts + 1,
        leaseOwner: null,
        leaseUntil: null,
      });
      const existing = state.actionItems.filter((a) => a.checkpointId === input.checkpointId);
      for (const item of filterNewActionItems(input.actionItems, existing)) {
        state.actionItems.push({ ...item, checkpointId: input.checkpointId, status: "PENDING" });
      }
      return "saved";
    },
    async notifyManager(input) {
      state.notifications.push(input);
    },
  };
  return { transcripts, state };
}
