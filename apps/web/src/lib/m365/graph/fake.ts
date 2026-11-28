import type { CalendarDeltaRequest, GraphClient, MessageQuery } from "./client";
import { GraphError } from "./errors";
import type {
  GraphAttachmentContent,
  GraphDeltaPage,
  GraphEvent,
  GraphMe,
  GraphMessage,
  GraphMessageBody,
  GraphOnlineMeeting,
} from "./types";
import { CONTENT_TOO_LARGE, TRANSCRIPT_MAX_BYTES } from "./client";

/**
 * Fake em memória do {@link GraphClient} para testes (nenhuma chamada real).
 *
 * Simula `/me/calendarView/delta` com um log de mudanças:
 * - a rodada inicial devolve os eventos da janela, paginados (`nextLink`), e
 *   termina com um `deltaLink` que aponta para a posição atual do log;
 * - rodadas seguintes (`{ link }`) devolvem só o que mudou desde então,
 *   incluindo remoções (`@removed`);
 * - `expireDeltaLinks()` faz o próximo uso de um deltaLink antigo falhar com
 *   410 (`resync`), como o Graph faz quando o estado de sync expira;
 * - `failNext(error)` injeta uma falha na próxima chamada.
 *
 * M2 — caixa de e-mail em memória (`addMessage`): `findMessages` aplica a
 * categoria (com janela) ou a busca por palavras do assunto, como o Graph; o
 * corpo e os anexos só saem por `getMessageBody`/`getAttachment`. `calls.mail`
 * registra cada consulta (para provar que a caixa do consultor nunca é lida).
 */
export interface FakeMessage extends GraphMessage {
  id: string;
  body?: GraphMessageBody;
  attachments?: Array<Omit<GraphAttachmentContent, "kind"> & { kind?: GraphAttachmentContent["kind"] }>;
}

/** M3: reunião online do usuário do fake, com transcrições (VTT em memória). */
export interface FakeOnlineMeeting extends GraphOnlineMeeting {
  transcripts?: Array<{ id: string; createdDateTime?: string | null; content: string }>;
}

export interface FakeGraph extends GraphClient {
  upsertEvent(event: GraphEvent): void;
  removeEvent(id: string): void;
  expireDeltaLinks(): void;
  failNext(error: GraphError): void;
  addMessage(message: FakeMessage): void;
  addOnlineMeeting(meeting: FakeOnlineMeeting): void;
  /** Adiciona uma transcrição a uma reunião já cadastrada (fica pronta "depois"). */
  addTranscript(meetingId: string, transcript: { id: string; createdDateTime?: string | null; content: string }): void;
  calls: {
    me: number;
    delta: Array<"initial" | "link">;
    mail: Array<{ op: "find" | "get" | "body" | "attachments" | "attachment"; kind?: MessageQuery["kind"]; id?: string }>;
    teams: Array<{ op: "meeting" | "transcripts" | "content"; joinUrl?: string; id?: string }>;
  };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

const FAKE_BASE = "https://graph.microsoft.com/v1.0/fake";

interface Change {
  seq: number;
  id: string;
  removed: boolean;
}

export function createFakeGraphClient(options: {
  me?: GraphMe;
  events?: GraphEvent[];
  pageSize?: number;
} = {}): FakeGraph {
  const me: GraphMe = options.me ?? {
    id: "graph-user-1",
    mail: "gestor@empresa.com.br",
    userPrincipalName: "gestor@empresa.com.br",
  };
  const pageSize = options.pageSize ?? 50;
  const events = new Map<string, GraphEvent>();
  const log: Change[] = [];
  let seq = 0;
  let generation = 0;
  const pending: GraphError[] = [];
  const calls: FakeGraph["calls"] = { me: 0, delta: [], mail: [], teams: [] };
  const meetings = new Map<string, FakeOnlineMeeting>();
  const messages = new Map<string, FakeMessage>();
  function messageOrThrow(id: string): FakeMessage {
    const m = messages.get(id);
    if (!m) throw new GraphError("not_found", "Graph respondeu 404.", { status: 404, code: "ErrorItemNotFound" });
    return m;
  }
  function meta(m: FakeMessage): GraphMessage {
    const { body: _body, attachments: _attachments, ...rest } = m;
    void _body;
    void _attachments;
    return { ...rest, hasAttachments: (m.attachments?.length ?? 0) > 0 };
  }

  function record(id: string, removed: boolean) {
    seq += 1;
    log.push({ seq, id, removed });
  }

  for (const event of options.events ?? []) {
    events.set(event.id, event);
    record(event.id, false);
  }

  function inWindow(event: GraphEvent, start: string, end: string): boolean {
    const s = event.start?.dateTime ? Date.parse(`${event.start.dateTime.replace(/Z$/, "")}Z`) : NaN;
    const e = event.end?.dateTime ? Date.parse(`${event.end.dateTime.replace(/Z$/, "")}Z`) : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return true;
    return e > Date.parse(start) && s < Date.parse(end);
  }

  function page(
    items: GraphEvent[],
    offset: number,
    makeNext: (offset: number) => string,
  ): GraphDeltaPage<GraphEvent> {
    const slice = items.slice(offset, offset + pageSize);
    const done = offset + pageSize >= items.length;
    return {
      value: slice,
      nextLink: done ? null : makeNext(offset + pageSize),
      deltaLink: done ? `${FAKE_BASE}/delta?gen=${generation}&since=${seq}` : null,
    };
  }

  function throwPending() {
    const next = pending.shift();
    if (next) throw next;
  }

  const fake: FakeGraph = {
    calls,
    upsertEvent(event) {
      events.set(event.id, event);
      record(event.id, false);
    },
    removeEvent(id) {
      events.delete(id);
      record(id, true);
    },
    expireDeltaLinks() {
      generation += 1;
    },
    failNext(error) {
      pending.push(error);
    },
    addMessage(message) {
      messages.set(message.id, message);
    },
    addOnlineMeeting(meeting) {
      meetings.set(meeting.id, { ...meeting, transcripts: [...(meeting.transcripts ?? [])] });
    },
    addTranscript(meetingId, transcript) {
      const m = meetings.get(meetingId);
      if (m) m.transcripts = [...(m.transcripts ?? []), transcript];
    },
    async findOnlineMeetingByJoinUrl(joinUrl) {
      throwPending();
      calls.teams.push({ op: "meeting", joinUrl });
      // Como o Graph: comparação exata do link (só reuniões do próprio usuário).
      const found = [...meetings.values()].find((m) => m.joinWebUrl === joinUrl);
      return found ? { id: found.id, joinWebUrl: found.joinWebUrl, organizerId: found.organizerId } : null;
    },
    async listTranscripts(meetingId) {
      throwPending();
      calls.teams.push({ op: "transcripts", id: meetingId });
      const m = meetings.get(meetingId);
      if (!m) throw new GraphError("not_found", "Graph respondeu 404.", { status: 404 });
      return (m.transcripts ?? []).map((t) => ({ id: t.id, createdDateTime: t.createdDateTime ?? null }));
    },
    async getTranscriptContent(meetingId, transcriptId, maxBytes = TRANSCRIPT_MAX_BYTES) {
      throwPending();
      calls.teams.push({ op: "content", id: transcriptId });
      const t = meetings.get(meetingId)?.transcripts?.find((x) => x.id === transcriptId);
      if (!t) throw new GraphError("not_found", "Graph respondeu 404.", { status: 404 });
      if (Buffer.byteLength(t.content, "utf8") > maxBytes) {
        throw new GraphError("http", "Conteúdo acima do teto.", { status: 200, code: CONTENT_TOO_LARGE });
      }
      return t.content;
    },
    async findMessages(query) {
      throwPending();
      calls.mail.push({ op: "find", kind: query.kind });
      const all = [...messages.values()];
      if (query.kind === "category") {
        const since = Date.parse(query.since);
        const until = Date.parse(query.until);
        return all
          .filter((m) => (m.categories ?? []).some((c) => c.toLowerCase() === query.category.toLowerCase()))
          .filter((m) => {
            const at = Date.parse(m.receivedDateTime ?? "");
            return at >= since && at <= until;
          })
          .map(meta);
      }
      // $search por assunto: todas as palavras do termo presentes no assunto.
      const terms = words(query.subject);
      return all.filter((m) => {
        const subjectWords = new Set(words(m.subject ?? ""));
        return terms.every((t) => subjectWords.has(t));
      }).map(meta);
    },
    async getMessage(id) {
      throwPending();
      calls.mail.push({ op: "get", id });
      return meta(messageOrThrow(id));
    },
    async getMessageBody(id) {
      throwPending();
      calls.mail.push({ op: "body", id });
      return (
        messageOrThrow(id).body ?? { contentType: "text", content: "", uniqueContentType: null, uniqueContent: null }
      );
    },
    async listAttachments(id) {
      throwPending();
      calls.mail.push({ op: "attachments", id });
      return (messageOrThrow(id).attachments ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        isInline: a.isInline,
        kind: a.kind ?? "file",
      }));
    },
    async getAttachment(id, attachmentId) {
      throwPending();
      calls.mail.push({ op: "attachment", id });
      const a = (messageOrThrow(id).attachments ?? []).find((x) => x.id === attachmentId);
      if (!a) throw new GraphError("not_found", "Graph respondeu 404.", { status: 404 });
      return { ...a, kind: a.kind ?? "file" };
    },
    async getMe() {
      calls.me += 1;
      throwPending();
      return me;
    },
    async calendarViewDelta(request: CalendarDeltaRequest) {
      throwPending();
      if (!("link" in request)) {
        calls.delta.push("initial");
        const all = [...events.values()].filter((e) =>
          inWindow(e, request.startDateTime, request.endDateTime),
        );
        const s = encodeURIComponent(request.startDateTime);
        const e = encodeURIComponent(request.endDateTime);
        return page(all, 0, (o) => `${FAKE_BASE}/initial?gen=${generation}&s=${s}&e=${e}&offset=${o}`);
      }
      calls.delta.push("link");
      const url = new URL(request.link);
      if (Number(url.searchParams.get("gen")) !== generation) {
        throw new GraphError("resync", "Graph respondeu 410.", { status: 410, code: "syncStateNotFound" });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (url.pathname.endsWith("/initial")) {
        const start = url.searchParams.get("s") ?? "";
        const end = url.searchParams.get("e") ?? "";
        const all = [...events.values()].filter((ev) => inWindow(ev, start, end));
        return page(all, offset, (o) => `${FAKE_BASE}/initial?gen=${generation}&s=${encodeURIComponent(start)}&e=${encodeURIComponent(end)}&offset=${o}`);
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      const latest = new Map<string, Change>();
      for (const change of log) if (change.seq > since) latest.set(change.id, change);
      const items: GraphEvent[] = [...latest.values()].map((c) =>
        c.removed || !events.has(c.id)
          ? ({ id: c.id, "@removed": { reason: "deleted" } } as GraphEvent)
          : events.get(c.id)!,
      );
      return page(items, offset, (o) => `${FAKE_BASE}/changes?gen=${generation}&since=${since}&offset=${o}`);
    },
  };
  return fake;
}
