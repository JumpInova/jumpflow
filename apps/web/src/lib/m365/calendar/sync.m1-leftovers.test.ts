import { describe, expect, it } from "vitest";
import { createFakeGraphClient, type FakeGraph } from "../graph/fake";
import type { GraphEvent } from "../graph/types";
import type { M365Store } from "../store";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { syncCalendarConnection } from "./sync";

/**
 * Menores remanescentes da validação da M1 (tratados no início da M2):
 * 1. escritas de evento/rascunho/sugestão só com o lease ainda desta rodada;
 * 2. participante não reescreve evento redigido pelo organizador;
 * 3. evento privado visto pela 1ª vez pelo organizador redige o registro
 *    criado pela caixa de um participante.
 */

const NOW = new Date("2026-11-26T15:00:00.000Z");

function ev(id: string, o: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id,
    iCalUId: "ical-1",
    subject: "1:1 Ana",
    start: { dateTime: "2026-11-27T13:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-27T13:30:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    sensitivity: "normal",
    type: "singleInstance",
    organizer: { emailAddress: { name: "Gestor", address: "gestor@jump.com.br" } },
    attendees: [{ type: "required", emailAddress: { name: "Ana", address: "ana@jump.com.br" }, status: { response: "accepted" } }],
    categories: [],
    responseStatus: { response: "organizer" },
    ...o,
  };
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
  state.targetable.set("u-mgr", new Set(["cons-ana"]));
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br" });
  addConnection(state, { id: "c-ana", userId: "u-ana", mailbox: "ana@jump.com.br" });
  return { store, state };
}

const deps = (store: M365Store, graph: FakeGraph, owner = "test") => ({
  store,
  owner,
  now: () => NOW,
  graphFor: () => graph,
  internalDomains: [],
});

describe("1. lease checado antes de cada fase de efeitos", () => {
  it("lease perdido antes da 1ª página: nenhum evento gravado", async () => {
    const { store, state } = setup();
    const lost: M365Store = { ...store, renewSyncLease: async () => false };
    const result = await syncCalendarConnection("c-mgr", deps(lost, createFakeGraphClient({ events: [ev("e1")] })));
    expect(result).toEqual({ status: "skipped", reason: "connection_changed" });
    expect(state.events.size).toBe(0);
    expect(state.checkpoints).toHaveLength(0);
  });

  it("lease perdido depois do delta: nenhum rascunho nem sugestão (e cursor não volta a ser gravado)", async () => {
    const { store, state } = setup();
    let calls = 0;
    // 1ª renovação (página) ok; a seguinte (antes dos efeitos) falha.
    const lost: M365Store = {
      ...store,
      renewSyncLease: async (id, owner, until) => (++calls <= 1 ? store.renewSyncLease(id, owner, until) : false),
    };
    const result = await syncCalendarConnection("c-mgr", deps(lost, createFakeGraphClient({ events: [ev("e1")] })));
    expect(result).toEqual({ status: "skipped", reason: "connection_changed" });
    expect(state.checkpoints).toHaveLength(0);
    expect(state.connections.get("c-mgr")!.lastSyncAt).toBeNull();
  });

  it("heartbeat estende o lease da própria rodada", async () => {
    const { store, state } = setup();
    const result = await syncCalendarConnection("c-mgr", deps(store, createFakeGraphClient({ events: [ev("e1")] })));
    expect(result.status).toBe("ok");
    expect(state.checkpoints).toHaveLength(1);
    expect(state.connections.get("c-mgr")!.leaseOwner).toBeNull();
  });

  it("outra instância com o lease: renovação falha (não é dono)", async () => {
    const { store, state } = setup();
    const conn = state.connections.get("c-mgr")!;
    conn.leaseOwner = "job:outro";
    expect(await store.renewSyncLease("c-mgr", "job:meu", new Date())).toBe(false);
    conn.status = "PAUSED";
    conn.leaseOwner = "job:meu";
    expect(await store.renewSyncLease("c-mgr", "job:meu", new Date())).toBe(false);
  });
});

describe("2. evento redigido: só a visão do organizador volta a gravar conteúdo", () => {
  it("participante com o assunto antigo não reescreve o evento redigido", async () => {
    const { store, state } = setup();
    const mgr = createFakeGraphClient({ events: [ev("m1")] });
    const ana = createFakeGraphClient({ events: [ev("a1", { responseStatus: { response: "accepted" } })] });
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    expect(state.checkpoints).toHaveLength(1);
    // Organizador marca como privado → redigido (há checkpoint vinculado).
    mgr.upsertEvent(ev("m1", { sensitivity: "private" }));
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    expect(state.events.get("ical-1")!.subject).toBeNull();
    // A caixa da participante ainda mostra o assunto: não pode restaurar.
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-1")!.subject).toBeNull();
    expect(state.events.get("ical-1")!.attendees).toEqual([]);
    // O organizador volta a deixar normal → conteúdo volta e deixa de ser redigido.
    mgr.upsertEvent(ev("m1", { subject: "1:1 Ana (novo)" }));
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    expect(state.events.get("ical-1")!.subject).toBe("1:1 Ana (novo)");
    expect(state.events.get("ical-1")!.redactedAt).toBeNull();
  });
});

describe("3. privado visto pela 1ª vez pelo organizador", () => {
  it("redige (apaga, sem checkpoint) o registro criado antes pela caixa da participante", async () => {
    const { store, state } = setup();
    const ana = createFakeGraphClient({ events: [ev("a1", { responseStatus: { response: "accepted" } })] });
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-1")!.subject).toBe("1:1 Ana");
    // Primeira sincronização do organizador já vê o evento como privado.
    const mgr = createFakeGraphClient({ events: [ev("m1", { sensitivity: "private" })] });
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    expect(state.events.has("ical-1")).toBe(false);
  });

  it("privado visto por um participante que NÃO é o organizador não redige", async () => {
    const { store, state } = setup();
    const mgr = createFakeGraphClient({ events: [ev("m1")] });
    await syncCalendarConnection("c-mgr", deps(store, mgr));
    const ana = createFakeGraphClient({ events: [ev("a1", { sensitivity: "private" })] });
    await syncCalendarConnection("c-ana", deps(store, ana));
    expect(state.events.get("ical-1")!.subject).toBe("1:1 Ana");
  });
});
