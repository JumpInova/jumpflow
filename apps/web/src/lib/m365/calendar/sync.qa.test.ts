import { describe, expect, it, vi } from "vitest";
import type { GraphClient } from "../graph/client";
import { createHttpGraphClient } from "../graph/client";
import { createFakeGraphClient, type FakeGraph } from "../graph/fake";
import { GraphError } from "../graph/errors";
import type { GraphEvent } from "../graph/types";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { calendarWindow, syncCalendarConnection } from "./sync";

/**
 * QA (Fase M1) — sync da agenda com store em memória e Graph fake:
 * delta/410, lease concorrente (job × "Sincronizar agora"), detecção de
 * checkpoint (escopo, contagem, sinais, tipo, idempotência, cancelamento),
 * privacidade (private/series master/corpo) e sugestões de horas.
 */

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
    attendees: [{ type: "required", emailAddress: { name: "Ana", address: "ana@jump.com.br" } }],
    categories: [],
    responseStatus: { response: "organizer" },
    ...rest,
  };
}

const att = (address: string, type = "required") => ({ type, emailAddress: { address } });

function setup() {
  const { store, state } = createMemoryStore();
  state.users.set("u-mgr", {
    user: { id: "u-mgr", name: "Gestor", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] },
    consultantId: "cons-gestor",
  });
  state.users.set("u-mgr2", {
    user: { id: "u-mgr2", name: "Gestora 2", email: "gestora2@jump.com.br", roles: ["PROJECT_MANAGER"] },
    consultantId: null,
  });
  state.users.set("u-ana", {
    user: { id: "u-ana", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] },
    consultantId: "cons-ana",
  });
  for (const [email, id] of [
    ["ana@jump.com.br", "cons-ana"],
    ["ana.alias@jump.com.br", "cons-ana"],
    ["bruno@jump.com.br", "cons-bruno"],
    ["carla@jump.com.br", "cons-carla"],
    ["gestor@jump.com.br", "cons-gestor"],
  ] as const) {
    state.consultantsByEmail.set(email, id);
  }
  state.targetable.set("u-mgr", new Set(["cons-ana", "cons-bruno", "cons-gestor"]));
  state.targetable.set("u-mgr2", new Set(["cons-ana"]));
  state.allocations.set("cons-ana", [
    { projectId: "p-acme", clientEmails: ["contato@acme.com", "financeiro@acme.com"] },
    { projectId: "p-acme2", clientEmails: ["outro@acme.com"] },
    { projectId: "p-beta", clientEmails: ["fin@beta.com"] },
    { projectId: "p-int", clientEmails: ["pmo@jump.com.br", "pessoal@gmail.com"] },
  ]);
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br" });
  addConnection(state, { id: "c-mgr2", userId: "u-mgr2", mailbox: "gestora2@jump.com.br" });
  addConnection(state, { id: "c-ana", userId: "u-ana", mailbox: "ana@jump.com.br" });
  return { store, state };
}

function deps(store: ReturnType<typeof setup>["store"], graph: GraphClient, now = NOW, owner = "test") {
  return { store, owner, now: () => now, graphFor: () => graph, internalDomains: [] as string[] };
}

describe("delta / 410", () => {
  it("410 via HTTP real (cursor expirado) → cursor descartado e janela −30/+60 a partir de agora", async () => {
    const { store, state } = setup();
    const conn = state.connections.get("c-mgr")!;
    conn.calendarDeltaLink = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=velho";
    conn.calendarWindowStart = new Date(NOW.getTime() - 30 * 86_400_000);
    conn.calendarWindowEnd = new Date(NOW.getTime() + 60 * 86_400_000);
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("deltatoken=velho")) {
        return new Response(JSON.stringify({ error: { code: "syncStateNotFound" } }), { status: 410 });
      }
      return new Response(
        JSON.stringify({ value: [ev("e1")], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=novo" }),
        { status: 200 },
      );
    });
    const graph = createHttpGraphClient({ tokens: { get: async () => "AT", refresh: async () => "AT" }, fetch });
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));

    expect(result).toMatchObject({ status: "ok", restarted: true, upserted: 1 });
    expect(urls).toHaveLength(2);
    const w = calendarWindow(NOW);
    const second = new URL(urls[1]);
    expect(second.pathname).toBe("/v1.0/me/calendarView/delta");
    expect(second.searchParams.get("startDateTime")).toBe(w.start.toISOString());
    expect(second.searchParams.get("endDateTime")).toBe(w.end.toISOString());
    expect(conn.calendarDeltaLink).toContain("deltatoken=novo");
    expect(state.checkpoints).toHaveLength(1);
  });

  it("410 também na rodada recomeçada → erro (sem loop), cursor fica vazio e a próxima rodada recomeça", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(store, graph));
    graph.expireDeltaLinks();
    graph.failNext(new GraphError("resync", "410", { status: 410 })); // no link antigo
    graph.failNext(new GraphError("resync", "410", { status: 410 })); // no recomeço
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toMatchObject({ status: "error" });
    expect(state.connections.get("c-mgr")!.calendarDeltaLink).toBeNull();
    expect(state.connections.get("c-mgr")!.status).toBe("ACTIVE");
    const next = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(next).toMatchObject({ status: "ok", restarted: true });
  });

  it("interrupção no meio da paginação não grava cursor parcial", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient({ pageSize: 1, events: [ev("e1"), ev("e2", { subject: "1:1 Bruno", attendees: [att("bruno@jump.com.br")] })] });
    const original = graph.calendarViewDelta.bind(graph);
    let n = 0;
    graph.calendarViewDelta = async (req) => {
      n += 1;
      if (n === 2) throw new GraphError("throttled", "429", { status: 429 });
      return original(req);
    };
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result.status).toBe("interrupted");
    expect(state.connections.get("c-mgr")!.calendarDeltaLink).toBeNull();
    // Na rodada seguinte, tudo é reprocessado sem duplicar.
    const again = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(again.status).toBe("ok");
    expect(state.checkpoints.map((c) => c.consultantId).sort()).toEqual(["cons-ana", "cons-bruno"]);
  });

  it("delta sem nextLink nem deltaLink → erro com código, sem gravar cursor", async () => {
    const { store, state } = setup();
    const graph: GraphClient = {
      getMe: async () => ({ id: "x", mail: null, userPrincipalName: null }),
      calendarViewDelta: async () => ({ value: [], nextLink: null, deltaLink: null }),
    };
    const result = await syncCalendarConnection("c-mgr", deps(store, graph));
    expect(result).toMatchObject({ status: "error", code: "http:missing_delta_link" });
    expect(state.connections.get("c-mgr")!.calendarDeltaLink).toBeNull();
  });

  it("graphFor lançando erro de configuração → conexão ERROR e lease liberado", async () => {
    const { store, state } = setup();
    const result = await syncCalendarConnection("c-mgr", {
      ...deps(store, createFakeGraphClient()),
      graphFor: () => {
        throw new GraphError("config", "Credenciais ausentes.", { code: "missing_credentials" });
      },
    });
    expect(result).toMatchObject({ status: "error", connectionStatus: "ERROR" });
    expect(state.connections.get("c-mgr")!.status).toBe("ERROR");
    expect(state.connections.get("c-mgr")!.leaseOwner).toBeNull();
  });
});

describe("lease concorrente (job × 'Sincronizar agora')", () => {
  it("duas rodadas simultâneas na mesma conexão: só uma toca o Graph, a outra devolve busy", async () => {
    const { store, state } = setup();
    const inner = createFakeGraphClient({ events: [ev("e1")] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let deltaCalls = 0;
    const slow: GraphClient = {
      getMe: () => inner.getMe(),
      calendarViewDelta: async (req) => {
        deltaCalls += 1;
        await gate;
        return inner.calendarViewDelta(req);
      },
    };
    const job = syncCalendarConnection("c-mgr", deps(store, slow, NOW, "job:1"));
    // deixa o job pegar o lease
    await new Promise((r) => setTimeout(r, 0));
    expect(state.connections.get("c-mgr")!.leaseOwner).toBe("job:1");
    const user = await syncCalendarConnection("c-mgr", deps(store, slow, NOW, "user:1"));
    expect(user).toEqual({ status: "busy" });
    release();
    expect((await job).status).toBe("ok");
    expect(deltaCalls).toBe(1);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.connections.get("c-mgr")!.leaseOwner).toBeNull();
    // Depois de liberado, o "Sincronizar agora" roda normalmente.
    expect((await syncCalendarConnection("c-mgr", deps(store, slow, NOW, "user:2"))).status).toBe("ok");
  });

  it("lease ainda dentro do prazo (vence exatamente agora) continua ocupado", async () => {
    const { store, state } = setup();
    const conn = state.connections.get("c-mgr")!;
    conn.leaseOwner = "job:outro";
    conn.leaseUntil = new Date(NOW.getTime());
    expect(await syncCalendarConnection("c-mgr", deps(store, createFakeGraphClient(), NOW, "user:1"))).toEqual({ status: "busy" });
  });

  it("rodada que falha libera só o próprio lease (não o de outra instância)", async () => {
    const { store, state } = setup();
    const graph = createFakeGraphClient();
    graph.failNext(new GraphError("http", "500", { status: 500 }));
    await syncCalendarConnection("c-mgr", deps(store, graph, NOW, "job:1"));
    expect(state.connections.get("c-mgr")!.leaseOwner).toBeNull();
    await store.claimSyncLease("c-mgr", "job:2", new Date(NOW.getTime() + 60_000), NOW);
    await store.releaseSyncLease("c-mgr", "job:1");
    expect(state.connections.get("c-mgr")!.leaseOwner).toBe("job:2");
  });

  it.each(["PAUSED", "REAUTH_REQUIRED", "ERROR", "DISCONNECTED"] as const)("conexão %s não sincroniza nem pega lease", async (status) => {
    const { store, state } = setup();
    state.connections.get("c-mgr")!.status = status;
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    expect(await syncCalendarConnection("c-mgr", deps(store, graph))).toEqual({ status: "skipped", reason: "not_active" });
    expect(graph.calls.delta).toEqual([]);
    expect(state.connections.get("c-mgr")!.leaseOwner).toBeNull();
  });
});

describe("detecção de checkpoint no sync", () => {
  async function run(events: GraphEvent[], connection = "c-mgr") {
    const s = setup();
    const graph = createFakeGraphClient({ events });
    const result = await syncCalendarConnection(connection, deps(s.store, graph));
    return { ...s, graph, result };
  }

  it("consultor fora do escopo do gestor não gera rascunho (mesmo com 1:1 no assunto)", async () => {
    const { state } = await run([ev("e1", { subject: "1:1 Carla", attendees: [att("carla@jump.com.br")] })]);
    expect(state.checkpoints).toHaveLength(0);
  });

  it("gestor que também é consultor não conta como 'o consultor' do 1:1", async () => {
    const { state } = await run([ev("e1", { attendees: [att("gestor@jump.com.br"), att("ana@jump.com.br")] })]);
    expect(state.checkpoints.map((c) => c.consultantId)).toEqual(["cons-ana"]);
  });

  it("mesmo consultor com dois e-mails (alias) conta como um só", async () => {
    const { state } = await run([ev("e1", { attendees: [att("ana@jump.com.br"), att("ana.alias@jump.com.br")] })]);
    expect(state.checkpoints.map((c) => c.consultantId)).toEqual(["cons-ana"]);
  });

  it("dois consultores no escopo → nenhum rascunho; consultor + externo não-consultor → rascunho", async () => {
    const { state } = await run([
      ev("e1", { attendees: [att("ana@jump.com.br"), att("bruno@jump.com.br", "optional")] }),
      ev("e2", { subject: "Checkpoint Bruno", attendees: [att("bruno@jump.com.br"), att("cliente@acme.com")] }),
    ]);
    expect(state.checkpoints.map((c) => [c.consultantId, c.type])).toEqual([["cons-bruno", "CHECKPOINT"]]);
  });

  it("consultor + um fora do escopo = dois consultores → nenhum rascunho", async () => {
    const { state } = await run([ev("e1", { attendees: [att("ana@jump.com.br"), att("carla@jump.com.br")] })]);
    expect(state.checkpoints).toHaveLength(0);
  });

  it("sala (resource) com e-mail de consultor não conta", async () => {
    const { state } = await run([ev("e1", { attendees: [att("ana@jump.com.br"), att("bruno@jump.com.br", "resource")] })]);
    expect(state.checkpoints.map((c) => c.consultantId)).toEqual(["cons-ana"]);
  });

  it.each([
    ["1:1 com Ana", [], "ONE_ON_ONE"],
    ["ONE ON ONE", [], "ONE_ON_ONE"],
    ["Ana | 1-On-1", [], "ONE_ON_ONE"],
    ["CHECK-IN mensal", [], "CHECKPOINT"],
    ["checkpoint", [], "CHECKPOINT"],
    ["Conversa", ["JumpFlow"], "CHECKPOINT"],
    ["Conversa", ["  JUMPFLOW "], "CHECKPOINT"],
    ["1on1", ["JumpFlow"], "ONE_ON_ONE"],
  ])("assunto %j + categorias %j → %s", async (subject, categories, type) => {
    const { state } = await run([ev("e1", { subject, categories })]);
    expect(state.checkpoints.map((c) => c.type)).toEqual([type]);
  });

  it.each([["Check in"], ["Alinhamento"], ["Reunião 1 a 1"], [""]])("assunto %j sem categoria → sem rascunho", async (subject) => {
    const { state } = await run([ev("e1", { subject })]);
    expect(state.checkpoints).toHaveLength(0);
  });

  it("categoria parecida (JumpFlow2, Jump Flow) não vale", async () => {
    const { state } = await run([
      ev("e1", { subject: "Conversa", categories: ["JumpFlow2"] }),
      ev("e2", { subject: "Conversa", categories: ["Jump Flow"] }),
    ]);
    expect(state.checkpoints).toHaveLength(0);
  });

  it("1:1 organizado PELO CONSULTOR com o gestor como convidado: nenhuma das duas contas cria rascunho", async () => {
    const s = setup();
    const event = ev("e1", { organizer: { emailAddress: { address: "ana@jump.com.br" } }, attendees: [att("gestor@jump.com.br")] });
    const graphMgr = createFakeGraphClient({ events: [event] });
    const graphAna = createFakeGraphClient({ events: [event] });
    await syncCalendarConnection("c-mgr", deps(s.store, graphMgr));
    await syncCalendarConnection("c-ana", deps(s.store, graphAna));
    expect(s.state.checkpoints).toHaveLength(0);
  });

  it("agenda do consultor nunca gera rascunho, mesmo vendo o 1:1 do gestor (sem papel de escrita)", async () => {
    const { state } = await run([ev("e1")], "c-ana");
    expect(state.checkpoints).toHaveLength(0);
    expect(state.events.size).toBe(1);
  });

  it("gestor convidado (não organizador) no 1:1 de outro gestor não cria rascunho", async () => {
    const { state } = await run(
      [ev("e1", { organizer: { emailAddress: { address: "gestora2@jump.com.br" } }, attendees: [att("gestor@jump.com.br"), att("ana@jump.com.br")] })],
      "c-mgr",
    );
    expect(state.checkpoints).toHaveLength(0);
  });

  it("idempotência: o mesmo evento visto pelo gestor e depois re-sincronizado após 410 continua com UM rascunho", async () => {
    const s = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    graph.upsertEvent(ev("e1", { subject: "1:1 Ana — pauta" }));
    graph.expireDeltaLinks();
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    expect(s.state.checkpoints).toHaveLength(1);
    expect(s.state.checkpoints[0]).toMatchObject({ status: "DRAFT", visibility: "PRIVATE", managerUserId: "u-mgr", consultantId: "cons-ana" });
  });

  it("rascunho registra gestor, consultor, occurredAt = início e título = assunto", async () => {
    const { state } = await run([ev("e1", { subject: "Checkpoint de projeto", startIso: "2026-11-28T17:00:00", endIso: "2026-11-28T18:00:00" })]);
    expect(state.checkpoints[0]).toMatchObject({
      managerUserId: "u-mgr",
      consultantId: "cons-ana",
      type: "CHECKPOINT",
      title: "Checkpoint de projeto",
      status: "DRAFT",
      visibility: "PRIVATE",
    });
    expect(state.checkpoints[0].occurredAt.toISOString()).toBe("2026-11-28T17:00:00.000Z");
  });
});

describe("cancelamento → ARCHIVED só para DRAFT sem conteúdo", () => {
  async function withDraft(mutate: (c: ReturnType<typeof setup>["state"]["checkpoints"][number]) => void) {
    const s = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    mutate(s.state.checkpoints[0]);
    graph.upsertEvent(ev("e1", { isCancelled: true }));
    const result = await syncCalendarConnection("c-mgr", deps(s.store, graph));
    return { ...s, result };
  }

  it("DRAFT vazio → ARCHIVED", async () => {
    const { state, result } = await withDraft(() => {});
    expect(state.checkpoints[0].status).toBe("ARCHIVED");
    expect(result.status === "ok" && result.draftsArchived).toBe(1);
  });

  it.each([
    ["transcrição", (c: { transcription: string | null }) => (c.transcription = "texto")],
    ["áudio", (c: { audioStorageKey: string | null }) => (c.audioStorageKey = "k")],
    ["notas", (c: { notes: string | null }) => (c.notes = "notas")],
  ])("DRAFT com %s é preservado", async (_l, mutate) => {
    const { state } = await withDraft(mutate as (c: unknown) => void);
    expect(state.checkpoints[0].status).toBe("DRAFT");
  });

  it("checkpoint já RECORDED não é arquivado", async () => {
    const { state } = await withDraft((c) => (c.status = "RECORDED"));
    expect(state.checkpoints[0].status).toBe("RECORDED");
  });

  it("consultor apagando o convite da PRÓPRIA agenda não cancela o evento nem arquiva o rascunho do gestor", async () => {
    const s = setup();
    const mgrGraph = createFakeGraphClient({ events: [ev("e1")] });
    const anaGraph = createFakeGraphClient({ events: [ev("e1", { id: "e1", responseStatus: { response: "accepted" } })] });
    await syncCalendarConnection("c-mgr", deps(s.store, mgrGraph));
    await syncCalendarConnection("c-ana", deps(s.store, anaGraph));
    anaGraph.removeEvent("e1");
    const r = await syncCalendarConnection("c-ana", deps(s.store, anaGraph));
    expect(r).toMatchObject({ status: "ok", removed: 1, draftsArchived: 0 });
    expect(s.state.events.get("ical-e1")!.isCancelled).toBe(false);
    expect(s.state.checkpoints[0].status).toBe("DRAFT");
  });

  it("cancelado não recria rascunho em rodada seguinte", async () => {
    const s = setup();
    const graph = createFakeGraphClient({ events: [ev("e1", { isCancelled: true })] });
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    expect(s.state.checkpoints).toHaveLength(0);
  });
});

describe("privacidade da agenda", () => {
  it.each(["private", "Private", "confidential", "personal"])(
    "evento %s nunca é armazenado nem vira rascunho, mesmo com categoria JumpFlow",
    async (sensitivity) => {
      const s = setup();
      const graph = createFakeGraphClient({ events: [ev("e1", { sensitivity, categories: ["JumpFlow"] })] });
      const r = await syncCalendarConnection("c-mgr", deps(s.store, graph));
      expect(r).toMatchObject({ status: "ok", upserted: 0, skipped: 1 });
      expect(s.state.events.size).toBe(0);
      expect(s.state.checkpoints).toHaveLength(0);
    },
  );

  it("series master é descartada, mas a ocorrência é processada", async () => {
    const s = setup();
    const graph = createFakeGraphClient({
      events: [ev("master", { type: "seriesMaster" }), ev("occ", { type: "occurrence" })],
    });
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    expect([...s.state.events.keys()]).toEqual(["ical-occ"]);
    expect(s.state.checkpoints).toHaveLength(1);
  });

  it("evento que vira privado depois: sighting removido e sem sugestão de horas", async () => {
    const s = setup();
    const past = ev("p1", {
      subject: "Reunião cliente",
      startIso: "2026-11-25T13:00:00",
      endIso: "2026-11-25T14:00:00",
      organizer: { emailAddress: { address: "ana@jump.com.br" } },
      attendees: [att("contato@acme.com")],
      responseStatus: { response: "accepted" },
    });
    const graph = createFakeGraphClient({ events: [past] });
    await syncCalendarConnection("c-ana", deps(s.store, graph));
    expect(s.state.suggestions.size).toBe(1);
    graph.upsertEvent({ ...past, sensitivity: "private" });
    await syncCalendarConnection("c-ana", deps(s.store, graph));
    // Correção M1: visão do ORGANIZADOR (Ana) marcou privado e não há Checkpoint
    // vinculado → evento, sightings e sugestões apagados.
    expect(s.state.events.has("ical-p1")).toBe(false);
    expect(s.state.sightings.size).toBe(0);
    // Nova rodada: o evento não aparece mais como fonte de sugestão.
    s.state.suggestions.clear();
    await syncCalendarConnection("c-ana", deps(s.store, graph));
    expect(s.state.suggestions.size).toBe(0);
  });

  it("corpo/bodyPreview/anexos do convite nunca chegam ao store", async () => {
    const s = setup();
    const withBody = {
      ...ev("e1"),
      body: { contentType: "html", content: "<p>CORPO-SIGILOSO</p>" },
      bodyPreview: "CORPO-SIGILOSO",
      attachments: [{ name: "CORPO-SIGILOSO.pdf" }],
      location: { displayName: "CORPO-SIGILOSO" },
    } as GraphEvent;
    const upsert = vi.spyOn(s.store, "upsertCalendarEvent");
    await syncCalendarConnection("c-mgr", deps(s.store, createFakeGraphClient({ events: [withBody] })));
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("CORPO-SIGILOSO");
    expect(Object.keys(upsert.mock.calls[0][1])).not.toEqual(expect.arrayContaining(["body"]));
    expect(JSON.stringify(s.state.logs)).not.toContain("CORPO-SIGILOSO");
  });

  it("IntegrationEvent do sync só tem contadores (sem e-mail, assunto, ids do Graph)", async () => {
    const s = setup();
    await syncCalendarConnection("c-mgr", deps(s.store, createFakeGraphClient({ events: [ev("e1", { subject: "1:1 Assunto Sensível" })] })));
    const log = s.state.logs.at(-1)!;
    expect(log).toMatchObject({ operation: "calendar.sync", status: "SUCCESS", entityType: "M365Connection", entityId: "c-mgr" });
    for (const v of Object.values(log.meta ?? {})) expect(["number", "boolean"]).toContain(typeof v);
    expect(JSON.stringify(s.state.logs)).not.toMatch(/@|Sensível|ical-e1/);
  });
});

describe("sugestões de horas no sync", () => {
  const past = (id: string, attendees: ReturnType<typeof att>[], o: Parameters<typeof ev>[1] = {}) =>
    ev(id, {
      subject: `Reunião ${id}`,
      startIso: "2026-11-25T13:00:00",
      endIso: "2026-11-25T14:00:00",
      organizer: { emailAddress: { address: "ana@jump.com.br" } },
      attendees,
      responseStatus: { response: "accepted" },
      ...o,
    });

  async function run(events: GraphEvent[], internal: string[] = [], connection = "c-ana") {
    const s = setup();
    const graph: FakeGraph = createFakeGraphClient({ events });
    const r = await syncCalendarConnection(connection, { ...deps(s.store, graph), internalDomains: internal });
    const byIcal = (ical: string) =>
      [...s.state.suggestions.values()].find((x) => x.calendarEventId === s.state.events.get(ical)?.id);
    return { ...s, r, byIcal };
  }

  it("e-mail exato vence domínio: contato@acme.com → só p-acme (não p-acme2)", async () => {
    const { byIcal } = await run([past("s1", [att("contato@acme.com")])]);
    expect(byIcal("ical-s1")).toMatchObject({ projectIds: ["p-acme"], matchKind: "EMAIL" });
  });

  it("domínio ambíguo (dois projetos do mesmo cliente) → os dois para o consultor escolher", async () => {
    const { byIcal } = await run([past("s1", [att("diretor@acme.com")])]);
    expect(byIcal("ical-s1")).toMatchObject({ projectIds: ["p-acme", "p-acme2"], matchKind: "DOMAIN" });
  });

  it("e-mail exato em dois projetos → os dois (EMAIL)", async () => {
    const { byIcal } = await run([past("s1", [att("contato@acme.com"), att("fin@beta.com")])]);
    expect(byIcal("ical-s1")).toMatchObject({ projectIds: ["p-acme", "p-beta"], matchKind: "EMAIL" });
  });

  it("contato de cliente com domínio interno ou público nunca vira vínculo", async () => {
    const { state } = await run([
      past("s1", [att("pmo@jump.com.br")]),
      past("s2", [att("pessoal@gmail.com")]),
      past("s3", [att("outra@gmail.com")]),
    ]);
    expect(state.suggestions.size).toBe(0);
  });

  it("domínio interno extra (M365_INTERNAL_DOMAINS) não conta", async () => {
    const { state } = await run([past("s1", [att("contato@acme.com")])], ["acme.com"]);
    expect(state.suggestions.size).toBe(0);
  });

  it("organizador externo (cliente) conta como participante", async () => {
    const { byIcal } = await run([
      past("s1", [att("ana@jump.com.br")], { organizer: { emailAddress: { address: "fin@beta.com" } } }),
    ]);
    expect(byIcal("ical-s1")).toMatchObject({ projectIds: ["p-beta"], matchKind: "EMAIL" });
  });

  it("evento sem resposta (none/tentativelyAccepted) sugere; recusado não", async () => {
    const { byIcal } = await run([
      past("s1", [att("contato@acme.com")], { responseStatus: { response: "tentativelyAccepted" } }),
      past("s2", [att("contato@acme.com")], { responseStatus: { response: "Declined" } }),
    ]);
    expect(byIcal("ical-s1")).toBeDefined();
    expect(byIcal("ical-s2")).toBeUndefined();
  });

  it("data da sugestão é a data local de São Paulo (evento às 01:30Z cai no dia anterior)", async () => {
    const { byIcal } = await run([
      past("s1", [att("contato@acme.com")], { startIso: "2026-11-25T01:30:00", endIso: "2026-11-25T02:30:00" }),
    ]);
    expect(byIcal("ical-s1")!.date.toISOString()).toBe("2026-11-24T00:00:00.000Z");
  });

  it("gestor sem vínculo de consultor não recebe sugestões; consultor nunca ganha TimeEntry (store não tem essa operação)", async () => {
    const s = setup();
    const graph = createFakeGraphClient({ events: [past("s1", [att("contato@acme.com")], { organizer: { emailAddress: { address: "gestora2@jump.com.br" } } })] });
    const r = await syncCalendarConnection("c-mgr2", deps(s.store, graph));
    expect(r).toMatchObject({ status: "ok", suggestions: 0 });
    expect(Object.keys(s.store).some((k) => /timeentry/i.test(k))).toBe(false);
  });

  it("sugestão PENDING é atualizada quando o evento muda de duração; DISMISSED não", async () => {
    const s = setup();
    const graph = createFakeGraphClient({ events: [past("s1", [att("contato@acme.com")])] });
    await syncCalendarConnection("c-ana", deps(s.store, graph));
    graph.upsertEvent(past("s1", [att("contato@acme.com")], { endIso: "2026-11-25T14:30:00" }));
    const r = await syncCalendarConnection("c-ana", deps(s.store, graph));
    expect(r).toMatchObject({ suggestions: 1 });
    const sug = [...s.state.suggestions.values()][0];
    expect(sug.minutes).toBe(90);
    sug.status = "DISMISSED";
    graph.upsertEvent(past("s1", [att("contato@acme.com")], { endIso: "2026-11-25T15:00:00" }));
    await syncCalendarConnection("c-ana", deps(s.store, graph));
    expect([...s.state.suggestions.values()][0]).toMatchObject({ status: "DISMISSED", minutes: 90 });
  });
});

describe("achados corrigidos na M1 (antes it.fails)", () => {
  // ACHADO (importante): o rascunho guarda occurredAt/título da PRIMEIRA vez que
  // o evento foi visto. Se o gestor remarca o 1:1, ensureCheckpointDraft devolve
  // "exists" e o rascunho DRAFT fica com a data antiga (spec: occurredAt = início
  // do evento). Afeta a M2, que procura atas a partir do início do evento.
  it("CORRIGIDO: remarcar o evento atualiza occurredAt do rascunho ainda DRAFT", async () => {
    const s = setup();
    const graph = createFakeGraphClient({ events: [ev("e1")] });
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    graph.upsertEvent(ev("e1", { startIso: "2026-12-03T13:00:00", endIso: "2026-12-03T13:30:00" }));
    await syncCalendarConnection("c-mgr", deps(s.store, graph));
    expect(s.state.checkpoints[0].occurredAt.toISOString()).toBe("2026-12-03T13:00:00.000Z");
  });

  // ACHADO (menor): a conexão (e os tokens) é lida ANTES do claim do lease. Se
  // outra rodada rotacionar o refresh token entre a leitura e o claim, esta
  // rodada renova com o refresh token antigo (risco de invalid_grant falso →
  // REAUTH_REQUIRED). Esperado: reler a conexão depois de obter o lease.
  it("CORRIGIDO: depois do claim, a rodada usa os tokens atuais (não os lidos antes do lease)", async () => {
    const s = setup();
    const conn = s.state.connections.get("c-mgr")!;
    conn.calendarDeltaLink = null;
    conn.refreshTokenEncrypted = "RT-OLD";
    const originalClaim = s.store.claimSyncLease.bind(s.store);
    s.store.claimSyncLease = async (...args) => {
      // Outra instância terminou uma rodada e rotacionou o refresh token.
      conn.refreshTokenEncrypted = "RT-NEW";
      return originalClaim(...args);
    };
    let seen: string | null = null;
    await syncCalendarConnection("c-mgr", {
      ...deps(s.store, createFakeGraphClient()),
      graphFor: (c) => {
        seen = c.refreshTokenEncrypted;
        return createFakeGraphClient();
      },
    });
    expect(seen).toBe("RT-NEW");
  });
});
