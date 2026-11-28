import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { aggregateRolePermissions, CONSULTAS_CODES } from "@/lib/auth/permission-codes";
import { buildConsultaAccess, visibleCatalog } from "@/lib/consultas/access";

const { executarConsulta, gerarConsultaComIA, push } = vi.hoisted(() => ({
  executarConsulta: vi.fn(),
  gerarConsultaComIA: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/app/app/consultas/actions", () => ({ executarConsulta, gerarConsultaComIA }));
vi.mock("@/app/app/consultas/visoes/actions", () => ({ salvarVisao: vi.fn(), atualizarVisao: vi.fn() }));

import { ConsultaBuilder } from "./ConsultaBuilder";

const entities = visibleCatalog(
  buildConsultaAccess(
    aggregateRolePermissions(
      [CONSULTAS_CODES.module, CONSULTAS_CODES.hours, CONSULTAS_CODES.create, CONSULTAS_CODES.ai].map((code) => ({
        code,
        canView: true,
        canCreate: false,
        canEdit: false,
        canDelete: false,
      })),
    ),
    { financial: false, sensitiveCost: false },
  ),
);

const spec = {
  entity: "horas",
  filters: null,
  columns: [],
  groupBy: [{ field: "projeto" }],
  measures: [{ field: "horas", agg: "sum" }],
  sort: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  executarConsulta.mockResolvedValue({ ok: false, code: "FAILED", error: "x" });
});

describe("Assistente de IA no construtor", () => {
  it("sem permissão (prop ausente) não aparece", () => {
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} />);
    expect(screen.queryByText("Assistente de IA")).toBeNull();
  });

  it("provider indisponível: só o aviso, o construtor segue", () => {
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} assistant="off" />);
    expect(screen.getByText(/assistente de IA está indisponível/i)).toBeTruthy();
    expect(screen.getByLabelText("Entidade")).toBeTruthy();
  });

  it("mostra a explicação e só roda depois de confirmar", async () => {
    gerarConsultaComIA.mockResolvedValue({
      ok: true,
      spec,
      entityLabel: "Horas",
      explanation: ["Entidade: Horas.", "Agrupa por Projeto."],
    });
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} assistant="on" />);
    fireEvent.change(screen.getByLabelText("O que você quer consultar?"), {
      target: { value: "horas por projeto" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Montar consulta" }));
    await waitFor(() => expect(screen.getByText("Agrupa por Projeto.")).toBeTruthy());
    expect(gerarConsultaComIA).toHaveBeenCalledWith("horas por projeto");
    expect(executarConsulta).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar e rodar" }));
    await waitFor(() => expect(executarConsulta).toHaveBeenCalledTimes(1));
    expect(executarConsulta.mock.calls[0][0]).toMatchObject({ entity: "horas", groupBy: [{ field: "projeto" }] });
  });

  it("erro amigável do servidor aparece como alerta", async () => {
    gerarConsultaComIA.mockResolvedValue({ ok: false, code: "RATE_LIMITED", error: "Muitos pedidos ao assistente." });
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} assistant="on" />);
    fireEvent.change(screen.getByLabelText("O que você quer consultar?"), { target: { value: "horas" } });
    fireEvent.click(screen.getByRole("button", { name: "Montar consulta" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Muitos pedidos"));
    expect(executarConsulta).not.toHaveBeenCalled();
  });

  it("action rejeitada (rede/servidor) vira mensagem fixa, sem quebrar o construtor", async () => {
    gerarConsultaComIA.mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} assistant="on" />);
    fireEvent.change(screen.getByLabelText("O que você quer consultar?"), { target: { value: "horas" } });
    fireEvent.click(screen.getByRole("button", { name: "Montar consulta" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Não foi possível falar com o assistente"));
    expect(screen.getByRole("alert").textContent).not.toContain("ECONNRESET");
    expect(screen.getByLabelText("Entidade")).toBeTruthy();
  });
});
