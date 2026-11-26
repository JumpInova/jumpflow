import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const created = { opportunities: [] as Record<string, unknown>[], cases: [] as Record<string, unknown>[], skills: [] as Record<string, unknown>[] };
  const tx = {
    opportunity: {
      deleteMany: vi.fn(),
      findMany: vi.fn(async () => [] as Array<{ title: string }>),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => created.opportunities.push(data)),
    },
    case: {
      deleteMany: vi.fn(),
      findMany: vi.fn(async () => [] as Array<{ title: string }>),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => created.cases.push(data)),
    },
    skillSuggestion: {
      findMany: vi.fn(async () => [] as Array<{ suggestedName: string }>),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => created.skills.push(create)),
    },
    checkpoint: { update: vi.fn() },
  };
  return {
    created,
    prisma: { ...tx, $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)) },
  };
});

vi.mock("@jumpflow/database", () => ({ prisma: h.prisma }));
vi.mock("@/lib/ai/log", () => ({ recordAiUsage: vi.fn() }));
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("./flags", () => ({ isCheckpointAiEnabled: () => true }));

import { emptyPiiMap, maskPii } from "@/lib/m365/minutes/pii";
import { runCheckpointExtraction, type ExtractionRow } from "./run-extraction";

const row: ExtractionRow = {
  id: "chk1",
  consultantId: "cons-ana",
  relatedProjectId: null,
  type: "ONE_ON_ONE",
  occurredAt: new Date("2026-11-24T13:00:00Z"),
  weekStart: null,
  weekEnd: null,
  notes: "Ana indicou o contato joao@cliente.com.br (11) 98765-4321 para expandir o projeto.",
  transcription: null,
};

function provider(output: unknown) {
  return {
    complete: vi.fn<(p: string, o?: unknown) => Promise<string | null>>(async () => JSON.stringify(output)),
    completeWithDocument: vi.fn(async () => null),
  };
}

beforeEach(() => {
  h.created.opportunities.length = 0;
  h.created.cases.length = 0;
  h.created.skills.length = 0;
});

describe("runCheckpointExtraction — máscara antes da IA, desmascara antes de gravar", () => {
  it("sem texto mascarado de fora: mascara aqui (prefixo próprio) e desmascara os candidatos", async () => {
    const ai = provider({
      opportunities: [{ title: "Expandir com [EMAIL_X1]", description: "Ligar [TELEFONE_X1]", quote: "contato [EMAIL_X1]" }],
    });
    const result = await runCheckpointExtraction(row, { actorUserId: "u1", provider: ai });
    expect(result).toMatchObject({ status: "done", opportunities: 1 });
    const [prompt] = ai.complete.mock.calls[0];
    expect(prompt).not.toContain("joao@cliente.com.br");
    expect(prompt).not.toContain("98765-4321");
    expect(prompt).toContain("[EMAIL_X1]");
    expect(h.created.opportunities[0]).toMatchObject({
      title: "Expandir com joao@cliente.com.br",
      description: "Ligar (11) 98765-4321",
      sourceQuote: "contato joao@cliente.com.br",
    });
  });

  it("com texto mascarado + mapa da ata (M365): a IA vê só o mascarado e os cards saem com o dado real", async () => {
    const map = emptyPiiMap();
    const masked = maskPii("Falar com joao@cliente.com.br sobre o case concluído.", map).masked;
    const ai = provider({ cases: [{ title: "Case com [EMAIL_1]", summary: "Entrega concluída", quote: "falar com [EMAIL_1]" }] });
    await runCheckpointExtraction(
      { ...row, notes: "Falar com joao@cliente.com.br (ata desmascarada)" },
      { actorUserId: null, provider: ai, masked: { notes: masked, transcription: masked, piiMap: map } },
    );
    const [prompt] = ai.complete.mock.calls[0];
    expect(prompt).not.toContain("joao@cliente.com.br");
    expect(h.created.cases[0]).toMatchObject({ title: "Case com joao@cliente.com.br", sourceQuote: "falar com joao@cliente.com.br" });
  });
});

describe("runCheckpointExtraction — preserveDecided (reextração automática / complemento do Teams)", () => {
  it("não recria Oportunidade/Case já decididos nem reabre Skill decidida; dedup no lote", async () => {
    h.prisma.opportunity.findMany.mockResolvedValueOnce([{ title: "Expandir o projeto!" }]);
    h.prisma.case.findMany.mockResolvedValueOnce([{ title: "Case aceito" }]);
    h.prisma.skillSuggestion.findMany.mockResolvedValueOnce([{ suggestedName: "Python" }]);
    const ai = provider({
      opportunities: [
        { title: "expandir o projeto", description: "d" },
        { title: "Nova oportunidade", description: "d" },
        { title: "Nova  oportunidade.", description: "d" },
      ],
      cases: [{ title: "Case aceito", summary: "s" }, { title: "Case novo", summary: "s" }],
      skills: [{ name: "Python" }, { name: "Go" }],
    });
    const result = await runCheckpointExtraction(row, { actorUserId: null, provider: ai, preserveDecided: true });
    expect(result).toMatchObject({ status: "done", opportunities: 1, cases: 1, skills: 1 });
    expect(h.created.opportunities.map((o) => o.title)).toEqual(["Nova oportunidade"]);
    expect(h.created.cases.map((c) => c.title)).toEqual(["Case novo"]);
    expect(h.created.skills.map((k) => k.suggestedName)).toEqual(["Go"]);
    expect((h.prisma.opportunity.findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { sourceCheckpointId: "chk1", status: { not: "PENDING" } } });
  });

  it("sem a opção (Reprocessar manual da F4): comportamento original, sem consultar decididos", async () => {
    h.prisma.opportunity.findMany.mockClear();
    const ai = provider({ opportunities: [{ title: "A", description: "d" }] });
    await runCheckpointExtraction(row, { actorUserId: null, provider: ai });
    expect(h.prisma.opportunity.findMany).not.toHaveBeenCalled();
  });
});
