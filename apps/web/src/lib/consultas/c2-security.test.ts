import { describe, expect, it } from "vitest";
import { aggregateRolePermissions, fullControlMatrix } from "@/lib/auth/permission-codes";
import { buildConsultaAccess, visibleCatalog } from "./access";
import { CONSULTA_ENTITIES, getEntity } from "./catalog";
import { compileConsulta, scopeSql, type RowScope } from "./compile";
import { ConsultaError } from "./errors";
import {
  MAX_PANEL_ITEMS,
  canOpenShared,
  canOpenView,
  panelInputSchema,
  parsePanelItems,
  sharingAllowed,
  specUsableBy,
  viewInputSchema,
  type Viewer,
} from "./saved";
import { validateConsulta } from "./validate";
import type { ConsultaEntity, ConsultaField, Value } from "./types";

/**
 * Fase C2 (testador): escopo de linha das entidades novas, inclusive com
 * filtro OU tentando escapar do recorte; ausência de custo/dado pessoal nas
 * entidades novas; métricas por sensibilidade; Atividade legada; regras puras
 * de visões/painéis.
 */

const FULL = buildConsultaAccess(fullControlMatrix(), { financial: true, sensitiveCost: true });
const NO_FINANCE = buildConsultaAccess(fullControlMatrix(), { financial: false, sensitiveCost: false });
const NOW = new Date("2026-11-25T13:00:00.000Z");
const EVIL = `x') OR TRUE OR ('1'='1`;

const NEW_ENTITIES = [
  "projetos",
  "aprovacoes",
  "despesas",
  "faturamento",
  "pagamentos",
  "skills",
  "certificados",
  "ausencias",
] as const;

const PM: RowScope = { broad: false, managerUserId: "pm-1", financeHoursLimited: false };
const OWN: RowScope = { broad: false, ownConsultantId: "c-1", financeHoursLimited: false };
const NONE: RowScope = { broad: false, financeHoursLimited: false };
const BROAD: RowScope = { broad: true, financeHoursLimited: false };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConsultaError ? error.code : "OTHER";
  }
  return undefined;
}

function grant(...codes: string[]) {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

function sampleValue(field: ConsultaField): Value {
  switch (field.type) {
    case "texto":
    case "pessoa":
      return EVIL;
    case "lista":
      return field.options![0].value;
    case "data":
      return "2026-01-01";
    case "booleano":
      return true;
    default:
      return 1;
  }
}

/** Spec com filtro OU de duas condições públicas (tenta "abrir" o recorte). */
function orSpec(entity: ConsultaEntity) {
  const publicFields = entity.fields.filter((f) => f.sensitivity === "publico");
  const [a, b] = publicFields;
  return {
    entity: entity.key,
    filters: {
      logic: "or",
      conditions: [
        { field: a.key, op: "eq", value: sampleValue(a) },
        { field: b.key, op: "not_null" },
      ],
    },
    columns: [a.key],
    groupBy: [],
    measures: [],
    sort: [],
  };
}

const EXPECTED_PM_SCOPE: Record<string, string> = {
  projetos: '"project_manager_id" = $1',
  faturamento: '"project_manager_id" = $1',
  aprovacoes: '"project_manager_id" = $1',
  despesas: '"project_manager_id" = $1',
  skills: '$1 = ANY("project_manager_ids")',
  certificados: '$1 = ANY("project_manager_ids")',
  ausencias: '$1 = ANY("project_manager_ids")',
  pagamentos: "FALSE",
};

const EXPECTED_OWN_SCOPE: Record<string, string> = {
  projetos: "FALSE",
  faturamento: "FALSE",
  pagamentos: "FALSE",
  aprovacoes: '"consultant_id" = $1',
  despesas: '"consultant_id" = $1',
  skills: '"consultant_id" = $1',
  certificados: '"consultant_id" = $1',
  ausencias: '"consultant_id" = $1',
};

describe("C2: escopo de linha por entidade nova (tabela do dev)", () => {
  it.each(NEW_ENTITIES)("%s: PM, próprio consultor, sem universo e amplo", (key) => {
    const entity = getEntity(key)!;
    expect(scopeSql(entity, PM).text).toBe(EXPECTED_PM_SCOPE[key]);
    expect(scopeSql(entity, OWN).text).toBe(EXPECTED_OWN_SCOPE[key]);
    expect(scopeSql(entity, NONE).text).toBe("FALSE");
    expect(scopeSql(entity, BROAD).text).toBe("TRUE");
    // PM + próprio consultor ao mesmo tempo: vale o recorte do gestor, nunca a união.
    const both = scopeSql(entity, { ...PM, ownConsultantId: "c-1" }).text;
    expect(both).toBe(EXPECTED_PM_SCOPE[key]);
  });

  it.each(NEW_ENTITIES)("%s: filtro OU nunca escapa do escopo (AND externo, valores parametrizados)", (key) => {
    const entity = getEntity(key)!;
    const { spec } = validateConsulta(orSpec(entity), FULL);
    const compiled = compileConsulta(entity, spec, PM, NOW);
    for (const sql of [compiled.rows(0, 100), compiled.count]) {
      const scope = EXPECTED_PM_SCOPE[key];
      // O escopo fica sozinho no 1º parêntese e os filtros OU num segundo, ligados por AND.
      const where = sql.text.slice(sql.text.indexOf("WHERE"));
      expect(where.startsWith(`WHERE (${scope}) AND ((`), where).toBe(true);
      expect(where).toContain(") OR (");
      expect(sql.text).not.toContain(EVIL);
      if (scope !== "FALSE") expect(sql.values[0]).toBe("pm-1");
      // Toda ocorrência de OR fica dentro do 2º parêntese (depois do AND do escopo).
      const scopeEnd = where.indexOf(") AND (");
      expect(where.slice(0, scopeEnd)).not.toContain(" OR ");
    }
  });

  it.each(NEW_ENTITIES)("%s: agregação/totais também levam o escopo", (key) => {
    const entity = getEntity(key)!;
    const groupable = entity.fields.find((f) => f.groupable && f.sensitivity === "publico")!;
    const { spec } = validateConsulta(
      {
        ...orSpec(entity),
        groupBy: [{ field: groupable.key }],
        measures: [{ field: groupable.key, agg: "count" }],
      },
      FULL,
    );
    const compiled = compileConsulta(entity, spec, PM, NOW);
    for (const sql of [compiled.rows(0, 10), compiled.count, compiled.totals!]) {
      expect(sql.text).toContain(`WHERE (${EXPECTED_PM_SCOPE[key]}) AND (`);
    }
  });

  it("filtro sobre coluna técnica de escopo não existe no catálogo (INVALID)", () => {
    for (const key of NEW_ENTITIES) {
      for (const column of ["project_manager_id", "project_manager_ids", "consultant_id"]) {
        const spec = {
          entity: key,
          filters: { logic: "or", conditions: [{ field: column, op: "not_null" }] },
          columns: [],
          groupBy: [],
          measures: [],
          sort: [],
        };
        expect(codeOf(() => validateConsulta(spec, FULL)), `${key}.${column}`).toBe("INVALID");
      }
    }
  });
});

describe("C2: nenhum custo cifrado nem dado pessoal nas entidades novas", () => {
  it("nenhuma entidade nova tem campo `custo_sensivel` nem métrica de custo/margem", () => {
    for (const key of NEW_ENTITIES) {
      const entity = getEntity(key)!;
      for (const field of entity.fields) {
        expect(field.sensitivity, `${key}.${field.key}`).not.toBe("custo_sensivel");
        expect(`${field.key} ${field.column} ${field.label}`, `${key}.${field.key}`).not.toMatch(
          /custo|margem|cost|margin/i,
        );
      }
      for (const metric of entity.metrics ?? []) {
        expect(metric.label, `${key}: ${metric.label}`).not.toMatch(/custo|margem/i);
      }
    }
  });

  it("Pagamentos: sem valor-hora/linhas, líquido CLT, valor PJ, benefícios, acordado ou dado bancário", () => {
    const pagamentos = getEntity("pagamentos")!;
    for (const field of pagamentos.fields) {
      const text = `${field.key} ${field.column} ${field.label} ${field.source}`;
      expect(text, field.key).not.toMatch(
        /valor[_ -]?hora|hourly|PaymentLine|cltNet|l[ií]quido|pjAmount|valor[_ ]pj|benef|acordad|agreed|banc|bank|pix|cpf|ad.?hoc|pontua/i,
      );
    }
    // Só os dois valores não cifrados, ambos financeiros.
    const money = pagamentos.fields.filter((f) => f.type === "moeda").map((f) => f.key).sort();
    expect(money).toEqual(["valor_nf", "valor_total"]);
    for (const key of money) {
      expect(pagamentos.fields.find((f) => f.key === key)!.sensitivity).toBe("financeiro");
    }
  });

  it("Ausências: sem comentário, observação, nota ou motivo", () => {
    for (const field of getEntity("ausencias")!.fields) {
      expect(`${field.key} ${field.column} ${field.label} ${field.source}`, field.key).not.toMatch(
        /coment|observ|\bnota\b|\bnote\b|motivo|reason|decisionComment/i,
      );
    }
  });

  it("Despesas: sem endereços de milhagem nem observação", () => {
    for (const field of getEntity("despesas")!.fields) {
      expect(`${field.key} ${field.column} ${field.source}`, field.key).not.toMatch(
        /endere|address|origem|destino|\bnote\b|observ|decisionComment/i,
      );
    }
  });

  it("Aprovações: comentário existe mas a origem exclui ausências", () => {
    const comentario = getEntity("aprovacoes")!.fields.find((f) => f.key === "comentario")!;
    expect(comentario.source).toMatch(/exceto aus[eê]ncias/i);
  });

  it("Faturamento: só valores de venda (sem custo/margem) e todos financeiros", () => {
    const faturamento = getEntity("faturamento")!;
    for (const field of faturamento.fields.filter((f) => f.type === "moeda")) {
      expect(field.sensitivity, field.key).toBe("financeiro");
    }
  });

  it("sem finanças, nenhum campo moeda de Projetos/Faturamento/Pagamentos chega ao catálogo visível", () => {
    // Despesas.valor é `publico` por decisão (mesma visibilidade do relatório de Despesas).
    for (const entity of visibleCatalog(NO_FINANCE).filter((e) =>
      ["projetos", "faturamento", "pagamentos"].includes(e.key),
    )) {
      expect(entity.fields.filter((f) => f.type === "moeda").map((f) => f.key), entity.key).toEqual([]);
    }
    for (const entity of visibleCatalog(NO_FINANCE).filter((e) =>
      (NEW_ENTITIES as readonly string[]).includes(e.key),
    )) {
      for (const example of entity.examples) {
        expect(codeOf(() => validateConsulta(example.spec, NO_FINANCE)), example.label).toBeUndefined();
      }
    }
  });
});

describe("C2: métricas filtradas por sensibilidade (ressalva 1)", () => {
  it("toda métrica cuja fórmula fala de valor/receita/orçamento é marcada financeiro", () => {
    for (const entity of CONSULTA_ENTITIES) {
      for (const metric of entity.metrics ?? []) {
        if (/receita|valor|R\$|orçamento|fatura/i.test(`${metric.label} ${metric.formula}`)) {
          expect(metric.sensitivity, `${entity.key}: ${metric.label}`).not.toBe("publico");
        }
      }
    }
  });

  it("“Receita”, “Receita faturada” e “Consumo do orçamento” somem sem finanças, por entidade", () => {
    const visible = visibleCatalog(NO_FINANCE);
    const labels = visible.flatMap((e) => (e.metrics ?? []).map((m) => m.label));
    for (const label of ["Receita", "Receita faturada", "Consumo do orçamento"]) {
      expect(labels).not.toContain(label);
    }
    // Métricas públicas continuam visíveis (não é filtro "tudo ou nada").
    const publicCount = CONSULTA_ENTITIES.flatMap((e) => e.metrics ?? []).filter(
      (m) => m.sensitivity === "publico",
    ).length;
    expect(labels.length).toBe(publicCount);
  });

  it("acesso com `financial` mas sem `sensitiveCost` não vê métrica custo_sensivel", () => {
    const fin = buildConsultaAccess(fullControlMatrix(), { financial: true, sensitiveCost: false });
    const metrics = visibleCatalog(fin).flatMap((e) => e.metrics ?? []);
    expect(metrics.some((m) => m.sensitivity === "custo_sensivel")).toBe(false);
  });
});

describe("C2: Atividade legada (ressalva 2) — aceita código, recusa lixo", () => {
  const activity = (op: string, value: unknown) => ({
    entity: "horas",
    filters: { logic: "and", conditions: [{ field: "atividade", op, value }] },
    columns: ["data"],
    groupBy: [],
    measures: [],
    sort: [],
  });

  it("aceita código legado em eq/in e o valor vai parametrizado", () => {
    const { spec } = validateConsulta(activity("in", ["LEGACY_X", "DEVELOPMENT"]), FULL);
    const compiled = compileConsulta(getEntity("horas")!, spec, BROAD, NOW).rows(0, 10);
    expect(compiled.text).not.toContain("LEGACY_X");
    expect(compiled.values).toEqual(expect.arrayContaining(["LEGACY_X", "DEVELOPMENT"]));
  });

  it.each([
    ["minúsculas", "legacy"],
    ["começa com dígito", "1ABC"],
    ["espaço", "A B"],
    ["aspas", "A'B"],
    ["hífen", "A-B"],
    ["quebra de linha", "ABC\n"],
    ["unicode", "AÇÃO"],
    ["65 caracteres", `A${"B".repeat(64)}`],
    ["número", 42],
    ["booleano", true],
    ["data relativa", { relative: "hoje" }],
    ["nulo", null],
  ])("recusa %s", (_label, bad) => {
    expect(codeOf(() => validateConsulta(activity("eq", bad), FULL))).toBe("INVALID");
    expect(codeOf(() => validateConsulta(activity("in", ["DEVELOPMENT", bad]), FULL))).toBe("INVALID");
  });

  it("64 caracteres no formato de código é o limite aceito", () => {
    expect(codeOf(() => validateConsulta(activity("eq", `A${"B".repeat(63)}`), FULL))).toBeUndefined();
  });

  it("nenhuma outra lista do catálogo é aberta (só Atividade)", () => {
    const open = CONSULTA_ENTITIES.flatMap((e) =>
      e.fields.filter((f) => f.openOptions).map((f) => `${e.key}.${f.key}`),
    );
    expect(open).toEqual(["horas.atividade"]);
  });
});

describe("C2: regras puras de visões e painéis", () => {
  const pm: Viewer = { userId: "db-pm", roles: ["PROJECT_MANAGER"] };
  const anon: Viewer = { userId: null, roles: ["PROJECT_MANAGER"] };
  const admin: Viewer = { userId: "db-admin", roles: ["ADMIN"] };

  it("PRIVATE: só o dono; ADMIN não tem override; viewer sem id nunca é dono", () => {
    const priv = { ownerId: "db-fin", sharing: "PRIVATE" as const, sharedRoles: [] };
    expect(canOpenShared(priv, admin)).toBe(false);
    expect(canOpenShared(priv, pm)).toBe(false);
    expect(canOpenShared({ ...priv, ownerId: "db-pm" }, pm)).toBe(true);
    // ownerId vazio/nulo não casa com viewer sem id.
    expect(canOpenShared({ ...priv, ownerId: "" }, anon)).toBe(false);
  });

  it("PRIVATE com sharedRoles residuais no banco continua privado", () => {
    expect(
      canOpenShared({ ownerId: "db-fin", sharing: "PRIVATE", sharedRoles: ["PROJECT_MANAGER", "ADMIN"] }, pm),
    ).toBe(false);
  });

  it("ROLES: só os papéis listados; ALL: qualquer um", () => {
    const roles = { ownerId: "db-fin", sharing: "ROLES" as const, sharedRoles: ["PEOPLE"] };
    expect(canOpenShared(roles, pm)).toBe(false);
    expect(canOpenShared(roles, admin)).toBe(false);
    expect(canOpenShared({ ...roles, sharedRoles: ["PROJECT_MANAGER"] }, pm)).toBe(true);
    expect(canOpenShared({ ...roles, sharedRoles: [] }, pm)).toBe(false);
    expect(canOpenShared({ ownerId: "x", sharing: "ALL", sharedRoles: [] }, anon)).toBe(true);
  });

  it("canOpenView exige módulo e entidade de quem vê, mesmo para o dono", () => {
    const view = { ownerId: "db-pm", sharing: "PRIVATE" as const, sharedRoles: [], entity: "pagamentos" };
    const pmAccess = buildConsultaAccess(grant("CONSULTAS", "CONSULTAS_HORAS"), { financial: false, sensitiveCost: false });
    expect(canOpenView(view, pm, pmAccess)).toBe(false);
    const noModule = buildConsultaAccess(grant("CONSULTAS_PAGAMENTOS"), { financial: true, sensitiveCost: false });
    expect(canOpenView(view, pm, noModule)).toBe(false);
  });

  it("specUsableBy: visão do Financeiro com campo financeiro é inutilizável pelo PM", () => {
    const pmAccess = buildConsultaAccess(grant("CONSULTAS", "CONSULTAS_PROJETOS"), {
      financial: false,
      sensitiveCost: false,
    });
    const spec = { entity: "projetos", filters: null, columns: ["projeto", "valor_hora_padrao"], groupBy: [], measures: [], sort: [] };
    expect(specUsableBy(spec, FULL)).toBe(true);
    expect(specUsableBy(spec, pmAccess)).toBe(false);
    // Campo financeiro escondido só no filtro também conta.
    const inFilter = {
      ...spec,
      columns: ["projeto"],
      filters: { logic: "and", conditions: [{ field: "horas_orcadas", op: "gt", value: 0 }] },
    };
    expect(specUsableBy(inFilter, pmAccess)).toBe(false);
    // Lixo no banco nunca é "utilizável".
    expect(specUsableBy(null, FULL)).toBe(false);
    expect(specUsableBy({ entity: "projetos", sql: "SELECT 1" }, FULL)).toBe(false);
  });

  it("sharingAllowed: PRIVATE sempre; ROLES/ALL só com COMPARTILHAR", () => {
    const noShare = buildConsultaAccess(grant("CONSULTAS", "CONSULTAS_CRIAR"), { financial: false, sensitiveCost: false });
    const share = buildConsultaAccess(grant("CONSULTAS", "CONSULTAS_COMPARTILHAR"), { financial: false, sensitiveCost: false });
    const shareNoModule = buildConsultaAccess(grant("CONSULTAS_COMPARTILHAR"), { financial: false, sensitiveCost: false });
    expect(sharingAllowed("PRIVATE", noShare)).toBe(true);
    expect(sharingAllowed("ROLES", noShare)).toBe(false);
    expect(sharingAllowed("ALL", noShare)).toBe(false);
    expect(sharingAllowed("ALL", share)).toBe(true);
    expect(sharingAllowed("ALL", shareNoModule)).toBe(false);
  });

  it("viewInputSchema: strict (sem ownerId/spec/entity), papéis só do enum, PRIVATE zera papéis", () => {
    const base = { name: "V", visualization: "BAR", sharing: "PRIVATE", sharedRoles: [] };
    expect(viewInputSchema.safeParse({ ...base, ownerId: "outro" }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, spec: {} }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, sharing: "ROLES", sharedRoles: ["SUPERUSER"] }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, sharing: "ROLES", sharedRoles: [] }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, sharing: "PUBLIC" }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, visualization: "barras" }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, name: "x".repeat(121) }).success).toBe(false);
    const priv = viewInputSchema.parse({ ...base, sharedRoles: ["ADMIN"] });
    expect(priv.sharedRoles).toEqual([]);
    const roles = viewInputSchema.parse({ ...base, sharing: "ROLES", sharedRoles: ["PEOPLE", "PEOPLE"] });
    expect(roles.sharedRoles).toEqual(["PEOPLE"]);
  });

  it("panelInputSchema: ≤ 24, sem repetição, itens strict e tamanho do enum", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ viewId: `v${i}` }));
    const base = { name: "P", sharing: "PRIVATE", sharedRoles: [] };
    expect(panelInputSchema.safeParse({ ...base, items: items(MAX_PANEL_ITEMS) }).success).toBe(true);
    expect(panelInputSchema.safeParse({ ...base, items: items(MAX_PANEL_ITEMS + 1) }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...base, items: [{ viewId: "a" }, { viewId: "a" }] }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...base, items: [{ viewId: "a", name: "vaza" }] }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...base, items: [{ viewId: "a", size: "gigante" }] }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...base, items: [{ viewId: "" }] }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...base, items: [{ viewId: "x".repeat(65) }] }).success).toBe(false);
  });

  it("parsePanelItems: JSON do banco é saneado (lixo descartado, ≤ 24, sem duplicata)", () => {
    expect(parsePanelItems(null)).toEqual([]);
    expect(parsePanelItems({ viewId: "a" })).toEqual([]);
    const raw = [
      { viewId: "a" },
      { viewId: "a", size: "largo" },
      { viewId: 1 },
      "b",
      { viewId: "c", extra: true },
      { viewId: "d", size: "largo" },
      ...Array.from({ length: 40 }, (_, i) => ({ viewId: `z${i}` })),
    ];
    const parsed = parsePanelItems(raw);
    expect(parsed.length).toBeLessThanOrEqual(MAX_PANEL_ITEMS);
    expect(parsed.slice(0, 2)).toEqual([
      { viewId: "a", size: "normal" },
      { viewId: "d", size: "largo" },
    ]);
    expect(new Set(parsed.map((p) => p.viewId)).size).toBe(parsed.length);
  });
});
