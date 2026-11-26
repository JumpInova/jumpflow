import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { getEntity } from "@/lib/consultas/catalog";

const { executarVisao } = vi.hoisted(() => ({ executarVisao: vi.fn() }));
vi.mock("@/app/app/consultas/visoes/actions", () => ({ executarVisao }));

import { SavedViewRunner } from "./SavedViewRunner";

const horas = getEntity("horas")!;

const grouped = {
  entity: "horas",
  grouped: true,
  columns: [
    { key: "projeto", label: "Projeto", type: "texto", kind: "group", field: "projeto" },
    { key: "sum:horas", label: "Soma de Horas lançadas", type: "horas", kind: "measure", field: "horas", agg: "sum" },
  ],
  measures: [{ key: "sum:horas", label: "Soma de Horas lançadas", type: "horas", kind: "measure", field: "horas", agg: "sum" }],
  rows: [
    { projeto: "Atlas", "sum:horas": 40 },
    { projeto: "Boreal", "sum:horas": 12 },
  ],
  totals: { "sum:horas": 52 },
  page: 1,
  pageSize: 100,
  pageCount: 1,
  totalRows: 2,
  navigableRows: 2,
};

describe("SavedViewRunner", () => {
  it("executa pelo id (sem enviar spec) e desenha barras com tabela acessível", async () => {
    executarVisao.mockResolvedValue({ ok: true, data: grouped });
    render(<SavedViewRunner viewId="v1" name="Horas por projeto" entity={horas} visualization="BAR" />);
    await waitFor(() => expect(screen.getByRole("figure")).toBeInTheDocument());
    expect(executarVisao).toHaveBeenCalledWith("v1", 1);
    expect(screen.getAllByText("Atlas").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/gráfico de barras/).length).toBeGreaterThan(0);
  });

  it("gráfico sem agrupamento explica o motivo em vez de desenhar", async () => {
    executarVisao.mockResolvedValue({ ok: true, data: { ...grouped, grouped: false } });
    render(<SavedViewRunner viewId="v1" name="X" entity={horas} visualization="PIE" compact />);
    await waitFor(() => expect(screen.getByText(/precisam de uma consulta agrupada/)).toBeInTheDocument());
  });

  it("erro do servidor aparece como alerta, sem detalhes técnicos", async () => {
    executarVisao.mockResolvedValue({ ok: false, code: "NOT_FOUND", error: "Visão não encontrada ou sem acesso." });
    render(<SavedViewRunner viewId="v1" name="X" entity={horas} visualization="TABLE" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Visão não encontrada ou sem acesso.");
  });

  it("indicador mostra o total de cada medida", async () => {
    executarVisao.mockResolvedValue({ ok: true, data: grouped });
    render(<SavedViewRunner viewId="v1" name="X" entity={horas} visualization="INDICATOR" compact />);
    expect(await screen.findByText("52 h")).toBeInTheDocument();
  });
});
