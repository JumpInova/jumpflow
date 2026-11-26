import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** M3 — action "Buscar/Complementar com a transcrição do Teams". */

const h = vi.hoisted(() => {
  const state = {
    gateOk: true,
    user: { id: "sess", email: "gestor@jump.com.br", name: "G", roles: ["PROJECT_MANAGER"] as string[] },
    dbUserId: "u-mgr" as string | null,
  };
  return {
    state,
    requirePermission: vi.fn(async () => state.user),
    fetchNow: vi.fn<(checkpointId: string, actor: string) => Promise<unknown>>(async () => ({ ok: true, value: "saved" })),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requirePermission: h.requirePermission }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => (h.state.dbUserId ? { id: h.state.dbUserId } : null)) }));
vi.mock("@/lib/m365/runtime", () => ({
  m365RuntimeGate: () => (h.state.gateOk ? { ok: true } : { ok: false, reason: "disabled" }),
  fetchCheckpointTranscriptNow: h.fetchNow,
}));

import { fetchCheckpointTeamsTranscript } from "./m365-actions";

beforeEach(() => {
  h.state.gateOk = true;
  h.state.dbUserId = "u-mgr";
});
afterEach(() => vi.clearAllMocks());

describe("fetchCheckpointTeamsTranscript", () => {
  it("flag desligada → inerte (sem guard nem Graph)", async () => {
    h.state.gateOk = false;
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(h.requirePermission).not.toHaveBeenCalled();
    expect(h.fetchNow).not.toHaveBeenCalled();
  });

  it("actor vem da sessão (CHECKPOINT.edit), nunca do cliente; mensagem PT-BR do resultado", async () => {
    const r = await fetchCheckpointTeamsTranscript("chk1");
    expect(h.requirePermission).toHaveBeenCalledWith("CHECKPOINT", "edit");
    expect(h.fetchNow).toHaveBeenCalledWith("chk1", "u-mgr");
    expect(r).toMatchObject({ ok: true, data: { outcome: "saved", message: expect.stringContaining("transcrição do Teams") } });
  });

  it("entrada inválida e usuário sem vínculo são recusados antes do Graph", async () => {
    expect(await fetchCheckpointTeamsTranscript("")).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    expect(await fetchCheckpointTeamsTranscript("x".repeat(101))).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    h.state.dbUserId = null;
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(h.fetchNow).not.toHaveBeenCalled();
  });

  it("mapeia falhas: forbidden/not_found/too_early/not_connected", async () => {
    h.fetchNow.mockResolvedValueOnce({ ok: false, code: "forbidden" });
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    h.fetchNow.mockResolvedValueOnce({ ok: false, code: "not_found" });
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: false, error: "NOT_FOUND" });
    h.fetchNow.mockResolvedValueOnce({ ok: false, code: "too_early" });
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: false, message: expect.stringContaining("minutos") });
    h.fetchNow.mockResolvedValueOnce({ ok: false, code: "not_connected" });
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: false, message: expect.stringContaining("Ative as transcrições") });
    h.fetchNow.mockResolvedValueOnce({ ok: true, value: "no_transcript" });
    expect(await fetchCheckpointTeamsTranscript("chk1")).toMatchObject({ ok: true, data: { message: expect.stringContaining("Cole suas notas") } });
  });
});
