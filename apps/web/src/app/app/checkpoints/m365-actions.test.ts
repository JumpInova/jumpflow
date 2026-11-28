import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("flag desligada → tudo inerte", () => {
  it("nenhuma action chama guard, banco ou Graph", async () => {
    h.state.gateOk = false;
    for (const r of [
      await searchCheckpointMinutes("chk1"),
      await listCheckpointMinutesCandidates("chk1"),
      await chooseCheckpointMinutesEmail({ checkpointId: "chk1", messageId: "m1" }),
      await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" }),
    ]) {
      expect(r).toMatchObject({ ok: false, error: "FORBIDDEN" });
    }
    expect(h.requirePermission).not.toHaveBeenCalled();
    expect(h.search).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});

describe("busca/escolha da ata: actor resolvido no servidor", () => {
  it("passa o User.id da sessão (nunca do cliente) e mapeia o resultado", async () => {
    const r = await searchCheckpointMinutes("chk1");
    expect(h.requirePermission).toHaveBeenCalledWith("CHECKPOINT", "edit");
    expect(h.search).toHaveBeenCalledWith("chk1", "u-mgr");
    expect(r).toMatchObject({ ok: true, data: { outcome: "saved" } });
  });

  it("não-gestor do checkpoint → FORBIDDEN com mensagem clara", async () => {
    h.search.mockResolvedValueOnce({ ok: false, code: "forbidden" } as never);
    const r = await searchCheckpointMinutes("chk1");
    expect(r).toMatchObject({ ok: false, error: "FORBIDDEN" });
  });

  it("entrada inválida é recusada antes de tudo", async () => {
    expect(await searchCheckpointMinutes("")).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    expect(await chooseCheckpointMinutesEmail({ checkpointId: "chk1", messageId: "" })).toMatchObject({
      ok: false,
      error: "INVALID_INPUT",
    });
    expect(h.search).not.toHaveBeenCalled();
    expect(h.choose).not.toHaveBeenCalled();
  });
});

describe("decideCheckpointActionItem", () => {
  it("autor do checkpoint aceita: update condicional + auditoria só com status", async () => {
    const r = await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" });
    expect(r).toEqual({ ok: true, data: { id: "ai1", status: "ACCEPTED" } });
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ai1", status: "PENDING" } }),
    );
    expect(h.state.audits).toEqual([
      expect.objectContaining({ action: "CHECKPOINT_ACTION_ITEM_DECIDED", before: { status: "PENDING" }, after: { status: "ACCEPTED" } }),
    ]);
  });

  it("checkpoint PRIVATE fora do escopo (ex.: consultor avaliado) → NOT_FOUND", async () => {
    h.state.user.roles = ["CONSULTANT"];
    h.state.dbUserId = "u-ana";
    h.state.inScope = false;
    const r = await decideCheckpointActionItem({ id: "ai1", status: "DONE" });
    expect(r).toMatchObject({ ok: false, error: "NOT_FOUND" });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("gestor no escopo mas que não é o autor (nem PEOPLE/ADMIN) → NOT_FOUND", async () => {
    h.state.dbUserId = "u-outro";
    const r = await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" });
    expect(r).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });

  it("PEOPLE gerencia qualquer checkpoint", async () => {
    h.state.user.roles = ["PEOPLE"];
    h.state.dbUserId = "u-people";
    expect(await decideCheckpointActionItem({ id: "ai1", status: "DISMISSED" })).toMatchObject({ ok: true });
  });

  it("transição inválida ou corrida → ALREADY_DECIDED", async () => {
    h.state.item!.status = "DONE";
    expect(await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" })).toMatchObject({ error: "ALREADY_DECIDED" });
    h.state.item!.status = "PENDING";
    h.state.updateCount = 0;
    expect(await decideCheckpointActionItem({ id: "ai1", status: "ACCEPTED" })).toMatchObject({ error: "ALREADY_DECIDED" });
  });

  it("ACCEPTED → DONE permitido; status fora do enum recusado", async () => {
    h.state.item!.status = "ACCEPTED";
    expect(await decideCheckpointActionItem({ id: "ai1", status: "DONE" })).toMatchObject({ ok: true });
    expect(await decideCheckpointActionItem({ id: "ai1", status: "PENDING" as never })).toMatchObject({ error: "INVALID_INPUT" });
  });
});
