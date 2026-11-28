import { describe, expect, it } from "vitest";
import { createFakeGraphClient, type FakeGraph } from "../graph/fake";
import { GraphError } from "../graph/errors";
import type { GraphEvent } from "../graph/types";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { syncCalendarConnection } from "./sync";

const NOW = new Date("2026-11-26T15:00:00.000Z");

function ev(id: string, o: Partial<GraphEvent> & { startIso?: string; endIso?: string } = {}): GraphEvent {
  const { startIso = "2026-11-27T13:00:00", endIso = "2026-11-27T13:30:00", ...rest } = o;
  return {
    id,
    iCalUId: `ical-${id}`,
    subject: "1:1 Ana",
    start: { dateTime: `${startIso}.0000000`, timeZone: "UTC" },
    end: { dateTime: `${endIso}.0000000`, timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    sensitivity: "normal",
    type: "singleInstance",
    organizer: { emailAddress: { name: "Gestor", address: "gestor@jump.com.br" } },
    attendees: [
      { type: "required", emailAddress: { name: "Ana", address: "ana@jump.com.br" }, status: { response: "accepted" } },
    ],
    categories: [],
    webLink: "https://outlook.office365.com/owa/?itemid=x",
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
    responseStatus: { response: "organizer" },
    ...rest,
  } as GraphEvent & { body?: unknown };
}

function setup() {
  const { store, state } = createMemoryStore();
  state.users.set("u-mgr", {
    user: { id: "u-mgr", name: "Gestor", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] },
    consultantId: null,
  });
  state.users.set("u-ana", {
    user: { id: "u-ana", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] },
    consultantId: "cons-ana",
  });
  state.consultantsByEmail.set("ana@jump.com.br", "cons-ana");
  state.consultantsByEmail.set("bruno@jump.com.br", "cons-bruno");
  state.consultantsByEmail.set("carla@jump.com.br", "cons-carla");
  state.targetable.set("u-mgr", new Set(["cons-ana", "cons-bruno"]));
  state.allocations.set("cons-ana", [
    { projectId: "p-acme", clientEmails: ["contato@acme.com"] },
    { projectId: "p-beta", clientEmails: ["fin@beta.com"] },
  ]);
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br" });
  addConnection(state, { id: "c-ana", userId: "u-ana", mailbox: "ana@jump.com.br" });
  return { store, state };
}

function deps(store: ReturnType<typeof setup>["store"], graph: FakeGraph, now = NOW, owner = "test") {
  return { store, owner, now: () => now, graphFor: () => graph, internalDomains: [] };
}

describe("syncCalendarConnection — delta, cursor e rascunhos", () => {
  it("rodada inicial grava eventos, cursor e cria rascunho DRAFT/PRIVATE só para 1:1 válido", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({
      pageSize: 2,
      events: [
        ev("e1"),
        ev("e2", { subject: "Checkpoint semanal", attendees: [
          { emailAddress: { address: "ana@jump.com.br" } },
          { emailAddress: { address: "bruno@jump.com.br" } },
        ] }),
        ev("e3", { subject: "1:1 Carla", attendees: [{ emailAddress: { address: "carla@jump.com.br" } }] }),
        ev("e4", { sensitivity: "private" }),
        ev("e5", { type: "seriesMaster" }),
        ev("e6", { subject: "Almoço" }),
        ev("e7", { subject: "Alinhamento", categories: ["JumpFlow"], attendees: [{ emailAddress: { address: "bruno@jump.com.br" } }] }),
      ],
    });
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));

    expect(result.status).toBe("ok");
    expect(graph.calls.delta).toEqual(["initial", "link", "link", "link"]);
    expect([...state.events.keys()].sort()).toEqual(["ical-e1", "ical-e2", "ical-e3", "ical-e6", "ical-e7"]);
    const conn = state.connections.get("c-mgr")!;
    expect(conn.calendarDeltaLink).toContain("/delta?");
    expect(conn.calendarWindowStart?.toISOString()).toBe("2026-10-27T15:00:00.000Z");
    expect(conn.leaseOwner).toBeNull();

    // e1 (1:1 com Ana) e e7 (categoria JumpFlow, Bruno) viram rascunho; e2 tem 2
    // consultores; e3 (Carla) está fora do escopo; e6 não tem sinal.
    const drafts = state.checkpoints.map((c) => [c.consultantId, c.type, c.status, c.visibility, c.title]);
    expect(drafts).toEqual([
      ["cons-ana", "ONE_ON_ONE", "DRAFT", "PRIVATE", "1:1 Ana"],
      ["cons-bruno", "CHECKPOINT", "DRAFT", "PRIVATE", "Alinhamento"],
    ]);
    expect(state.checkpoints[0].occurredAt.toISOString()).toBe("2026-11-27T13:00:00.000Z");
  });

  it("nunca armazena corpo do convite e não loga conteúdo pessoal", async () => {
    const { store, state } = setup();
    const withBody = { ...ev("e1"), body: { content: "SEGREDO DO CONVITE" }, bodyPreview: "SEGREDO" } as GraphEvent;
    const graph = createFakeGraphClient({ events: [withBody] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    const stored = JSON.stringify([...state.events.values()]);
    expect(stored).not.toContain("SEGREDO");
    const logs = JSON.stringify(state.logs);
    expect(logs).not.toContain("@");
    expect(logs).not.toContain("1:1 Ana");
  });

  it("rodadas seguintes usam o deltaLink e são idempotentes (um rascunho por evento/consultor)", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    graph.upsertEvent(ev("e1", { subject: "1:1 Ana (remarcado)" }));
    const second = await syncCalendarConnection("c-mgr", deps(store, graph));
    await syncCalendarConnection("c-mgr", deps(store, graph));

    expect(second.status).toBe("ok");
    expect(second.status === "ok" && second.restarted).toBe(false);
    expect(graph.calls.delta).toEqual(["initial", "link", "link"]);
    expect(state.events.get("ical-e1")!.subject).toBe("1:1 Ana (remarcado)");
    expect(state.checkpoints).toHaveLength(1);
  });

  it("410 (delta expirado) recomeça a janela na mesma rodada", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    const oldLink = state.connections.get("c-mgr")!.calendarDeltaLink;
    graph.expireDeltaLinks();
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.restarted).toBe(true);
    expect(graph.calls.delta).toEqual(["initial", "link", "initial"]);
    expect(state.connections.get("c-mgr")!.calendarDeltaLink).not.toBe(oldLink);
    expect(state.checkpoints).toHaveLength(1);
  });

  it("janela velha (> 7 dias) recomeça para continuar cobrindo −30/+60", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    const result = await syncCalendarConnection("c-mgr", deps(store, graph, later));
    expect(result.status === "ok" && result.restarted).toBe(true);
    expect(state.connections.get("c-mgr")!.calendarWindowStart?.toISOString()).toBe("2026-11-04T15:00:00.000Z");
  });

  it("lease no banco: outra rodada dona do lease → busy, sem tocar no Graph", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    const conn = state.connections.get("c-mgr")!;
    conn.leaseOwner = "outra-instancia";
    conn.leaseUntil = new Date(NOW.getTime() + 60_000);
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toEqual({ status: "busy" });
    expect(graph.calls.delta).toEqual([]);
    expect(conn.leaseOwner).toBe("outra-instancia");
  });

  it("lease vencido pode ser retomado", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [] });
    const conn = state.connections.get("c-mgr")!;
    conn.leaseOwner = "morta";
    conn.leaseUntil = new Date(NOW.getTime() - 1);
    expect((await syncCalendarConnection("c-mgr", deps(store, graph))).status).toBe("ok");
  });

  it("conexão pausada não sincroniza", async () => {
    const { store, state } = setup();
    state.connections.get("c-mgr")!.status = "PAUSED";
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    expect(await syncCalendarConnection("c-mgr", deps(store, graph))).toEqual({ status: "skipped", reason: "not_active" });
    expect(graph.calls.delta).toEqual([]);
  });

  it("evento cancelado arquiva o rascunho vazio e preserva rascunho com conteúdo", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({
      events: [ev("e1"), ev("e9", { subject: "1:1 Bruno", attendees: [{ emailAddress: { address: "bruno@jump.com.br" } }] })],
    });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(state.checkpoints).toHaveLength(2);
    state.checkpoints.find((c) => c.consultantId === "cons-bruno")!.notes = "anotações do gestor";

    graph.removeEvent("e1"); // organizador apagou → cancelado
    graph.upsertEvent(ev("e9", { subject: "1:1 Bruno", isCancelled: true, attendees: [{ emailAddress: { address: "bruno@jump.com.br" } }] }));
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));

    expect(result.status === "ok" && result.draftsArchived).toBe(1);
    expect(state.checkpoints.find((c) => c.consultantId === "cons-ana")!.status).toBe("ARCHIVED");
    expect(state.checkpoints.find((c) => c.consultantId === "cons-bruno")!.status).toBe("DRAFT");
    expect(state.events.get("ical-e1")!.isCancelled).toBe(true);
  });

  it("consultor não cria rascunho (só papéis de CHECKPOINT_WRITE_ROLES)", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({
      events: [ev("e1", { organizer: { emailAddress: { address: "ana@jump.com.br" } }, attendees: [{ emailAddress: { address: "bruno@jump.com.br" } }] })],
    });
    await syncCalendarConnection("c-ana", deps(store, graph));
    expect(state.checkpoints).toHaveLength(0);
  });
});

describe("syncCalendarConnection — sugestões de horas", () => {
  const past = (id: string, attendee: string, o: Partial<GraphEvent> = {}) =>
    ev(id, {
      subject: `Reunião ${id}`,
      startIso: "2026-11-25T13:00:00",
      endIso: "2026-11-25T14:30:00",
      organizer: { emailAddress: { address: "ana@jump.com.br" } },
      attendees: [{ emailAddress: { address: attendee } }],
      responseStatus: { response: "accepted" },
      ...o,
    });

  it("cria sugestões por e-mail exato e por domínio; ignora público, futuro e recusado", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({
      events: [
        past("s1", "contato@acme.com"),
        past("s2", "outra.pessoa@beta.com"),
        past("s3", "alguem@gmail.com"),
        ev("s4", { organizer: { emailAddress: { address: "ana@jump.com.br" } }, attendees: [{ emailAddress: { address: "contato@acme.com" } }] }),
        past("s5", "contato@acme.com", { responseStatus: { response: "declined" } }),
        past("s6", "colega@jump.com.br"),
      ],
    });
    const result = await syncCalendarConnection("c-ana", deps(store, graph));
    expect(result.status === "ok" && result.suggestions).toBe(2);
    const byEvent = new Map([...state.suggestions.values()].map((s) => [s.calendarEventId, s]));
    const s1 = byEvent.get(state.events.get("ical-s1")!.id)!;
    expect(s1).toMatchObject({ projectIds: ["p-acme"], matchKind: "EMAIL", minutes: 90, status: "PENDING" });
    expect(s1.date.toISOString()).toBe("2026-11-25T00:00:00.000Z");
    const s2 = byEvent.get(state.events.get("ical-s2")!.id)!;
    expect(s2).toMatchObject({ projectIds: ["p-beta"], matchKind: "DOMAIN" });

    // Idempotente: nova rodada não duplica nem altera.
    const again = await syncCalendarConnection("c-ana", deps(store, graph));
    expect(again.status === "ok" && again.suggestions).toBe(0);
    expect(state.suggestions.size).toBe(2);
  });

  it("sugestão dispensada não volta e cancelamento remove a pendente", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [past("s1", "contato@acme.com"), past("s2", "fin@beta.com")] });
    await syncCalendarConnection("c-ana", deps(store, graph));
    const [first] = [...state.suggestions.values()];
    first.status = "DISMISSED";
    graph.upsertEvent(past("s2", "fin@beta.com", { isCancelled: true }));
    await syncCalendarConnection("c-ana", deps(store, graph));
    const left = [...state.suggestions.values()];
    expect(left).toHaveLength(1);
    expect(left[0].status).toBe("DISMISSED");
  });
});

describe("syncCalendarConnection — falhas", () => {
  it("reauth do Graph → REAUTH_REQUIRED, lease liberado, log FAILED sem conteúdo", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    graph.failNext(new GraphError("reauth", "Graph respondeu 401.", { status: 401 }));
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toMatchObject({ status: "error", connectionStatus: "REAUTH_REQUIRED" });
    const conn = state.connections.get("c-mgr")!;
    expect(conn.status).toBe("REAUTH_REQUIRED");
    expect(conn.leaseOwner).toBeNull();
    expect(state.logs.at(-1)).toMatchObject({ status: "FAILED", error: "reauth:401" });
  });

  it("throttling é interrupção: sem lastError e cursor preservado", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    const link = state.connections.get("c-mgr")!.calendarDeltaLink;
    graph.failNext(new GraphError("throttled", "429", { status: 429 }));
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result.status).toBe("interrupted");
    const conn = state.connections.get("c-mgr")!;
    expect(conn.lastError).toBeNull();
    expect(conn.status).toBe("ACTIVE");
    expect(conn.calendarDeltaLink).toBe(link);
  });

  it("erro http genérico grava lastError (código) e mantém ACTIVE", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [] });
    graph.failNext(new GraphError("http", "500", { status: 500 }));
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toMatchObject({ status: "error", code: "http:500" });
    expect(state.connections.get("c-mgr")!.lastError).toBe("http:500");
    expect(state.connections.get("c-mgr")!.status).toBe("ACTIVE");
  });
});

describe("correções M1 — visão por caixa e remarcação", () => {
  it("remarcação atualiza occurredAt e título do rascunho DRAFT vazio", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    graph.upsertEvent(ev("e1", { subject: "1:1 Ana (nova data)", startIso: "2026-12-03T13:00:00", endIso: "2026-12-03T13:30:00" }));
    await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0].occurredAt.toISOString()).toBe("2026-12-03T13:00:00.000Z");
    expect(state.checkpoints[0].title).toBe("1:1 Ana (nova data)");
  });

  it("cancelado só na visão do participante não cancela enquanto o organizador mantém ativo", async () => {
    const { store, state } = setup();
    const mgr = createFakeGraphClient({ events: [ev("e1")] });
    const ana = createFakeGraphClient({ events: [ev("e1", { responseStatus: { response: "accepted" } })] });
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    await syncCalendarConnection("c-ana", deps(store, ana));
    ana.upsertEvent(ev("e1", { isCancelled: true }));
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-e1")!.isCancelled).toBe(false);
    expect(state.checkpoints[0].status).toBe("DRAFT");
    // Organizador cancela → evento cancelado e rascunho arquivado.
    mgr.upsertEvent(ev("e1", { isCancelled: true }));
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    expect(state.events.get("ical-e1")!.isCancelled).toBe(true);
    expect(state.checkpoints[0].status).toBe("ARCHIVED");
  });

  it("sem organizador conectado: cancelado quando nenhum sighting ativo resta", async () => {
    const { store, state } = setup();
    const ana = createFakeGraphClient({
      events: [ev("x1", { organizer: { emailAddress: { address: "cliente@acme.com" } }, responseStatus: { response: "accepted" } })],
    });
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-x1")!.isCancelled).toBe(false);
    ana.upsertEvent(ev("x1", { isCancelled: true, organizer: { emailAddress: { address: "cliente@acme.com" } } }));
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-x1")!.isCancelled).toBe(true);
  });

  it("categoria é da caixa: a do consultor não vale para o rascunho do gestor", async () => {
    const { store, state } = setup();
    const mgr = createFakeGraphClient({ events: [ev("e7", { subject: "Alinhamento" })] });
    const ana = createFakeGraphClient({ events: [ev("e7", { subject: "Alinhamento", categories: ["JumpFlow"] })] });
    await syncCalendarConnection("c-ana", deps(store, ana));
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    expect(state.checkpoints).toHaveLength(0);
    const sightings = [...state.sightings.entries()];
    expect(sightings.find(([k]) => k.startsWith("c-ana|"))![1].categories).toEqual(["JumpFlow"]);
    expect(sightings.find(([k]) => k.startsWith("c-mgr|"))![1].categories).toEqual([]);
  });
});

describe("correções M1 (validador) — corrida com desconectar/pausar e privado", () => {
  it("desconectar no meio da rodada: nada é gravado na conexão (tokens nulos, DISCONNECTED)", async () => {
    const { store, state } = setup();
    const inner = createFakeGraphClient({ events: [ev("e1")] });
    const conn = state.connections.get("c-mgr")!;
    const graph: FakeGraph = {
      ...inner,
      async calendarViewDelta(req) {
        const page = await inner.calendarViewDelta(req);
        // O usuário desconecta enquanto a rodada está no Graph.
        Object.assign(conn, {
          status: "DISCONNECTED",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          calendarDeltaLink: null,
          leaseOwner: null,
          leaseUntil: null,
        });
        return page;
      },
    };
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toEqual({ status: "skipped", reason: "connection_changed" });
    expect(conn.status).toBe("DISCONNECTED");
    expect(conn.accessTokenEncrypted).toBeNull();
    expect(conn.refreshTokenEncrypted).toBeNull();
    expect(conn.calendarDeltaLink).toBeNull();
    expect(conn.lastSyncAt).toBeNull();
  });

  it("pausar no meio da rodada encerra sem gravar cursor nem lastSyncAt", async () => {
    const { store, state } = setup();
    const inner = createFakeGraphClient({ events: [ev("e1")] });
    const conn = state.connections.get("c-mgr")!;
    const graph: FakeGraph = {
      ...inner,
      async calendarViewDelta(req) {
        const page = await inner.calendarViewDelta(req);
        conn.status = "PAUSED";
        return page;
      },
    };
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toEqual({ status: "skipped", reason: "connection_changed" });
    expect(conn.status).toBe("PAUSED");
    expect(conn.calendarDeltaLink).toBeNull();
    expect(conn.lastSyncAt).toBeNull();
  });

  it("organizador marca privado: com Checkpoint vinculado, assunto/participantes são limpos", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(state.checkpoints).toHaveLength(1);
    graph.upsertEvent(ev("e1", { sensitivity: "private" }));
    const r = await syncCalendarConnection("c-mgr", deps(store, graph));
    const stored = state.events.get("ical-e1")!;
    expect(stored.subject).toBeNull();
    expect(stored.attendees).toEqual([]);
    expect(stored.joinUrl).toBeNull();
    expect(state.checkpoints[0].status).toBe("DRAFT");
    expect(JSON.stringify(state.logs.at(-1))).toContain('"redacted":1');
    expect(r.status).toBe("ok");
  });

  it("participante vendo privado não apaga o evento do organizador", async () => {
    const { store, state } = setup();
    const mgr = createFakeGraphClient({ events: [ev("e1")] });
    const ana = createFakeGraphClient({ events: [ev("e1", { responseStatus: { response: "accepted" } })] });
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    await syncCalendarConnection("c-ana", deps(store, ana));
    ana.upsertEvent(ev("e1", { sensitivity: "private" }));
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-e1")!.subject).toBe("1:1 Ana");
  });
});
