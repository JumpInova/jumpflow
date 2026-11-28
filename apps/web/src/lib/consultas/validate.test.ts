import { describe, expect, it } from "vitest";
import {
  aggregateRolePermissions,
  CONSULTAS_CODES,
  fullControlMatrix,
} from "@/lib/auth/permission-codes";
import { buildConsultaAccess, visibleCatalog } from "./access";
import { CONSULTA_ENTITIES } from "./catalog";
import { ConsultaError } from "./errors";
import { OPS, OPS_BY_TYPE } from "./spec";
import { validateConsulta } from "./validate";
import type { ConsultaSpec, FieldType } from "./types";

function matrix(codes: string[]) {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const PM_LIKE = buildConsultaAccess(
  matrix([CONSULTAS_CODES.module, CONSULTAS_CODES.hours, CONSULTAS_CODES.create]),
  { financial: false, sensitiveCost: false },
);
const FULL = buildConsultaAccess(fullControlMatrix(), { financial: true, sensitiveCost: true });

const base: ConsultaSpec = {
  entity: "horas",
  filters: null,
  columns: ["data", "horas"],
  groupBy: [],
  measures: [],
  sort: [],
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConsultaError ? error.code : "OTHER";
  }
  return undefined;
}

describe("permissão de entidade", () => {
  it("exige view no code da entidade", () => {
    expect(codeOf(() => validateConsulta({ ...base, entity: "alocacoes", columns: ["consultor"] }, PM_LIKE))).toBe("FORBIDDEN");
    expect(codeOf(() => validateConsulta(base, PM_LIKE))).toBeUndefined();
  });

  it("sem CONSULTAS (módulo) nenhuma entidade é liberada", () => {
    const access = buildConsultaAccess(matrix([CONSULTAS_CODES.hours]), {
      financial: true,
      sensitiveCost: true,
    });
    expect(access.entities.size).toBe(0);
    expect(codeOf(() => validateConsulta(base, access))).toBe("FORBIDDEN");
  });

  it("entidade desconhecida é INVALID", () => {
    expect(codeOf(() => validateConsulta({ ...base, entity: "usuarios" }, FULL))).toBe("INVALID");
  });
});

describe("permissão de coluna", () => {
  const financial = ["valor_hora_venda", "valor_bruto", "receita"];

  it("campo financeiro some do catálogo entregue ao cliente", () => {
    const horas = visibleCatalog(PM_LIKE).find((e) => e.key === "horas")!;
    for (const key of financial) {
      expect(horas.fields.some((f) => f.key === key)).toBe(false);
    }
    // Exemplos que citariam campo oculto também somem.
    for (const example of horas.examples) {
      expect(JSON.stringify(example.spec)).not.toMatch(/valor_|receita/);
    }
  });

  it.each([
    ["coluna", { columns: ["data", "receita"] }],
    ["filtro", { filters: { logic: "and", conditions: [{ field: "receita", op: "gt", value: 0 }] } }],
    ["agrupamento+medida", { columns: [], groupBy: [{ field: "consultor" }], measures: [{ field: "valor_bruto", agg: "sum" }] }],
    ["ordenação", { sort: [{ key: "valor_hora_venda", dir: "asc" }] }],
  ])("rejeita campo financeiro usado como %s (FORBIDDEN, não mascara)", (_label, override) => {
    expect(codeOf(() => validateConsulta({ ...base, ...override }, PM_LIKE))).toBe("FORBIDDEN");
  });

  it("com acesso financeiro, a execução é marcada para auditoria", () => {
    const access = buildConsultaAccess(
      matrix([CONSULTAS_CODES.module, CONSULTAS_CODES.hours]),
      { financial: true, sensitiveCost: false },
    );
    expect(validateConsulta({ ...base, columns: ["receita"] }, access).usesSensitive).toBe(true);
    expect(validateConsulta(base, access).usesSensitive).toBe(false);
  });

  it("custo_sensivel só com Dados Sensíveis", async () => {
    const { canSeeField } = await import("./access");
    const field = { ...CONSULTA_ENTITIES[0].fields[0], sensitivity: "custo_sensivel" as const };
    expect(canSeeField(FULL, field)).toBe(true);
    expect(
      canSeeField(
        buildConsultaAccess(fullControlMatrix(), { financial: true, sensitiveCost: false }),
        field,
      ),
    ).toBe(false);
  });
});

describe("operadores por tipo (tabela única)", () => {
  const sample: Record<FieldType, string> = {
    texto: "projeto",
    pessoa: "consultor",
    lista: "status",
    data: "data",
    numero: "",
    moeda: "receita",
    horas: "horas",
    booleano: "faturavel",
  };

  it("cada tipo tem operadores válidos e nulidade sempre permitida", () => {
    for (const [type, ops] of Object.entries(OPS_BY_TYPE)) {
      expect(ops.length, type).toBeGreaterThan(0);
      for (const op of ops) expect(OPS).toContain(op);
      expect(ops).toContain("is_null");
      expect(ops).toContain("not_null");
    }
    expect(OPS_BY_TYPE.booleano).not.toContain("gt");
    expect(OPS_BY_TYPE.lista).not.toContain("contains");
    expect(OPS_BY_TYPE.data).not.toContain("contains");
  });

  it("recusa operador fora da tabela do tipo", () => {
    for (const [type, key] of Object.entries(sample)) {
      if (!key) continue;
      for (const op of OPS) {
        if (OPS_BY_TYPE[type as FieldType].includes(op)) continue;
        const condition = { field: key, op, value: "x" };
        expect(
          codeOf(() => validateConsulta({ ...base, filters: { logic: "and", conditions: [condition] } }, FULL)),
          `${type}/${op}`,
        ).toBe("INVALID");
      }
    }
  });

  it.each([
    ["lista com valor fora das opções", { field: "status", op: "eq", value: "HACKED" }],
    ["data inválida", { field: "data", op: "eq", value: "2026-02-30" }],
    ["número como texto", { field: "horas", op: "gt", value: "8" }],
    ["booleano como texto", { field: "faturavel", op: "eq", value: "true" }],
    ["between com um valor", { field: "horas", op: "between", value: [1] }],
    ["in vazio", { field: "status", op: "in", value: [] }],
    ["is_null com valor", { field: "descricao", op: "is_null", value: "x" }],
    ["contains vazio", { field: "projeto", op: "contains", value: "  " }],
  ])("recusa %s", (_label, condition) => {
    expect(
      codeOf(() => validateConsulta({ ...base, filters: { logic: "and", conditions: [condition] } }, FULL)),
    ).toBe("INVALID");
  });

  it("aceita datas relativas", () => {
    const condition = { field: "data", op: "gte", value: { relative: "inicio_semana", offsetDays: -7 } };
    expect(codeOf(() => validateConsulta({ ...base, filters: { logic: "and", conditions: [condition] } }, FULL))).toBeUndefined();
  });
});

describe("regras de forma", () => {
  it("sem colunas e sem agrupamento usa as colunas padrão visíveis", () => {
    const { spec } = validateConsulta({ ...base, columns: [] }, PM_LIKE);
    expect(spec.columns).toEqual(CONSULTA_ENTITIES[0].defaultColumns);
  });

  it("agrupamento exige medida, campo agrupável e granularidade só em data", () => {
    expect(codeOf(() => validateConsulta({ ...base, groupBy: [{ field: "consultor" }] }, FULL))).toBe("INVALID");
    expect(
      codeOf(() => validateConsulta({ ...base, groupBy: [{ field: "horas" }], measures: [{ field: "horas", agg: "sum" }] }, FULL)),
    ).toBe("INVALID");
    expect(
      codeOf(() =>
        validateConsulta(
          { ...base, groupBy: [{ field: "consultor", granularity: "mes" }], measures: [{ field: "horas", agg: "sum" }] },
          FULL,
        ),
      ),
    ).toBe("INVALID");
    expect(
      codeOf(() =>
        validateConsulta(
          { ...base, groupBy: [{ field: "consultor" }, { field: "projeto" }, { field: "cliente" }], measures: [{ field: "horas", agg: "sum" }] },
          FULL,
        ),
      ),
    ).toBe("INVALID");
  });

  it("agregação precisa estar no catálogo do campo (count vale para todos)", () => {
    const grouped = { ...base, groupBy: [{ field: "projeto" }] };
    expect(codeOf(() => validateConsulta({ ...grouped, measures: [{ field: "consultor", agg: "sum" }] }, FULL))).toBe("INVALID");
    expect(codeOf(() => validateConsulta({ ...grouped, measures: [{ field: "consultor", agg: "count" }] }, FULL))).toBeUndefined();
  });

  it("ordenação só pelo que está no resultado", () => {
    expect(codeOf(() => validateConsulta({ ...base, sort: [{ key: "projeto", dir: "asc" }] }, FULL))).toBe("INVALID");
    expect(codeOf(() => validateConsulta({ ...base, sort: [{ key: "horas", dir: "desc" }] }, FULL))).toBeUndefined();
  });
});
