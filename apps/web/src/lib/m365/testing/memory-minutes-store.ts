import type { ActionItemInput } from "../minutes/generate";
import type {
  EmailMinutesStatus,
  MinutesCheckpoint,
  MinutesStore,
  SaveMinutesInput,
} from "../minutes/store";

/**
 * SOMENTE PARA TESTES: {@link MinutesStore} em memória. Espelha as garantias do
 * banco: `internetMessageId` único entre checkpoints e update condicional do
 * rascunho (DRAFT + notas/transcrição como lidas).
 */

export interface MemoryMinutesRecord {
  status: EmailMinutesStatus;
  internetMessageId: string | null;
  webLink: string | null;
  receivedAt: Date | null;
  aiSummary: boolean;
  attempts: number;
  lastError: string | null;
  attachmentsUsed: number;
  attachmentsSkipped: number;
}

export interface MemoryMinutesState {
  checkpoints: Map<string, MinutesCheckpoint>;
  minutes: Map<string, MemoryMinutesRecord>;
  actionItems: Array<ActionItemInput & { checkpointId: string; status: "PENDING" }>;
  connectionsByUser: Map<string, string>;
  consultantEmails: Map<string, string[]>;
  notifications: Array<{ userId: string; checkpointId: string; kind: "ready" | "choice" }>;
  saves: SaveMinutesInput[];
}

export function createMemoryMinutesStore(): { minutes: MinutesStore; state: MemoryMinutesState } {
  const state: MemoryMinutesState = {
    checkpoints: new Map(),
    minutes: new Map(),
    actionItems: [],
    connectionsByUser: new Map(),
    consultantEmails: new Map(),
    notifications: [],
    saves: [],
  };
  const withStatus = (cp: MinutesCheckpoint): MinutesCheckpoint => ({
    ...cp,
    minutesStatus: state.minutes.get(cp.checkpointId)?.status ?? null,
  });
  const minutes: MinutesStore = {
    async listDueCheckpoints(_now, limit) {
      return [...state.checkpoints.values()]
        .map(withStatus)
        .filter((cp) => cp.minutesStatus === null || cp.minutesStatus === "SEARCHING" || cp.minutesStatus === "FAILED")
        .slice(0, limit);
    },
    async getMinutesCheckpoint(id) {
      const cp = state.checkpoints.get(id);
      return cp ? withStatus(cp) : null;
    },
    async connectionIdForUser(userId) {
      return state.connectionsByUser.get(userId) ?? null;
    },
    async consultantEmails(consultantId) {
      return state.consultantEmails.get(consultantId) ?? [];
    },
    async usedInternetMessageIds(ids, except) {
      const used = new Set<string>();
      for (const [cid, rec] of state.minutes) {
        if (cid !== except && rec.internetMessageId && ids.includes(rec.internetMessageId)) used.add(rec.internetMessageId);
      }
      return used;
    },
    async recordSearch(checkpointId, outcome) {
      const existing = state.minutes.get(checkpointId);
      if (existing?.status === "DONE") return { previousStatus: "DONE" };
      const previousStatus = existing?.status ?? null;
      state.minutes.set(checkpointId, {
        internetMessageId: null,
        webLink: null,
        receivedAt: null,
        aiSummary: false,
        attachmentsUsed: 0,
        attachmentsSkipped: 0,
        ...existing,
        status: outcome.status,
        lastError: outcome.error,
        attempts: (existing?.attempts ?? 0) + 1,
      });
      return { previousStatus };
    },
    async saveMinutes(input) {
      state.saves.push(input);
      for (const [cid, rec] of state.minutes) {
        if (cid !== input.checkpointId && rec.internetMessageId === input.source.internetMessageId) {
          return "duplicate_message";
        }
      }
      const cp = state.checkpoints.get(input.checkpointId);
      if (
        !cp ||
        cp.checkpointStatus !== "DRAFT" ||
        cp.notes !== input.expected.notes ||
        cp.transcription !== input.expected.transcription ||
        cp.audioStorageKey !== null
      ) {
        return "checkpoint_changed";
      }
      cp.notes = input.notes;
      cp.transcription = input.transcription;
      cp.checkpointStatus = "RECORDED";
      state.minutes.set(input.checkpointId, {
        status: "DONE",
        internetMessageId: input.source.internetMessageId,
        webLink: input.source.webLink,
        receivedAt: input.source.receivedAt,
        aiSummary: input.aiSummary,
        attempts: (state.minutes.get(input.checkpointId)?.attempts ?? 0) + 1,
        lastError: null,
        attachmentsUsed: input.attachmentsUsed,
        attachmentsSkipped: input.attachmentsSkipped,
      });
      for (const item of input.actionItems) {
        state.actionItems.push({ ...item, checkpointId: input.checkpointId, status: "PENDING" });
      }
      return "saved";
    },
    async notifyManager(input) {
      state.notifications.push(input);
    },
  };
  return { minutes, state };
}
