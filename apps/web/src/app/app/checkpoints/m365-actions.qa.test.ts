import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA M2 — cards de Ação e actions da tela do Checkpoint (complementa
 * `m365-actions.test.ts`; mesmos mocks de guard/Prisma/runtime).
 */

const h = vi.hoisted(() => {
  const state = {
    gateOk: true,
    user: { id: "sess", email: "gestor@jump.com.br", name: "G", roles: ["PROJECT_MANAGER"] as string[] },
    dbUserId: "u-mgr" as string | null,
    inScope: true,
    item: { id: "ai1", status: "PENDING", checkpointId: "chk1", checkpoint: { managerUserId: "u-mgr" } } as
      | { id: string; status: string; checkpointId: string; checkpoint: { managerUserId: string | null } }
      | null,
    updateCount: 1,
    audits: [] as unknown[],
  };
  return {
    state,
    requirePermission: vi.fn(async () => state.user),
    updateMany: vi.fn(async () => ({ count: state.updateCount })),
    search: vi.fn(async () => ({ ok: true, value: "saved" })),
    choose: vi.fn(async () => ({ ok: true, value: "saved" })),
    list: vi.fn(async () => ({ ok: true, value: [] })),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requirePermission: h.requirePermission }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => (h.state.dbUserId ? { id: h.state.dbUserId } : null)) }));
vi.mock("@/lib/db/checkpoint", () => ({ canViewCheckpointInScope: vi.fn(async () => h.state.inScope) }));
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: vi.fn(async (e: unknown) => h.state.audits.push(e)) }));
vi.mock("@jumpflow/database", () => ({
  prisma: {
    checkpointActionItem: {
      findUnique: vi.fn(async () => h.state.item),
      updateMany: h.updateMany,
    },
  },
}));
vi.mock("@/lib/m365/runtime", () => ({
  m365RuntimeGate: () => (h.state.gateOk ? { ok: true } : { ok: false, reason: "disabled" }),
  searchCheckpointMinutesNow: h.search,
  chooseCheckpointMinutesMessage: h.choose,
  listCheckpointMinutesChoices: h.list,
}));

import { canTransitionActionItem, type ActionItemStatus } from "@/lib/checkpoint/action-items";
import {
  chooseCheckpointMinutesEmail,
  decideCheckpointActionItem,
  listCheckpointMinutesCandidates,
  searchCheckpointMinutes,
} from "./m365-actions";

beforeEach(() => {
  h.state.gateOk = true;
  h.state.user.roles = ["PROJECT_MANAGER"];
  h.state.dbUserId = "u-mgr";
  h.state.inScope = true;
  h.state.item = { id: "ai1", status: "PENDING", checkpointId: "chk1", checkpoint: { managerUserId: "u-mgr" } };
  h.state.updateCount = 1;
  h.state.audits = [];
});
afterEach(() => vi.clearAllMocks());

describe("cards de Ação — máquina de estados", () => {
  const ALL: ActionItemStatus[] = ["PENDING", "ACCEPTED", "DONE", "DISMISSED"];
  const allowed = new Set(["PENDING>ACCEPTED", "PENDING>DONE", "PENDING>DISMISSED", "ACCEPTED>DONE", "ACCEPTED>DISMISSED"]);

  it("matriz completa: só PENDING→ACCEPTED|DONE|DISMISSED e ACCEPTED→DONE|DISMISSED", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransitionActionItem(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it.each(["DONE", "DISMISSED"])("estado final %s não volta (nem para DONE/DISMISSED de novo)", async (final) => {
    h.state.item!.status = final;
    for (const to of ["ACCEPTED", "DONE", "DISMISSED"] as const) {
      expect(await decideCheckpointActionItem({ id: "ai1", status: to })).toMatchObject({ error: "ALREADY_DECIDED" });
    }
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.state.audits).toHaveLength(0);
  });
});

describe("cards de Ação — visibilidade e autorização", () => {
  it("consultor avaliado em checkpoint SHARED (no escopo de leitura) também não decide: NOT_FOUND sem update/auditoria", async () => {
    h.state.user.roles = ["CONSULTANT"];
    h.state.dbUserId = "u-ana";
    h.state.inScope = true;
    expect(await decideCheckpointActionItem({ id: "ai1", status: "DONE" })).toMatchObject({ ok: false, error: "NOT_FOUND" });
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.state.audits).toHaveLength(0);
  });

  it("item inexistente e item fora do escopo respondem IGUAL (anti-enumeração)", async () => {
    h.state.item = null;
    const missing = await decideCheckpointActionItem({ id: "nao-existe", status: "DONE" });
    h.state.item = { id: "ai1", status: "PENDING", checkpointId: "chk1", checkpoint: { managerUserId: "u-mgr" } };
    h.state.inScope = false;
    const hidden = await decideCheckpointActionItem({ id: "ai1", status: "DONE" });
    expect(hidden).toEqual(missing);
  });

  it("gestor sem User vinculado (resolveDbUser nulo) não decide card de checkpoint alheio", async () => {
    h.state.dbUserId = null;
    expect(await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" })).toMatchObject({ error: "NOT_FOUND" });
  });

  it("auditoria leva só status e quem decidiu — nunca título, responsável ou trecho da ata", async () => {
    await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" });
    expect(h.state.audits).toHaveLength(1);
    const audit = h.state.audits[0] as Record<string, unknown>;
    expect(audit).toMatchObject({ actorUserId: "u-mgr", entityType: "CheckpointActionItem", entityId: "ai1" });
    expect(Object.keys(audit.before as object)).toEqual(["status"]);
    expect(Object.keys(audit.after as object)).toEqual(["status"]);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: "ai1", status: "PENDING" },
      data: expect.objectContaining({ status: "ACCEPTED", decidedByUserId: "u-mgr" }),
    });
  });
});

describe("busca/escolha — entrada do cliente nunca define o ator", () => {
  it("actorUserId enviado pelo cliente é ignorado; usa o User da sessão", async () => {
    await chooseCheckpointMinutesEmail({ checkpointId: "chk1", messageId: "m1", actorUserId: "u-admin" } as never);
    expect(h.choose).toHaveBeenCalledWith("chk1", "m1", "u-mgr");
  });

  it("messageId acima de 512 caracteres ou vazio → INVALID_INPUT sem chegar ao runtime", async () => {
    for (const messageId of ["x".repeat(513), "   "]) {
      expect(await chooseCheckpointMinutesEmail({ checkpointId: "chk1", messageId })).toMatchObject({ error: "INVALID_INPUT" });
    }
    expect(h.choose).not.toHaveBeenCalled();
  });

  it("sessão sem User vinculado → FORBIDDEN sem ler caixa alguma", async () => {
    h.state.dbUserId = null;
    expect(await searchCheckpointMinutes("chk1")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await listCheckpointMinutesCandidates("chk1")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(h.search).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("flag desligada: decidir card também fica inerte (sem guard nem banco)", async () => {
    h.state.gateOk = false;
    expect(await decideCheckpointActionItem({ id: "ai1", status: "DONE" })).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(h.requirePermission).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});
