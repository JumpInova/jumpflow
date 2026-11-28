import { describe, expect, it, vi } from "vitest";
import { aggregateRolePermissions, type PermissionMatrix } from "@/lib/auth/permission-codes";
import type { AiCompleteOptions, AiTextProvider } from "@/lib/ai/provider";
import { buildConsultaAccess, visibleCatalog } from "./access";
import {
  AI_FRIENDLY,
  buildPromptCatalog,
  buildSystemPrompt,
  buildUserPrompt,
  checkAiOutput,
  explainSpec,
  generateConsultaSpec,
  normalizeAiRequest,
  parseAiJson,
} from "./ai";
import { CONSULTA_ENTITIES, getEntity } from "./catalog";

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

/** PM: Horas + Projetos, sem finanças. */
const pmAccess = buildConsultaAccess(
  grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_PROJETOS", "CONSULTAS_CRIAR", "CONSULTAS_IA"),
  { financial: false, sensitiveCost: false },
);
/** Financeiro: Horas + Pagamentos com finanças. */
const finAccess = buildConsultaAccess(
  grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_PAGAMENTOS", "CONSULTAS_CRIAR", "CONSULTAS_IA"),
  { financial: true, sensitiveCost: false, financeHoursLimited: true },
);

function promptFor(access = pmAccess, request = "horas por projeto") {
  return buildUserPrompt({
    catalog: buildPromptCatalog(visibleCatalog(access)),
    request,
    today: "2026-11-26",
  });
}

function provider(...outputs: (string | null)[]) {
  const calls: { prompt: string; opts?: AiCompleteOptions }[] = [];
  const complete = vi.fn(async (prompt: string, opts?: AiCompleteOptions) => {
    calls.push({ prompt, opts });
    return outputs.length > 0 ? (outputs.shift() as string | null) : null;
  });
  const p: AiTextProvider = { complete, completeWithDocument: vi.fn(async () => null) };
  return { provider: p, complete, calls };
}

const validSpec = {
  entity: "horas",
  filters: { logic: "and", conditions: [{ field: "data", op: "gte", value: { relative: "inicio_mes" } }] },
  columns: [],
  groupBy: [{ field: "projeto" }],
  measures: [{ field: "horas", agg: "sum" }],
  sort: [{ key: "sum:horas", dir: "desc" }],
};

function run(p: AiTextProvider, access = pmAccess) {
  return generateConsultaSpec({
    provider: p,
    entities: visibleCatalog(access),
    access,
    request: "horas por projeto neste mês",
    today: "2026-11-26",
  });
}

describe("IA: catálogo do prompt (só o que o usuário vê)", () => {
  it("sem finanças: nenhum campo nem métrica financeira; entidade sem permissão fora", () => {
    const text = promptFor(pmAccess);
    const catalog = buildPromptCatalog(visibleCatalog(pmAccess));
    const keys = catalog.flatMap((entity) => entity.fields.map((field) => `${entity.key}.${field.key}`));
    expect(keys).toContain("horas.horas");
    for (const forbidden of ["horas.valor_hora_venda", "horas.valor_bruto", "horas.receita", "projetos.valor_hora_padrao", "projetos.horas_orcadas"]) {
      expect(keys).not.toContain(forbidden);
    }
    const metrics = catalog.flatMap((entity) => (entity.metrics ?? []).map((metric) => metric.label));
    expect(metrics).toContain("Horas aprovadas");
    expect(metrics).not.toContain("Receita");
    expect(catalog.map((entity) => entity.key)).toEqual(["horas", "projetos"]);
    expect(text).not.toContain('"key":"pagamentos"');
    expect(text).not.toContain('"valor_hora_venda"');
  });

  it("nunca leva nomes físicos (view, coluna, origem) nem dados", () => {
    const text = promptFor(finAccess);
    expect(text).not.toMatch(/consulta_horas|consulta_pagamentos/);
    expect(text).not.toMatch(/TimeEntry\.|ConsultantPayment|"source"|"column"|"view"|permissionCode|CONSULTAS_/);
  });

  it("nenhum nome físico (Tabela.coluna, `codigo`) em descrição/fórmula do prompt, nem para quem vê tudo", () => {
    const codes = ["CONSULTAS", ...CONSULTA_ENTITIES.map((entity) => entity.permissionCode)];
    const everything = buildConsultaAccess(grant(...codes), { financial: true, sensitiveCost: true });
    const text = JSON.stringify(buildPromptCatalog(visibleCatalog(everything)));
    expect(text.match(/\b[A-Z][a-zA-Z]+\.[a-z][a-zA-Z]+\b/g)).toBeNull();
    expect(text).not.toContain("`");
  });

  it("Financeiro vê os campos financeiros, mas não `horas_lancadas` restrito (financeRestricted)", () => {
    const catalog = buildPromptCatalog(visibleCatalog(finAccess));
    const horas = catalog.find((entity) => entity.key === "horas")!;
    expect(horas.fields.map((field) => field.key)).toContain("valor_hora_venda");
    const restricted = visibleCatalog(finAccess)
      .flatMap((entity) => entity.fields)
      .filter((field) => field.financeRestricted);
    expect(restricted).toEqual([]);
  });

  it("instruções pedem JSON (modo JSON do DeepSeek) e trazem operadores por tipo", () => {
    const system = buildSystemPrompt();
    expect(system).toMatch(/JSON/);
    expect(system).toContain("booleano: eq, neq, is_null, not_null");
    expect(system).toContain("lista: eq, neq, in, nin, is_null, not_null");
  });

  it("prompt lista todas as âncoras relativas e os exemplos de período", () => {
    const system = buildSystemPrompt();
    expect(system).toContain('"próximo mês"');
    for (const anchor of ["inicio_proximo_mes", "fim_proximo_mes", "inicio_mes_anterior", "fim_mes_anterior", "fim_mes", "inicio_ano", "inicio_ano_anterior", "fim_ano_anterior"]) {
      expect(system).toContain(`"${anchor}"`);
    }
    expect(system).toContain('"mês passado"');
    expect(system).toContain('"este ano"');
    expect(system).toContain('"ano passado"');
  });

  it("prompt proíbe trocar a medida pedida por outra e manda responder fora do catálogo", () => {
    expect(buildSystemPrompt()).toMatch(/NUNCA troque o que foi pedido por outra medida/);
    expect(buildSystemPrompt()).toContain('{"error": "fora do catálogo"}');
  });

  it("exemplos do prompt só citam campos visíveis", () => {
    const catalog = buildPromptCatalog(visibleCatalog(pmAccess));
    const text = JSON.stringify(catalog.flatMap((entity) => entity.examples));
    expect(text).not.toMatch(/valor_hora|receita|valor_bruto/);
  });
});

describe("IA: validação da saída", () => {
  it("aceita JSON com cercas/prosa e normaliza pela validação do construtor", () => {
    const checked = checkAiOutput("Claro!\n```json\n" + JSON.stringify(validSpec) + "\n```", pmAccess);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.spec.groupBy).toEqual([{ field: "projeto" }]);
  });

  it("campo proibido é recusado, com mensagem genérica (não cita o campo oculto)", () => {
    const forbidden = { ...validSpec, groupBy: [], columns: ["projeto", "valor_hora_venda"], measures: [], sort: [] };
    const checked = checkAiOutput(JSON.stringify(forbidden), pmAccess);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.kind).toBe("invalid");
      expect(checked.error).not.toMatch(/Valor-hora|valor_hora/i);
    }
  });

  it("entidade sem permissão é recusada", () => {
    const checked = checkAiOutput(JSON.stringify({ ...validSpec, entity: "pagamentos" }), pmAccess);
    expect(checked.ok).toBe(false);
  });

  it("chaves extras / SQL / formato errado → inválido com o problema do Zod", () => {
    const sqlish = checkAiOutput(JSON.stringify({ ...validSpec, sql: "DROP TABLE x" }), pmAccess);
    expect(sqlish.ok).toBe(false);
    const wrongOp = checkAiOutput(
      JSON.stringify({ ...validSpec, filters: { logic: "and", conditions: [{ field: "data", op: "like", value: "x" }] } }),
      pmAccess,
    );
    expect(wrongOp.ok).toBe(false);
    if (!wrongOp.ok) expect(wrongOp.error).toMatch(/filters/);
    expect(checkAiOutput("não sei", pmAccess).ok).toBe(false);
    expect(parseAiJson("[1,2]")).toEqual([1, 2]);
    expect(checkAiOutput("[1,2]", pmAccess).ok).toBe(false);
  });

  it('{"error": ...} = pedido fora do catálogo', () => {
    const checked = checkAiOutput('{"error":"não há dados de vendas"}', pmAccess);
    expect(checked).toMatchObject({ ok: false, kind: "cannot_answer" });
  });
});

describe("IA: orquestração com provider mockado", () => {
  it("sucesso na 1ª: usa json:true + system e devolve explicação determinística", async () => {
    const { provider: p, calls } = provider(JSON.stringify(validSpec));
    const result = await run(p);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.json).toBe(true);
    expect(calls[0].opts?.system).toMatch(/JSON/);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.explanation).toEqual(explainSpec(getEntity("horas")!, result.spec));
    }
  });

  it("saída inválida → retentativa com o erro → sucesso", async () => {
    const { provider: p, calls } = provider("isto não é json", JSON.stringify(validSpec));
    const result = await run(p);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).not.toContain("foi recusada");
    expect(calls[1].prompt).toContain("A resposta anterior foi recusada: a resposta não era um objeto JSON.");
  });

  it("inválida duas vezes → desiste com mensagem amigável (sem 3ª chamada)", async () => {
    const bad = JSON.stringify({ ...validSpec, groupBy: [{ field: "inexistente" }] });
    const { provider: p, complete } = provider(bad, bad, JSON.stringify(validSpec));
    const result = await run(p);
    expect(result).toEqual({ ok: false, reason: "gave_up", message: AI_FRIENDLY.gaveUp, attempts: 2 });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("campo proibido nas duas tentativas → recusado; a retentativa não revela o campo", async () => {
    const forbidden = JSON.stringify({ ...validSpec, measures: [{ field: "receita", agg: "sum" }], sort: [] });
    const { provider: p, calls } = provider(forbidden, forbidden);
    const result = await run(p);
    expect(result).toMatchObject({ ok: false, reason: "gave_up" });
    expect(calls[1].prompt).toContain("não está no catálogo fornecido");
    expect(calls[1].prompt).not.toMatch(/"receita"|Receita/);
  });

  it("provider indisponível (null) → mensagem 'indisponível'", async () => {
    const { provider: p } = provider(null);
    expect(await run(p)).toEqual({ ok: false, reason: "unavailable", message: AI_FRIENDLY.unavailable, attempts: 1 });
  });

  it("PM pede receita (fora do catálogo dele): cannot_answer chega com mensagem fixa, sem citar o campo", async () => {
    const { provider: p, calls } = provider('{"error":"o campo receita não está no catálogo"}');
    const result = await run(p);
    expect(result).toEqual({ ok: false, reason: "cannot_answer", message: AI_FRIENDLY.cannotAnswer, attempts: 1 });
    expect(JSON.stringify(result)).not.toMatch(/receita|valor_hora/i);
    expect(calls[0].prompt).not.toContain('"receita"');
  });

  it("explicação de período com âncoras novas", () => {
    const lines = explainSpec(getEntity("horas")!, {
      entity: "horas",
      filters: { logic: "and", conditions: [{ field: "data", op: "between", value: [{ relative: "inicio_mes_anterior" }, { relative: "fim_mes_anterior" }] }] },
      columns: ["data", "horas"],
      groupBy: [],
      measures: [],
      sort: [],
    });
    expect(lines[1]).toBe("Filtros: Data entre início do mês anterior e fim do mês anterior.");
  });

  it("pedido fora do catálogo → não insiste", async () => {
    const { provider: p, complete } = provider('{"error":"sem dados"}');
    expect(await run(p)).toMatchObject({ ok: false, reason: "cannot_answer" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("IA: explicação determinística", () => {
  it("descreve filtros, agrupamento, medidas, ordenação e limite em PT-BR", () => {
    const lines = explainSpec(getEntity("horas")!, {
      entity: "horas",
      filters: {
        logic: "or",
        conditions: [
          { field: "status", op: "eq", value: "APPROVED" },
          { field: "data", op: "between", value: [{ relative: "inicio_mes", offsetDays: -30 }, "2026-11-26"] },
        ],
      },
      columns: [],
      groupBy: [{ field: "projeto" }, { field: "data", granularity: "mes" }],
      measures: [{ field: "horas", agg: "sum" }],
      sort: [{ key: "sum:horas", dir: "desc" }],
      limit: 10,
    });
    expect(lines[0]).toBe("Entidade: Horas.");
    expect(lines[1]).toContain(" OU ");
    expect(lines[1]).toContain("26/11/2026");
    expect(lines[1]).toContain("início do mês − 30 dias");
    expect(lines.join(" ")).toContain("(por mês)");
    expect(lines.join(" ")).toContain("Soma de Horas");
    expect(lines.join(" ")).toContain("(decrescente)");
    expect(lines.at(-1)).toBe("Limita a 10 grupos.");
  });

  it("pedido: normaliza espaços e respeita os limites", () => {
    expect(normalizeAiRequest("  horas   por  projeto ")).toBe("horas por projeto");
    expect(normalizeAiRequest("oi")).toBeNull();
    expect(normalizeAiRequest("x".repeat(501))).toBeNull();
    expect(normalizeAiRequest(42)).toBeNull();
  });
});
