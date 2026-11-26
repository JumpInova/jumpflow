import { describe, expect, it } from "vitest";
import {
  aggregateRolePermissions,
  CONSULTAS_CODES,
  fullControlMatrix,
} from "@/lib/auth/permission-codes";
import { buildConsultaAccess, visibleCatalog } from "./access";
import { CONSULTA_ENTITIES, fieldAggregations } from "./catalog";
import { compileConsulta, scopeSql, type RowScope } from "./compile";
import { resolveRelativeDate } from "./dates";
import { ConsultaError } from "./errors";
import { OPS_BY_TYPE, SPEC_LIMITS } from "./spec";
import { validateConsulta } from "./validate";
import type {
  Condition,
  ConsultaEntity,
  ConsultaField,
  ConsultaSpec,
  Op,
  Value,
} from "./types";

/**
 * Testes de segurança do compilador e da validação (Fase C1, testador):
 * varredura exaustiva catálogo × operador × escopo, para que um campo/entidade
 * novo no catálogo herde a mesma cobertura sem teste escrito à mão.
 */

const FULL = buildConsultaAccess(fullControlMatrix(), {
  financial: true,
  sensitiveCost: true,
});
const NO_FINANCE = buildConsultaAccess(fullControlMatrix(), {
  financial: false,
  sensitiveCost: false,
});
const NOW = new Date("2026-11-25T13:00:00.000Z");
const EVIL = `x'); DROP TABLE "User"; SELECT pg_sleep(10); --`;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConsultaError ? error.code : "OTHER";
  }
  return undefined;
}

function scalar(field: ConsultaField, n = 0): Value {
  switch (field.type) {
    case "texto":
    case "pessoa":
      return `${EVIL}${n}`;
    case "lista":
      return field.options![n % field.options!.length].value;
    case "data":
      return n === 0 ? "2026-01-01" : "2026-02-01";
    case "booleano":
      return n === 0;
    default:
      return n + 1;
  }
}

function conditionFor(field: ConsultaField, op: Op): Condition {
  if (op === "is_null" || op === "not_null") return { field: field.key, op };
  if (op === "in" || op === "nin") {
    return { field: field.key, op, value: [scalar(field, 0), scalar(field, 1)] };
  }
  if (op === "between") {
    return { field: field.key, op, value: [scalar(field, 0), scalar(field, 1)] };
  }
  return { field: field.key, op, value: scalar(field, 0) };
}

function baseSpec(entity: ConsultaEntity, partial: Partial<ConsultaSpec> = {}): ConsultaSpec {
  return {
    entity: entity.key,
    filters: null,
    columns: [entity.fields[0].key],
    groupBy: [],
    measures: [],
    sort: [],
    ...partial,
  };
}

/** Identificadores entre aspas permitidos no SQL gerado para a entidade. */
function allowedIdentifiers(entity: ConsultaEntity): Set<string> {
  const allowed = new Set<string>([
    entity.view,
    "id",
    "consultant_id",
    "project_manager_id",
    "project_manager_ids",
    "_detail",
    "total",
    "grupos",
    ...entity.fields.map((f) => f.column),
  ]);
  if (entity.financeStatusColumn) allowed.add(entity.financeStatusColumn);
  if (entity.detail) allowed.add(entity.detail.column);
  for (let i = 0; i < 50; i += 1) {
    allowed.add(`c${i}`);
    allowed.add(`g${i}`);
    allowed.add(`m${i}`);
  }
  return allowed;
}

function quotedIdentifiers(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

const SCOPES: [string, RowScope][] = [
  ["PM", { broad: false, managerUserId: "pm-1", financeHoursLimited: false }],
  ["consultor", { broad: false, ownConsultantId: "c-1", financeHoursLimited: false }],
  ["sem universo", { broad: false, financeHoursLimited: false }],
  ["financeiro", { broad: true, financeHoursLimited: true }],
];

describe("injeção: catálogo inteiro × operadores permitidos", () => {
  const cases: [string, ConsultaEntity, ConsultaField, Op][] = [];
  for (const entity of CONSULTA_ENTITIES) {
    for (const field of entity.fields) {
      for (const op of OPS_BY_TYPE[field.type]) {
        cases.push([`${entity.key}.${field.key} ${op}`, entity, field, op]);
      }
    }
  }

  it.each(cases)("%s: valores só como parâmetro e identificadores só do catálogo", (_l, entity, field, op) => {
    const raw = baseSpec(entity, {
      filters: { logic: "and", conditions: [conditionFor(field, op)] },
    });
    const { spec } = validateConsulta(raw, FULL);
    const compiled = compileConsulta(entity, spec, SCOPES[0][1], NOW);
    const allowed = allowedIdentifiers(entity);
    for (const sql of [compiled.rows(0, 100), compiled.count]) {
      expect(sql.text).not.toContain("DROP");
      expect(sql.text).not.toContain("pg_sleep");
      for (const id of quotedIdentifiers(sql.text)) {
        expect(allowed.has(id), `identificador inesperado ${id}`).toBe(true);
      }
      // Toda string do usuário chega como parâmetro.
      if ((field.type === "texto" || field.type === "pessoa") && op !== "is_null" && op !== "not_null") {
        expect(
          sql.values.some((v) => typeof v === "string" && v.includes("DROP TABLE")),
        ).toBe(true);
      }
    }
  });

  it("agrupamento + medidas em todos os campos agrupáveis/agregáveis também só usam identificadores do catálogo", () => {
    for (const entity of CONSULTA_ENTITIES) {
      const allowed = allowedIdentifiers(entity);
      for (const field of entity.fields.filter((f) => f.groupable)) {
        const measures = entity.fields
          .flatMap((f) => fieldAggregations(f).map((agg) => ({ field: f.key, agg })))
          .slice(0, SPEC_LIMITS.measures);
        const { spec } = validateConsulta(
          baseSpec(entity, {
            columns: [],
            groupBy: [{ field: field.key, ...(field.type === "data" ? { granularity: "semana" as const } : {}) }],
            measures,
          }),
          FULL,
        );
        const compiled = compileConsulta(entity, spec, SCOPES[0][1], NOW);
        for (const sql of [compiled.rows(0, 100), compiled.count, compiled.totals!]) {
          for (const id of quotedIdentifiers(sql.text)) {
            expect(allowed.has(id), `${entity.key}: ${id}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("escopo de linha: sempre o 1º termo do WHERE, em todas as consultas geradas", () => {
  const cases: [string, ConsultaEntity, RowScope][] = [];
  for (const entity of CONSULTA_ENTITIES) {
    for (const [label, scope] of SCOPES) cases.push([`${entity.key} / ${label}`, entity, scope]);
  }

  it.each(cases)("%s", (_l, entity, scope) => {
    const scopeText = scopeSql(entity, scope).text;
    const numeric = entity.fields.find((f) => fieldAggregations(f).includes("sum"));
    const groupable = entity.fields.find((f) => f.groupable)!;
    const textField = entity.fields.find((f) => f.type === "texto" || f.type === "pessoa")!;
    // Filtro OR "sempre verdadeiro" do usuário: não pode escapar o escopo.
    const filters: ConsultaSpec["filters"] = {
      logic: "or",
      conditions: [
        { field: textField.key, op: "not_null" },
        { field: textField.key, op: "is_null" },
        { field: textField.key, op: "contains", value: "' OR 1=1 --" },
      ],
    };
    const measures = numeric ? [{ field: numeric.key, agg: "sum" as const }] : [{ field: groupable.key, agg: "count" as const }];
    const flat = compileConsulta(entity, validateConsulta(baseSpec(entity, { filters, measures }), FULL).spec, scope, NOW);
    const grouped = compileConsulta(
      entity,
      validateConsulta(baseSpec(entity, { filters, columns: [], groupBy: [{ field: groupable.key }], measures }), FULL).spec,
      scope,
      NOW,
    );
    const all = [flat.rows(0, 100), flat.count, flat.totals!, grouped.rows(0, 100), grouped.count, grouped.totals!];
    for (const sql of all) {
      expect(sql.text).toContain(`WHERE (${scopeText}) AND ((`);
      // Um único WHERE: nada é concatenado depois que poderia anular o escopo.
      expect(sql.text.match(/WHERE/g)).toHaveLength(1);
      // `amplo`: fora do escopo amplo nada aparece; `projeto`: o escopo
      // "próprio consultor" não alcança linha de projeto.
      const closed =
        (!scope.broad && entity.scope === "amplo") ||
        (!scope.broad && !scope.managerUserId && (!scope.ownConsultantId || entity.scope === "projeto"));
      if (closed) {
        expect(sql.text).toContain("WHERE (FALSE) AND");
      } else {
        if (scope.managerUserId) expect(sql.values[0]).toBe("pm-1");
        if (scope.ownConsultantId) expect(sql.values[0]).toBe("c-1");
      }
    }
  });

  it("PM sem User.id resolvido (managerUserId vazio) cai em FALSE, nunca em escopo amplo", () => {
    for (const entity of CONSULTA_ENTITIES) {
      expect(scopeSql(entity, { broad: false, managerUserId: "", financeHoursLimited: false }).text).toBe("FALSE");
    }
  });

  it("Financeiro: filtro do usuário por status não-aprovado não remove o recorte APPROVED/CLOSED", () => {
    const horas = CONSULTA_ENTITIES.find((e) => e.key === "horas")!;
    const { spec } = validateConsulta(
      baseSpec(horas, {
        filters: {
          logic: "or",
          conditions: [
            { field: "status", op: "eq", value: "DRAFT" },
            { field: "status", op: "eq", value: "SUBMITTED" },
          ],
        },
      }),
      FULL,
    );
    const text = compileConsulta(horas, spec, { broad: true, financeHoursLimited: true }, NOW).count.text;
    expect(text).toContain(`WHERE ("status" IN ('APPROVED', 'CLOSED')) AND ((`);
  });
});

describe("coluna sem permissão: FORBIDDEN em qualquer posição, para todo campo não público", () => {
  const cases: [string, ConsultaEntity, Partial<ConsultaSpec>][] = [];
  for (const entity of CONSULTA_ENTITIES) {
    const pub = entity.fields.find((f) => f.sensitivity === "publico" && f.groupable)!;
    for (const field of entity.fields.filter((f) => f.sensitivity !== "publico")) {
      const op = OPS_BY_TYPE[field.type].find((o) => o !== "is_null" && o !== "not_null")!;
      cases.push([`${entity.key}.${field.key} como coluna`, entity, { columns: [pub.key, field.key] }]);
      cases.push([`${entity.key}.${field.key} como filtro`, entity, { filters: { logic: "or", conditions: [conditionFor(field, op)] } }]);
      cases.push([`${entity.key}.${field.key} como filtro is_null`, entity, { filters: { logic: "and", conditions: [{ field: field.key, op: "is_null" }] } }]);
      cases.push([`${entity.key}.${field.key} como medida`, entity, { columns: [], groupBy: [{ field: pub.key }], measures: [{ field: field.key, agg: fieldAggregations(field)[0] }] }]);
      cases.push([`${entity.key}.${field.key} como medida count`, entity, { measures: [{ field: field.key, agg: "count" }] }]);
      cases.push([`${entity.key}.${field.key} como ordenação`, entity, { sort: [{ key: field.key, dir: "desc" }] }]);
      if (field.groupable) {
        cases.push([`${entity.key}.${field.key} como agrupamento`, entity, { columns: [], groupBy: [{ field: field.key }], measures: [{ field: pub.key, agg: "count" }] }]);
      }
    }
  }

  it("há campos financeiros no catálogo para exercitar", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("%s", (label, entity, partial) => {
    expect(codeOf(() => validateConsulta(baseSpec(entity, partial), NO_FINANCE))).toBe("FORBIDDEN");
    // Com permissão, a mesma spec é válida (o 403 é por permissão, não por forma).
    // Ordenação por campo fora do resultado é INVALID mesmo com permissão: o
    // importante é que, sem permissão, o 403 vem ANTES (não vaza a existência).
    const expected = label.endsWith("ordenação") ? "INVALID" : undefined;
    expect(codeOf(() => validateConsulta(baseSpec(entity, partial), FULL))).toBe(expected);
  });

  it("catálogo sem finanças não cita nenhum campo financeiro (campos, colunas padrão, exemplos)", () => {
    const visible = visibleCatalog(NO_FINANCE);
    for (const entity of visible) {
      const hidden = CONSULTA_ENTITIES.find((e) => e.key === entity.key)!
        .fields.filter((f) => f.sensitivity !== "publico")
        .map((f) => f.key);
      const blob = JSON.stringify({
        fields: entity.fields.map((f) => f.key),
        defaultColumns: entity.defaultColumns,
        examples: entity.examples,
      });
      for (const key of hidden) expect(blob, `${entity.key}.${key}`).not.toContain(`"${key}"`);
    }
  });

  it("filtro só em campo financeiro (sem exibi-lo) marca a execução para auditoria", () => {
    const horas = CONSULTA_ENTITIES.find((e) => e.key === "horas")!;
    const validated = validateConsulta(
      baseSpec(horas, { filters: { logic: "and", conditions: [{ field: "receita", op: "gt", value: 0 }] } }),
      FULL,
    );
    expect(validated.usesSensitive).toBe(true);
  });
});

describe("permissão de entidade e módulo", () => {
  function access(codes: string[], financial = false) {
    return buildConsultaAccess(
      aggregateRolePermissions(
        codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
      ),
      { financial, sensitiveCost: false },
    );
  }

  it("cada entidade exige o próprio code (code de outra entidade não serve)", () => {
    for (const entity of CONSULTA_ENTITIES) {
      // Entidades irmãs (ex.: Skills e Certificados) dividem o mesmo code.
      const others = CONSULTA_ENTITIES.filter((e) => e.permissionCode !== entity.permissionCode).map(
        (e) => e.permissionCode,
      );
      const a = access([CONSULTAS_CODES.module, CONSULTAS_CODES.create, ...others]);
      expect(codeOf(() => validateConsulta(baseSpec(entity), a)), entity.key).toBe("FORBIDDEN");
      expect(visibleCatalog(a).some((e) => e.key === entity.key)).toBe(false);
    }
  });

  it("canCreate/canEdit sem canView não liberam entidade, criação nem exportação", () => {
    const a = buildConsultaAccess(
      aggregateRolePermissions(
        [CONSULTAS_CODES.module, CONSULTAS_CODES.hours, CONSULTAS_CODES.create, CONSULTAS_CODES.export].map(
          (code) => ({ code, canView: false, canCreate: true, canEdit: true, canDelete: true }),
        ),
      ),
      { financial: true, sensitiveCost: true },
    );
    expect(a.module).toBe(false);
    expect(a.create).toBe(false);
    expect(a.export).toBe(false);
    expect(a.entities.size).toBe(0);
  });

  it("CONSULTAS_CRIAR/EXPORTAR sem o módulo CONSULTAS não valem", () => {
    const a = access([CONSULTAS_CODES.hours, CONSULTAS_CODES.create, CONSULTAS_CODES.export]);
    expect(a.create).toBe(false);
    expect(a.export).toBe(false);
  });
});

describe("spec malformada ou maliciosa → INVALID (nunca chega ao compilador)", () => {
  const horas = CONSULTA_ENTITIES.find((e) => e.key === "horas")!;
  const cond = (condition: unknown) => ({ filters: { logic: "and", conditions: [condition] } });

  it.each([
    ["entidade herdada do Object.prototype", { entity: "constructor" }],
    ["entidade toString", { entity: "tostring" }],
    ["entidade __proto__", { entity: "__proto__" }],
    ["campo constructor", { columns: ["constructor"] }],
    ["campo __proto__", { columns: ["__proto__"] }],
    ["campo com aspas", { columns: ['data"'] }],
    ["campo com espaço/maiúscula", { columns: ["Data Hora"] }],
    ["chave longa demais", { columns: ["a".repeat(65)] }],
    ["valor objeto não relativo", cond({ field: "consultor", op: "eq", value: { raw: "1=1" } })],
    ["data relativa desconhecida", cond({ field: "data", op: "eq", value: { relative: "ontem" } })],
    ["data relativa com chave extra", cond({ field: "data", op: "eq", value: { relative: "hoje", sql: "now()" } })],
    ["offset fracionado", cond({ field: "data", op: "eq", value: { relative: "hoje", offsetDays: 1.5 } })],
    ["offset além do teto", cond({ field: "data", op: "eq", value: { relative: "hoje", offsetDays: SPEC_LIMITS.offsetDays + 1 } })],
    ["array aninhado", cond({ field: "status", op: "in", value: [["APPROVED"]] })],
    ["texto em campo numérico", cond({ field: "horas", op: "gt", value: "1; DROP TABLE x" })],
    ["número em campo texto", cond({ field: "consultor", op: "eq", value: 1 })],
    ["string 'true' em booleano", cond({ field: "faturavel", op: "eq", value: "true" })],
    ["data com SQL", cond({ field: "data", op: "eq", value: "2026-01-01'; --" })],
    ["data inexistente", cond({ field: "data", op: "eq", value: "2026-02-30" })],
    ["valor de lista fora das opções", cond({ field: "status", op: "eq", value: "APPROVED' OR '1'='1" })],
    ["lista com in fora das opções", cond({ field: "status", op: "in", value: ["APPROVED", "HACK"] })],
    ["contains só com espaços", cond({ field: "consultor", op: "contains", value: "   " })],
    ["contains em lista", cond({ field: "status", op: "contains", value: "APP" })],
    ["gt em texto", cond({ field: "consultor", op: "gt", value: "a" })],
    ["between com 3 valores", cond({ field: "horas", op: "between", value: [1, 2, 3] })],
    ["between escalar", cond({ field: "horas", op: "between", value: 1 })],
    ["in vazio", cond({ field: "status", op: "in", value: [] })],
    ["in escalar", cond({ field: "status", op: "in", value: "APPROVED" })],
    ["is_null com valor", cond({ field: "descricao", op: "is_null", value: "x" })],
    ["eq sem valor", cond({ field: "consultor", op: "eq" })],
    ["string acima do limite", cond({ field: "consultor", op: "eq", value: "x".repeat(SPEC_LIMITS.stringLength + 1) })],
    ["valores demais", cond({ field: "horas", op: "in", value: Array.from({ length: SPEC_LIMITS.values + 1 }, (_, i) => i) })],
    ["condição com chave extra", cond({ field: "consultor", op: "eq", value: "a", raw: "1=1" })],
    ["condições demais", { filters: { logic: "and", conditions: Array.from({ length: SPEC_LIMITS.conditions + 1 }, () => ({ field: "horas", op: "gt", value: 1 })) } }],
    ["lógica inventada", { filters: { logic: "and not", conditions: [] } }],
    ["três agrupamentos", { columns: [], groupBy: [{ field: "consultor" }, { field: "projeto" }, { field: "cliente" }], measures: [{ field: "horas", agg: "sum" }] }],
    ["quatro ordenações", { sort: [1, 2, 3, 4].map(() => ({ key: "data", dir: "asc" })) }],
    ["limite zero", { limit: 0 }],
    ["limite fracionado", { limit: 1.5 }],
    ["ordenação por medida inexistente no resultado", { sort: [{ key: "sum:horas", dir: "asc" }] }],
    ["coluna repetida", { columns: ["data", "data"] }],
  ])("%s", (_label, partial) => {
    expect(codeOf(() => validateConsulta({ ...baseSpec(horas), columns: ["data", "horas"], ...partial }, FULL))).toBe("INVALID");
  });

  it("chave __proto__ vinda de JSON não injeta propriedades nem passa pela validação", () => {
    const raw = JSON.parse(
      '{"entity":"horas","filters":null,"columns":["data"],"groupBy":[],"measures":[],"sort":[],"__proto__":{"sql":"SELECT 1"}}',
    );
    const code = codeOf(() => validateConsulta(raw, FULL));
    if (code === undefined) {
      const { spec } = validateConsulta(raw, FULL);
      expect(Object.keys(spec)).not.toContain("__proto__");
      expect((spec as unknown as Record<string, unknown>).sql).toBeUndefined();
    } else {
      expect(code).toBe("INVALID");
    }
    expect(({} as Record<string, unknown>).sql).toBeUndefined();
  });

  it("entrada não-objeto é INVALID", () => {
    for (const raw of [null, undefined, "SELECT 1", 42, [], { entity: "horas" }]) {
      expect(codeOf(() => validateConsulta(raw, FULL))).toBe("INVALID");
    }
  });
});

describe("datas relativas: bordas de fuso (America/Sao_Paulo)", () => {
  it("domingo 22h em SP (segunda em UTC): início da semana é a segunda anterior", () => {
    const now = new Date("2026-11-30T01:00:00.000Z"); // dom 29/11 22:00 em SP
    expect(resolveRelativeDate({ relative: "hoje" }, now)).toBe("2026-11-29");
    expect(resolveRelativeDate({ relative: "inicio_semana" }, now)).toBe("2026-11-23");
  });

  it("noite do último dia do mês em SP (já dia 1 em UTC): início do mês é o do mês de SP", () => {
    const now = new Date("2026-12-01T02:00:00.000Z"); // 30/11 23:00 em SP
    expect(resolveRelativeDate({ relative: "inicio_mes" }, now)).toBe("2026-11-01");
    expect(resolveRelativeDate({ relative: "inicio_mes", offsetDays: -1 }, now)).toBe("2026-10-31");
  });

  it("virada de ano em SP", () => {
    const now = new Date("2027-01-01T02:59:00.000Z"); // 31/12/2026 23:59 em SP
    expect(resolveRelativeDate({ relative: "hoje" }, now)).toBe("2026-12-31");
    expect(resolveRelativeDate({ relative: "hoje", offsetDays: 1 }, now)).toBe("2027-01-01");
  });
});
