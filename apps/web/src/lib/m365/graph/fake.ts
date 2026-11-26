import type { CalendarDeltaRequest, GraphClient } from "./client";
import { GraphError } from "./errors";
import type { GraphDeltaPage, GraphEvent, GraphMe } from "./types";

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
 */
export interface FakeGraph extends GraphClient {
  upsertEvent(event: GraphEvent): void;
  removeEvent(id: string): void;
  expireDeltaLinks(): void;
  failNext(error: GraphError): void;
  calls: { me: number; delta: Array<"initial" | "link"> };
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
  const calls: FakeGraph["calls"] = { me: 0, delta: [] };

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
