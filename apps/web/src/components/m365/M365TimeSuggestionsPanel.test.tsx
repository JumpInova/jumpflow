import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * QA (Fase M1) — painel de sugestões na tela de Horas: só pré-preenche (link
 * para o formulário), ambíguo → um botão por projeto, sem tela cheia → só
 * ignorar; ignorar chama a action com o id (nunca cria lançamento).
 */

const h = vi.hoisted(() => ({
  dismiss: vi.fn<(id: string) => Promise<{ ok: true; data: null }>>(async () => ({ ok: true as const, data: null })),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/app/app/horas/m365-suggestion-actions", () => ({ dismissM365TimeSuggestion: h.dismiss }));

import { Microsoft365TimeSuggestionsPanel } from "./M365TimeSuggestionsPanel";

const base = {
  id: "sug-1",
  date: "2026-11-25",
  startAt: "2026-11-25T13:00:00.000Z",
  endAt: "2026-11-25T14:00:00.000Z",
  minutes: 60,
  subject: "Kickoff ACME",
  matchKind: "DOMAIN" as const,
  projects: [
    { id: "p1", name: "ACME Portal", clientName: "ACME" },
    { id: "p2", name: "ACME BI", clientName: "ACME" },
  ],
};

describe("Microsoft365TimeSuggestionsPanel", () => {
  it("ambíguo: um link 'Usar em <projeto>' por candidato, apontando para o pré-preenchimento", () => {
    render(<Microsoft365TimeSuggestionsPanel suggestions={[base]} weekStart="2026-11-23" canPrefill presentation="quiet" />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Usar em ACME Portal", "Usar em ACME BI"]);
    expect(links[1].getAttribute("href")).toBe("/app/horas/lancamento?semana=2026-11-23&sugestao=sug-1&projeto=p2");
    expect(screen.getByText(/vínculo pelo domínio do cliente/)).toBeInTheDocument();
  });

  it("sem acesso à tela cheia de lançamento: nenhum 'Usar', só 'Ignorar'", () => {
    render(<Microsoft365TimeSuggestionsPanel suggestions={[base]} weekStart="2026-11-23" canPrefill={false} presentation="quiet" />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Ignorar/ })).toBeInTheDocument();
  });

  it("ignorar chama a action com o id da sugestão", async () => {
    render(<Microsoft365TimeSuggestionsPanel suggestions={[{ ...base, projects: [base.projects[0]], matchKind: "EMAIL" }]} weekStart="2026-11-23" canPrefill presentation="quiet" />);
    expect(screen.getByRole("link").textContent).toBe("Usar · ACME Portal");
    fireEvent.click(screen.getByRole("button", { name: /Ignorar/ }));
    await waitFor(() => expect(h.dismiss).toHaveBeenCalledWith("sug-1"));
  });

  it("sem sugestões não renderiza nada", () => {
    const { container } = render(<Microsoft365TimeSuggestionsPanel suggestions={[]} weekStart="2026-11-23" canPrefill presentation="quiet" />);
    expect(container).toBeEmptyDOMElement();
  });
});
