import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";

/**
 * Server actions de visões/painéis (Fase C2, testador): o cliente só manda
 * id/formulário — nunca a spec de uma visão salva nem a origem —, ids com
 * forma inválida não chegam ao banco e erros inesperados não vazam detalhe.
 */

const lib = vi.hoisted(() => ({
  runSavedView: vi.fn(),
  createSavedView: vi.fn(),
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
  createPanel: vi.fn(),
  updatePanel: vi.fn(),
  deletePanel: vi.fn(),
}));

let databaseConfigured = true;
const currentUser = { id: "u1", name: "P", email: "p@jump", roles: ["PROJECT_MANAGER"] } as AppUser;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireUser: vi.fn(async () => currentUser) }));
vi.mock("@/lib/db/config", () => ({ isDatabaseConfigured: () => databaseConfigured }));
vi.mock("@/lib/db/consultas-saved", () => lib);

import { ConsultaError } from "@/lib/consultas/errors";
import {
  atualizarPainel,
  atualizarVisao,
  executarVisao,
  excluirPainel,
  excluirVisao,
  salvarPainel,
} from "./actions";

beforeEach(() => {
  databaseConfigured = true;
  lib.runSavedView.mockResolvedValue({ rows: [] });
});

afterEach(() => vi.clearAllMocks());

const BAD_IDS = ["../x", "a b", "", "x".repeat(65), "id'; DROP", 42, null, { id: "v1" }, ["v1"]];

describe("executarVisao", () => {
  it("repassa só usuário, id e página — nada de spec ou origem do cliente", async () => {
    const spoof = executarVisao as unknown as (...args: unknown[]) => Promise<unknown>;
    await spoof("v1", 2, { entity: "pagamentos", columns: ["valor_total"] }, "adhoc");
    expect(lib.runSavedView).toHaveBeenCalledWith(currentUser, "v1", 2);
  });

  it.each(BAD_IDS)("id inválido %j → NOT_FOUND sem tocar o banco", async (id) => {
    const result = await executarVisao(id, 1);
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(lib.runSavedView).not.toHaveBeenCalled();
  });

  it("página não numérica vira 1", async () => {
    await executarVisao("v1", "999; DROP");
    expect(lib.runSavedView).toHaveBeenCalledWith(currentUser, "v1", 1);
  });

  it("NOT_FOUND do domínio passa adiante; erro inesperado vira FAILED genérico", async () => {
    lib.runSavedView.mockRejectedValueOnce(new ConsultaError("NOT_FOUND", "Visão não encontrada ou sem acesso."));
    expect(await executarVisao("v1", 1)).toEqual({
      ok: false,
      code: "NOT_FOUND",
      error: "Visão não encontrada ou sem acesso.",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    lib.runSavedView.mockRejectedValueOnce(new Error('relation "consulta_projetos" leaked'));
    const failed = await executarVisao("v1", 1);
    expect(failed).toMatchObject({ ok: false, code: "FAILED" });
    expect(JSON.stringify(failed)).not.toContain("consulta_projetos");
    spy.mockRestore();
  });

  it("sem banco → NO_DATABASE", async () => {
    databaseConfigured = false;
    expect(await executarVisao("v1", 1)).toMatchObject({ ok: false, code: "NO_DATABASE" });
    expect(lib.runSavedView).not.toHaveBeenCalled();
  });
});

describe("ações de escrita validam o id antes de chegar ao servidor de dados", () => {
  it.each(BAD_IDS)("id %j recusado em atualizar/excluir visão e painel", async (id) => {
    const form = { name: "x", visualization: "TABLE", sharing: "PRIVATE" };
    expect(await atualizarVisao(id, form)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await excluirVisao(id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await atualizarPainel(id, { name: "x", items: [], sharing: "PRIVATE" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await excluirPainel(id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(lib.updateSavedView).not.toHaveBeenCalled();
    expect(lib.deleteSavedView).not.toHaveBeenCalled();
    expect(lib.updatePanel).not.toHaveBeenCalled();
    expect(lib.deletePanel).not.toHaveBeenCalled();
  });

  it("atualizarVisao sem spec não envia chave spec", async () => {
    await atualizarVisao("v1", { name: "x", visualization: "TABLE", sharing: "PRIVATE" });
    expect(lib.updateSavedView.mock.calls[0][2]).not.toHaveProperty("spec");
  });

  it("FORBIDDEN de compartilhamento chega ao cliente com o código certo", async () => {
    lib.createPanel.mockRejectedValueOnce(new ConsultaError("FORBIDDEN", "Você não tem permissão para compartilhar visões e painéis."));
    expect(await salvarPainel({ name: "P", items: [{ viewId: "v1" }], sharing: "ALL" })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
  });
});
