import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { aggregateRolePermissions, CONSULTAS_CODES } from "@/lib/auth/permission-codes";
import { buildConsultaAccess, visibleCatalog } from "@/lib/consultas/access";

const { executarConsulta, salvarVisao, push } = vi.hoisted(() => ({
  executarConsulta: vi.fn(),
  salvarVisao: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/app/app/consultas/actions", () => ({ executarConsulta }));
// O diálogo "Salvar como visão" importa as actions de visões (servidor).
vi.mock("@/app/app/consultas/visoes/actions", () => ({ salvarVisao, atualizarVisao: vi.fn() }));

import { ConsultaBuilder } from "./ConsultaBuilder";

const access = buildConsultaAccess(
  aggregateRolePermissions(
    [CONSULTAS_CODES.module, CONSULTAS_CODES.hours, CONSULTAS_CODES.create].map((code) => ({
      code,
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    })),
  ),
  { financial: false, sensitiveCost: false },
);
const entities = visibleCatalog(access);

describe("ConsultaBuilder", () => {
  it("oferece só campos visíveis e envia a spec (sem SQL) ao executar", async () => {
    executarConsulta.mockResolvedValue({
      ok: true,
      result: {
        entity: "horas",
        grouped: false,
        columns: [{ key: "projeto", label: "Projeto", type: "texto", kind: "column", field: "projeto" }],
        measures: [],
        rows: [{ projeto: "Atlas", _href: "/app/consultores/c1" }],
        totals: null,
        page: 1,
        pageSize: 100,
        pageCount: 1,
        totalRows: 1,
        navigableRows: 1,
        detailLabel: "Abrir consultor",
      },
    });
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} />);

    expect(screen.queryByLabelText("Receita")).toBeNull();
    expect(screen.getByLabelText("Horas lançadas")).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Executar" }));
    await waitFor(() => expect(screen.getByText("Atlas")).toBeInTheDocument());
    const [spec, page] = executarConsulta.mock.calls[0];
    expect(page).toBe(1);
    expect(spec).toMatchObject({ entity: "horas", groupBy: [] });
    expect(JSON.stringify(spec)).not.toMatch(/select|from/i);
    expect(screen.getByRole("link", { name: "Abrir consultor" })).toHaveAttribute("href", "/app/consultores/c1");
  });

  it("modo agrupado cria agrupamento + medida; erro do servidor aparece como alerta", async () => {
    executarConsulta.mockResolvedValue({ ok: false, code: "FORBIDDEN", error: "Sem permissão." });
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} />);
    fireEvent.click(screen.getByRole("radio", { name: "Agrupar e somar" }));
    expect(screen.getByLabelText("Agrupar por (1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Medida 1: campo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Executar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem permissão.");
  });

  it("salva como visão: envia a spec + formulário; sem COMPARTILHAR só “Só eu”", async () => {
    salvarVisao.mockResolvedValue({ ok: true, data: { id: "v9" } });
    render(<ConsultaBuilder entities={entities} canExport={false} demo={false} canShare={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Salvar como visão/ }));
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByRole("radio", { name: "Todos com acesso a Consultas" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Papéis selecionados" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Minhas horas" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar visão" }));
    await waitFor(() => expect(salvarVisao).toHaveBeenCalled());
    const [spec, form] = salvarVisao.mock.calls[0];
    expect(spec.entity).toBe("horas");
    expect(JSON.stringify(spec)).not.toMatch(/select|sql/i);
    expect(form).toMatchObject({ name: "Minhas horas", sharing: "PRIVATE", visualization: "TABLE" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/consultas/visoes/v9"));
    expect(dialog).toBeTruthy();
  });
});
