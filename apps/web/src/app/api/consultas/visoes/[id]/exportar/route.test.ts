import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";

/**
 * Exportação de visão salva: a spec NUNCA vem do cliente (só o id na URL);
 * a rota delega a `exportSavedView` e devolve o arquivo/erro sem detalhes.
 */

const { exportSavedView } = vi.hoisted(() => ({ exportSavedView: vi.fn() }));
let databaseConfigured = true;
const currentUser: AppUser = { id: "u", name: "U", email: "u@jump", roles: ["FINANCE"] };

vi.mock("@/lib/auth/guards", () => ({ requireUser: vi.fn(async () => currentUser) }));
vi.mock("@/lib/db/config", () => ({ isDatabaseConfigured: () => databaseConfigured }));
vi.mock("@/lib/db/consultas-saved", () => ({ exportSavedView }));

import { getEntity } from "@/lib/consultas/catalog";
import { ConsultaError } from "@/lib/consultas/errors";
import { GET } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (query: string) => new Request(`http://localhost/api/consultas/visoes/v1/exportar${query}`);

beforeEach(() => {
  databaseConfigured = true;
  exportSavedView.mockResolvedValue({
    viewName: "Horas: time / Ação",
    validated: { entity: getEntity("horas")!, spec: {}, usesSensitive: false },
    columns: [{ key: "consultor", label: "Consultor", type: "pessoa", kind: "column", field: "consultor", alias: "c0" }],
    measures: [],
    rows: [{ consultor: "=HYPERLINK(1)" }],
    totals: null,
    truncated: false,
  });
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/consultas/visoes/[id]/exportar", () => {
  it("só aceita formato xlsx/csv e id com forma válida", async () => {
    expect((await GET(request("?formato=pdf"), params("v1"))).status).toBe(400);
    expect((await GET(request("?formato=csv"), params("../x"))).status).toBe(404);
    expect(exportSavedView).not.toHaveBeenCalled();
  });

  it("sem banco → 503", async () => {
    databaseConfigured = false;
    expect((await GET(request("?formato=csv"), params("v1"))).status).toBe(503);
  });

  it("chama exportSavedView só com usuário, id e formato; CSV com escape de fórmula e nome seguro", async () => {
    const response = await GET(request("?formato=csv&spec=%7B%7D"), params("v1"));
    expect(response.status).toBe(200);
    expect(exportSavedView).toHaveBeenCalledWith(currentUser, "v1", "csv");
    const text = await response.text();
    expect(text).toContain("'=HYPERLINK(1)");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(/filename="Horas-time-Acao_\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it("erros de domínio viram status sem detalhes; erro inesperado vira 500 genérico", async () => {
    exportSavedView.mockRejectedValueOnce(new ConsultaError("NOT_FOUND", "Visão não encontrada ou sem acesso."));
    const notFound = await GET(request("?formato=xlsx"), params("v1"));
    expect(notFound.status).toBe(404);
    exportSavedView.mockRejectedValueOnce(new ConsultaError("FORBIDDEN", "Sem permissão."));
    expect((await GET(request("?formato=xlsx"), params("v1"))).status).toBe(403);
    exportSavedView.mockRejectedValueOnce(new Error('relation "consulta_horas" does not exist'));
    const failed = await GET(request("?formato=xlsx"), params("v1"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("consulta_horas");
  });
});
