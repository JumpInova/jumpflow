import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CheckpointViewModel } from "@/lib/db/checkpoint";
import type { CheckpointM365View } from "@/lib/checkpoint/action-items";
import { CheckpointCard } from "./CheckpointCard";

const searchCheckpointMinutes = vi.fn();
const listCheckpointMinutesCandidates = vi.fn();
const chooseCheckpointMinutesEmail = vi.fn();
const decideCheckpointActionItem = vi.fn();

vi.mock("@/app/app/checkpoints/actions", () => ({
  setVisibility: vi.fn(),
  archiveCheckpoint: vi.fn(),
  extractCheckpointInsights: vi.fn(),
  decideOpportunity: vi.fn(),
  decideCase: vi.fn(),
}));
vi.mock("@/app/app/checkpoints/m365-actions", () => ({
  searchCheckpointMinutes: (...a: unknown[]) => searchCheckpointMinutes(...a),
  listCheckpointMinutesCandidates: (...a: unknown[]) => listCheckpointMinutesCandidates(...a),
  chooseCheckpointMinutesEmail: (...a: unknown[]) => chooseCheckpointMinutesEmail(...a),
  decideCheckpointActionItem: (...a: unknown[]) => decideCheckpointActionItem(...a),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function item(over: Partial<CheckpointViewModel> = {}): CheckpointViewModel {
  return {
    id: "cp1",
    consultantId: "con1",
    consultantName: "Ana Lima",
    managerUserId: "u1",
    managerName: "Bia",
    type: "ONE_ON_ONE",
    occurredAt: "2026-11-24T13:00:00.000Z",
    weekStart: null,
    weekEnd: null,
    title: "1:1 Ana",
    relatedProjectId: null,
    relatedProjectName: null,
    status: "DRAFT",
    visibility: "PRIVATE",
    extractionStatus: "NONE",
    transcriptionStatus: "NONE",
    createdAt: "2026-11-24T13:00:00.000Z",
    canManage: true,
    canViewRaw: true,
    notes: null,
    transcription: null,
    ...over,
  };
}

const view = (over: Partial<CheckpointM365View> = {}): CheckpointM365View => ({
  linkedToEvent: true,
  isOwnManager: true,
  minutes: null,
  actionItems: [
    { id: "a1", title: "Enviar plano", ownerText: "Ana", dueDate: "2026-12-05", dueText: null, sourceQuote: "vou enviar", status: "PENDING" },
  ],
  ...over,
});

const flags = { enabled: true, voice: false, ai: false };

describe("CheckpointCard + painel Microsoft 365", () => {
  it("quem não vê o cru (consultor avaliado) não recebe ata nem cards, mesmo se o dado vier", () => {
    render(
      <ul>
        <CheckpointCard
          item={item({ canViewRaw: false, canManage: false, visibility: "SHARED" })}
          insights={{ opportunities: [], cases: [] }}
          flags={flags}
          notify={vi.fn()}
          m365={view()}
        />
      </ul>,
    );
    expect(screen.queryByTestId("checkpoint-m365")).toBeNull();
    expect(screen.queryByText("Enviar plano")).toBeNull();
  });

  it("gestor vê o estado, busca na própria caixa e valida as ações", async () => {
    searchCheckpointMinutes.mockResolvedValueOnce({ ok: true, data: { outcome: "none", message: "Nenhum e-mail." } });
    decideCheckpointActionItem.mockResolvedValueOnce({ ok: true, data: { id: "a1", status: "ACCEPTED" } });
    const notify = vi.fn();
    render(
      <ul>
        <CheckpointCard item={item()} insights={{ opportunities: [], cases: [] }} flags={flags} notify={notify} m365={view()} />
      </ul>,
    );
    const panel = screen.getByTestId("checkpoint-m365");
    expect(within(panel).getByText("Aguardando a ata")).toBeTruthy();
    expect(within(panel).getByText(/Prazo: 05\/12\/2026/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /Buscar ata no e-mail/ }));
    await waitFor(() => expect(searchCheckpointMinutes).toHaveBeenCalledWith("cp1"));
    // Espera a transição terminar (botões voltam a ficar habilitados).
    await waitFor(() => expect(notify).toHaveBeenCalledWith("info", "Nenhum e-mail."));
    await waitFor(() =>
      expect((within(panel).getByRole("button", { name: /Aceitar/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(within(panel).getByRole("button", { name: /Aceitar/ }));
    await waitFor(() => expect(decideCheckpointActionItem).toHaveBeenCalledWith({ id: "a1", status: "ACCEPTED" }));
    await waitFor(() => expect(within(panel).getByText("Aceita")).toBeTruthy());
  });

  it("quem não é o gestor do checkpoint (ex.: PEOPLE) não tem o botão de buscar na caixa", () => {
    render(
      <ul>
        <CheckpointCard
          item={item()}
          insights={{ opportunities: [], cases: [] }}
          flags={flags}
          notify={vi.fn()}
          m365={view({ isOwnManager: false })}
        />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: /Buscar ata no e-mail/ })).toBeNull();
  });

  it("empate: lista as candidatas ao vivo e usa a escolhida", async () => {
    listCheckpointMinutesCandidates.mockResolvedValueOnce({
      ok: true,
      data: [
        { messageId: "m1", subject: "Ata 1:1 Ana", receivedAt: "2026-11-24T15:00:00.000Z", fromName: "Bia", fromEmail: null, webLink: null, hasAttachments: false },
        { messageId: "m2", subject: "RE: 1:1 Ana", receivedAt: "2026-11-25T10:00:00.000Z", fromName: "Ana", fromEmail: null, webLink: null, hasAttachments: true },
      ],
    });
    chooseCheckpointMinutesEmail.mockResolvedValueOnce({ ok: true, data: { outcome: "saved", message: "Ata gerada." } });
    render(
      <ul>
        <CheckpointCard
          item={item()}
          insights={{ opportunities: [], cases: [] }}
          flags={flags}
          notify={vi.fn()}
          m365={view({
            actionItems: [],
            minutes: { status: "AMBIGUOUS", webLink: null, receivedAt: null, aiSummary: false, attachmentsUsed: 0, attachmentsSkipped: 0, lastCheckedAt: null },
          })}
        />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Escolher o e-mail da ata/ }));
    await waitFor(() => expect(screen.getByText("RE: 1:1 Ana")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/RE: 1:1 Ana/));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Usar este e-mail/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /Usar este e-mail/ }));
    await waitFor(() => expect(chooseCheckpointMinutesEmail).toHaveBeenCalledWith({ checkpointId: "cp1", messageId: "m2" }));
  });
});
