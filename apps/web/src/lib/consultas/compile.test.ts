import { describe, expect, it } from "vitest";
import { fullControlMatrix } from "@/lib/auth/permission-codes";
import { buildConsultaAccess } from "./access";
import { getEntity } from "./catalog";
import { compileConsulta, escapeLike, ident, scopeSql, type RowScope } from "./compile";
import { ConsultaError } from "./errors";
import { validateConsulta } from "./validate";
import type { ConsultaSpec } from "./types";

const FULL = buildConsultaAccess(fullControlMatrix(), {
  financial: true,
  sensitiveCost: true,
});
const BROAD: RowScope = { broad: true, financeHoursLimited: false };
// Quarta-feira, 2026-11-25 10:00 em São Paulo (13:00 UTC).
const NOW = new Date("2026-11-25T13:00:00.000Z");

function compile(raw: unknown, scope: RowScope = BROAD) {
  const { entity, spec } = validateConsulta(raw, FULL);
  return compileConsulta(entity, spec, scope, NOW);
}

function spec(partial: Partial<ConsultaSpec>): ConsultaSpec {
  return {
    entity: "horas",
    filters: null,
    columns: ["data", "consultor", "horas"],
    groupBy: [],
    measures: [],
    sort: [],
    ...partial,
  };
}

describe("ident", () => {
  it("aceita só identificadores da allow-list", () => {
    expect(ident("consulta_horas").text).toBe('"consulta_horas"');
    for (const bad of ['x"; DROP TABLE "User"; --', "Horas", "a b", "a-b", "", "1abc"]) {
      expect(() => ident(bad)).toThrow();
    }
  });
});

describe("compileConsulta — lista de registros", () => {
  it("seleciona as colunas do catálogo com aliases fixos e escopo antes dos filtros", () => {
    const compiled = compile(
      spec({
        filters: {
          logic: "or",
          conditions: [
            { field: "status", op: "eq", value: "APPROVED" },
            { field: "horas", op: "gt", value: 4 },
          ],
        },
        sort: [{ key: "data", dir: "desc" }],
      }),
      { broad: false, managerUserId: "pm-1", financeHoursLimited: false },
    );
    const sql = compiled.rows(0, 100);
    expect(sql.text).toContain('FROM "consulta_horas"');
    expect(sql.text).toContain('"data" AS "c0"');
    expect(sql.text).toContain('"consultor" AS "c1"');
    expect(sql.text).toContain('"consultant_id" AS "_detail"');
    // Escopo é o primeiro termo e o OR do usuário fica entre parênteses.
    expect(sql.text).toMatch(
      /WHERE \("project_manager_id" = \$1\) AND \(\(.+\) OR \(.+\)\)/,
    );
    expect(sql.text).toContain('ORDER BY "c0" DESC NULLS LAST, "id" ASC');
    expect(sql.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+$/);
    expect(sql.values).toEqual(["pm-1", "APPROVED", 4, 100, 0]);
    expect(compiled.count.text).toContain('SELECT CAST(COUNT(*) AS integer) AS "total" FROM "consulta_horas"');
    expect(compiled.totals).toBeNull();
  });

  it("medidas sem agrupamento viram uma linha de totais agregada no Postgres", () => {
    const compiled = compile(spec({ measures: [{ field: "horas", agg: "sum" }] }));
    expect(compiled.totals?.text).toBe(
      'SELECT SUM("horas") AS "m0" FROM "consulta_horas" WHERE (TRUE)',
    );
    expect(compiled.columns.map((c) => c.key)).toEqual(["data", "consultor", "horas"]);
  });
});

describe("compileConsulta — agrupamento", () => {
  it("agrupa no Postgres com granularidade de data e ordena por medida", () => {
    const compiled = compile(
      spec({
        columns: [],
        groupBy: [{ field: "consultor" }, { field: "data", granularity: "mes" }],
        measures: [{ field: "horas", agg: "sum" }, { field: "valor_hora_venda", agg: "avg" }],
        sort: [{ key: "sum:horas", dir: "desc" }],
      }),
    );
    const sql = compiled.rows(100, 100).text;
    expect(sql).toContain('"consultor" AS "g0"');
    expect(sql).toContain(`CAST(date_trunc('month', "data") AS date) AS "g1"`);
    expect(sql).toContain('SUM("horas") AS "m0"');
    expect(sql).toContain('AVG("valor_hora_venda") AS "m1"');
    expect(sql).toContain("GROUP BY 1, 2");
    expect(sql).toContain('ORDER BY "m0" DESC NULLS LAST, 1, 2');
    expect(compiled.count.text).toContain("FROM (SELECT 1 FROM");
    expect(compiled.columns.map((c) => c.key)).toEqual([
      "consultor",
      "data",
      "sum:horas",
      "avg:valor_hora_venda",
    ]);
    expect(compiled.detail).toBeUndefined();
  });
});

describe("operadores → SQL parametrizado", () => {
  const cases: [ConsultaSpec["filters"], RegExp, unknown[]][] = [
    [{ logic: "and", conditions: [{ field: "status", op: "neq", value: "DRAFT" }] }, /"status" IS DISTINCT FROM CAST\(\$1 AS text\)/, ["DRAFT"]],
    [{ logic: "and", conditions: [{ field: "status", op: "in", value: ["APPROVED", "CLOSED"] }] }, /"status" IN \(CAST\(\$1 AS text\),CAST\(\$2 AS text\)\)/, ["APPROVED", "CLOSED"]],
    [{ logic: "and", conditions: [{ field: "status", op: "nin", value: ["DRAFT"] }] }, /\("status" IS NULL OR "status" NOT IN \(CAST\(\$1 AS text\)\)\)/, ["DRAFT"]],
    [{ logic: "and", conditions: [{ field: "horas", op: "between", value: [1, 8] }] }, /"horas" BETWEEN CAST\(\$1 AS numeric\) AND CAST\(\$2 AS numeric\)/, [1, 8]],
    [{ logic: "and", conditions: [{ field: "faturavel", op: "eq", value: false }] }, /"faturavel" = CAST\(\$1 AS boolean\)/, [false]],
    [{ logic: "and", conditions: [{ field: "descricao", op: "is_null" }] }, /"descricao" IS NULL/, []],
    [{ logic: "and", conditions: [{ field: "data", op: "gte", value: "2026-11-01" }] }, /CAST\("data" AS date\) >= CAST\(\$1 AS date\)/, ["2026-11-01"]],
  ];
  it.each(cases)("%#", (filters, pattern, values) => {
    const sql = compile(spec({ filters })).count;
    expect(sql.text).toMatch(pattern);
    expect(sql.values).toEqual(values);
  });

  it("resolve datas relativas no fuso de São Paulo", () => {
    const sql = compile(
      spec({
        filters: {
          logic: "and",
          conditions: [
            {
              field: "data",
              op: "between",
              value: [{ relative: "inicio_mes" }, { relative: "hoje", offsetDays: -1 }],
            },
          ],
        },
      }),
    ).count;
    expect(sql.values).toEqual(["2026-11-01", "2026-11-24"]);
  });
});

describe("tentativas de injeção", () => {
  it("valor malicioso vira parâmetro, nunca SQL", () => {
    const evil = `x'); DROP TABLE "User"; --`;
    const sql = compile(
      spec({
        filters: { logic: "and", conditions: [{ field: "consultor", op: "eq", value: evil }] },
      }),
    ).rows(0, 100);
    expect(sql.text).not.toContain("DROP");
    expect(sql.values).toContain(evil);
  });

  it("contains escapa curingas do LIKE e parametriza", () => {
    const sql = compile(
      spec({
        filters: { logic: "and", conditions: [{ field: "projeto", op: "contains", value: "50%_a\\b" }] },
      }),
    ).count;
    expect(sql.text).toContain(`"projeto" ILIKE $1 ESCAPE '\\'`);
    expect(sql.values).toEqual(["%50\\%\\_a\\\\b%"]);
    expect(escapeLike("a%b_c")).toBe("a\\%b\\_c");
  });

  it.each([
    ["entidade fora do catálogo", { entity: "User" }],
    ["coluna com SQL", { columns: ['data", (SELECT 1) AS "x'] }],
    ["coluna desconhecida", { columns: ["passwordHash"] }],
    ["filtro em campo inexistente", { filters: { logic: "and", conditions: [{ field: "1=1", op: "eq", value: 1 }] } }],
    ["operador inventado", { filters: { logic: "and", conditions: [{ field: "horas", op: "; DROP", value: 1 }] } }],
    ["agregação inventada", { columns: [], groupBy: [{ field: "consultor" }], measures: [{ field: "horas", agg: "pg_sleep" }] }],
    ["granularidade inventada", { columns: [], groupBy: [{ field: "data", granularity: "'; --" }], measures: [{ field: "horas", agg: "sum" }] }],
    ["ordenação por SQL", { sort: [{ key: "1; DROP TABLE x", dir: "asc" }] }],
    ["direção inventada", { sort: [{ key: "data", dir: "asc; DROP" }] }],
    ["SQL cru na spec", { sql: "SELECT 1" }],
    ["limite acima do teto", { limit: 1_000_000 }],
  ])("recusa %s", (_label, override) => {
    expect(() => compile({ ...spec({}), ...override })).toThrow(ConsultaError);
  });
});

describe("escopo de linha (§4.2)", () => {
  const horas = getEntity("horas")!;
  const consultores = getEntity("consultores")!;

  it("escopo amplo não restringe", () => {
    expect(scopeSql(horas, BROAD).text).toBe("TRUE");
  });

  it("PM: próprios projetos (coluna simples ou array)", () => {
    const pm: RowScope = { broad: false, managerUserId: "u1", financeHoursLimited: false };
    expect(scopeSql(horas, pm).text).toBe('"project_manager_id" = $1');
    expect(scopeSql(consultores, pm).text).toBe('$1 = ANY("project_manager_ids")');
  });

  it("consultor: só o próprio registro", () => {
    const own: RowScope = { broad: false, ownConsultantId: "c1", financeHoursLimited: false };
    expect(scopeSql(horas, own).text).toBe('"consultant_id" = $1');
  });

  it("sem universo: FALSE (nunca vaza tudo)", () => {
    expect(scopeSql(horas, { broad: false, financeHoursLimited: false }).text).toBe("FALSE");
  });

  it("Financeiro: horas só aprovadas/fechadas; não afeta outras entidades", () => {
    const finance: RowScope = { broad: true, financeHoursLimited: true };
    expect(scopeSql(horas, finance).text).toBe(`"status" IN ('APPROVED', 'CLOSED')`);
    expect(scopeSql(consultores, finance).text).toBe("TRUE");
  });

  it("um OR do usuário não escapa o escopo", () => {
    const sql = compile(
      spec({
        filters: {
          logic: "or",
          conditions: [
            { field: "horas", op: "gte", value: 0 },
            { field: "horas", op: "is_null" },
          ],
        },
      }),
      { broad: false, ownConsultantId: "c1", financeHoursLimited: false },
    ).count.text;
    expect(sql).toContain('WHERE ("consultant_id" = $1) AND ((');
  });
});
