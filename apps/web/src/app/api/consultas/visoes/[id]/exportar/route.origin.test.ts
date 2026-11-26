import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";

/**
 * Exportação de visão salva (Fase C2, testador): nenhum parâmetro do cliente
 * (spec, origem, entidade, viewId alternativo) chega a `exportSavedView`; a
 * rota não lê corpo e não vaza o motivo de 404.
 */

const { exportSavedView } = vi.hoisted(() => ({ exportSavedView: vi.fn() }));
const currentUser: AppUser = { id: "u", name: "U", email: "u@jump", roles: ["PROJECT_MANAGER"] };

vi.mock("@/lib/auth/guards", () => ({ requireUser: vi.fn(async () => currentUser) }));
vi.mock("@/lib/db/config", () => ({ isDatabaseConfigured: () => true }));
vi.mock("@/lib/db/consultas-saved", () => ({ exportSavedView }));

import { getEntity } from "@/lib/consultas/catalog";
import { ConsultaError } from "@/lib/consultas/errors";
import { GET } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  exportSavedView.mockResolvedValue({
    viewName: "Projetos",
    validated: { entity: getEntity("projetos")!, spec: {}, usesSensitive: false },
    columns: [{ key: "projeto", label: "Projeto", type: "texto", kind: "column", field: "projeto", alias: "c0" }],
    measures: [],
    rows: [{ projeto: "Atlas" }],
    totals: null,
    truncated: false,
  });
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/consultas/visoes/[id]/exportar — entrada do cliente ignorada", () => {
  it("origin/spec/entity/viewId na query não chegam ao servidor de dados", async () => {
    const spec = encodeURIComponent(JSON.stringify({ entity: "pagamentos", columns: ["valor_total"] }));
    const url = `http://localhost/api/consultas/visoes/v1/exportar?formato=xlsx&origin=adhoc&viewId=outra&entity=pagamentos&spec=${spec}`;
    const response = await GET(new Request(url), params("v1"));
    expect(response.status).toBe(200);
    expect(exportSavedView).toHaveBeenCalledTimes(1);
    expect(exportSavedView.mock.calls[0]).toEqual([currentUser, "v1", "xlsx"]);
  });

  it("formato duplicado/alterado não escapa do enum", async () => {
    for (const query of ["?formato=CSV", "?formato=xlsx%00", "?formato=", ""]) {
      const response = await GET(new Request(`http://localhost/x${query}`), params("v1"));
      expect(response.status, query).toBe(400);
    }
    expect(exportSavedView).not.toHaveBeenCalled();
  });

  it("404 e 403 devolvem só a mensagem do domínio (sem nome da visão)", async () => {
    exportSavedView.mockRejectedValueOnce(new ConsultaError("NOT_FOUND", "Visão não encontrada ou sem acesso."));
    const response = await GET(new Request("http://localhost/x?formato=csv"), params("priv"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Visão não encontrada ou sem acesso.");
    expect(response.headers.get("Content-Disposition")).toBeNull();
  });
});
