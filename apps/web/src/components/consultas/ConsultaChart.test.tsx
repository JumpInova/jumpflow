import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { getEntity } from "@/lib/consultas/catalog";
import type { ChartSource } from "@/lib/consultas/chart";
import { ConsultaChart } from "./ConsultaChart";

/**
 * Gráficos de Consultas (Fase C2, testador): todo gráfico tem tabela
 * equivalente acessível (o SVG fica `aria-hidden`), legenda/caption e
 * explicação quando não dá para desenhar.
 */

const horas = getEntity("horas")!;

function source(rows: Record<string, unknown>[], measures = 1): ChartSource {
  const measureCols = [
    { key: "sum:horas", label: "Soma de Horas lançadas", type: "horas" as const, kind: "measure" as const, field: "horas", agg: "sum" as const },
    { key: "count:horas", label: "Contagem", type: "numero" as const, kind: "measure" as const, field: "horas", agg: "count" as const },
  ].slice(0, measures);
  return {
    grouped: true,
    columns: [{ key: "projeto", label: "Projeto", type: "texto", kind: "group", field: "projeto" }, ...measureCols],
    measures: measureCols,
    rows: rows as ChartSource["rows"],
    totals: { "sum:horas": 52, "count:horas": 3 },
  };
}

const ROWS = [
  { projeto: "Atlas", "sum:horas": 40, "count:horas": 2 },
  { projeto: "Boreal", "sum:horas": 12, "count:horas": 1 },
];

describe("ConsultaChart: tabela equivalente acessível", () => {
  it.each(["BAR", "LINE", "PIE"] as const)("%s: figura nomeada, SVG oculto e tabela com todos os valores", (viz) => {
    const { container } = render(
      <ConsultaChart entity={horas} source={source(ROWS)} visualization={viz} title="Horas por projeto" />,
    );
    const figure = screen.getByRole("figure");
    expect(figure).toHaveAccessibleName(/Horas por projeto: gráfico de/);
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    const table = within(figure).getByRole("table");
    expect(table.className).toContain("sr-only");
    expect(within(table).getByText(/Horas por projeto: gráfico de/)).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Grupo",
      "Soma de Horas lançadas",
    ]);
    const rowHeaders = within(table).getAllByRole("rowheader").map((th) => th.textContent);
    expect(rowHeaders).toEqual(["Atlas", "Boreal"]);
    expect(within(table).getByText("40 h")).toBeInTheDocument();
    expect(within(table).getByText("12 h")).toBeInTheDocument();
  });

  it("barras com várias medidas: uma coluna por série na tabela", () => {
    render(<ConsultaChart entity={horas} source={source(ROWS, 2)} visualization="BAR" title="X" />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  });

  it("pizza com mais de 8 fatias: tabela traz o grupo “Outros” com a soma do restante", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ projeto: `P${i}`, "sum:horas": 10 - i }));
    render(<ConsultaChart entity={horas} source={source(rows)} visualization="PIE" title="X" />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("rowheader").map((th) => th.textContent);
    expect(headers).toHaveLength(9);
    expect(headers.at(-1)).toBe("Outros");
    // P8 (2) + P9 (1) = 3
    const outros = within(table).getByText("Outros").closest("tr")!;
    expect(outros).toHaveTextContent("3 h");
  });

  it("barras com mais de 30 grupos avisa quantos ficaram de fora", () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ projeto: `P${i}`, "sum:horas": i }));
    render(<ConsultaChart entity={horas} source={source(rows)} visualization="BAR" title="X" />);
    expect(screen.getByText(/5 ficaram de fora/)).toHaveTextContent("veja a tabela abaixo");
  });

  it("no cartão compacto (sem tabela visível) o aviso manda abrir a visão, não “ver a tabela”", () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({ projeto: `P${i}`, "sum:horas": i }));
    render(<ConsultaChart entity={horas} source={source(rows)} visualization="BAR" title="X" compact />);
    const notice = screen.getByText(/5 ficaram de fora/);
    expect(notice).toHaveTextContent("abra a visão");
    expect(notice).not.toHaveTextContent("tabela");
  });

  it("indicador usa lista de definição legível (sem SVG)", () => {
    const { container } = render(
      <ConsultaChart entity={horas} source={source(ROWS)} visualization="INDICATOR" title="X" />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("dt")).toHaveTextContent("Soma de Horas lançadas");
    expect(container.querySelector("dd")).toHaveTextContent("52 h");
  });

  it("sem agrupamento/medida ou com negativo na pizza: explica o motivo em texto", () => {
    const { rerender } = render(
      <ConsultaChart entity={horas} source={{ ...source(ROWS), grouped: false }} visualization="BAR" title="X" />,
    );
    expect(screen.getByText(/precisam de uma consulta agrupada/)).toBeInTheDocument();
    rerender(
      <ConsultaChart
        entity={horas}
        source={source([{ projeto: "A", "sum:horas": -1 }])}
        visualization="PIE"
        title="X"
      />,
    );
    expect(screen.getByText(/Pizza não representa valores negativos/)).toBeInTheDocument();
    expect(screen.queryByRole("figure")).toBeNull();
  });
});
