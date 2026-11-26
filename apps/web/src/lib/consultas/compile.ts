/**
 * Compilador spec → SQL seguro (ESPECIFICAÇÃO §4.4).
 *
 * - SQL montado SOMENTE com `Prisma.sql`/`Prisma.join`; valores sempre como
 *   parâmetros ($1, $2…).
 * - Identificadores (view e colunas) vêm EXCLUSIVAMENTE do catálogo e ainda
 *   passam por `ident()` (allow-list de caracteres) antes de virar `Prisma.raw`.
 *   Nada que o cliente digitou vira identificador: a spec só carrega CHAVES,
 *   que são resolvidas para o campo do catálogo pela validação.
 * - O escopo de linha é sempre o PRIMEIRO termo do WHERE, unido por AND aos
 *   filtros do usuário (entre parênteses), então um OR do usuário nunca o
 *   escapa.
 * - Agrupamento e agregação rodam no Postgres.
 *
 * Recebe apenas specs já validadas por `validateConsulta`.
 */
import { Prisma } from "@jumpflow/database";
import {
  AGGREGATION_LABELS,
  fieldAggregations,
  getField,
  GRANULARITY_LABELS,
} from "./catalog";
import { isRelativeDate, resolveRelativeDate } from "./dates";
import { measureKey } from "./spec";
import type {
  Aggregation,
  Condition,
  ConsultaEntity,
  ConsultaField,
  ConsultaSpec,
  FieldType,
  Granularity,
  Value,
} from "./types";

/** Escopo de linha já resolvido no servidor (espelha `ReportScope`). */
export interface RowScope {
  /** Escopo amplo: sem recorte de pessoa/projeto. */
  broad: boolean;
  /** Recorte por projetos geridos (PM): `User.id` do gestor. */
  managerUserId?: string;
  /** Recorte pelo próprio consultor. */
  ownConsultantId?: string;
  /** Financeiro: horas só APPROVED/CLOSED (mesmo recorte dos Relatórios). */
  financeHoursLimited: boolean;
}

export interface OutputColumn {
  /** Chave na linha de resultado (campo ou `agg:campo`). */
  key: string;
  label: string;
  type: FieldType;
  kind: "column" | "group" | "measure";
  field: string;
  agg?: Aggregation;
  granularity?: Granularity;
  /** Alias SQL (fixo, gerado aqui). */
  alias: string;
}

export interface CompiledConsulta {
  grouped: boolean;
  columns: OutputColumn[];
  /** Coluna técnica da página de detalhe (alias `_detail`), quando houver. */
  detail?: ConsultaEntity["detail"];
  rows: (offset: number, limit: number) => Prisma.Sql;
  count: Prisma.Sql;
  /** Totais (medidas sobre TODO o conjunto filtrado); null sem medidas. */
  totals: Prisma.Sql | null;
  /** Medidas (aliases m0…) — colunas da linha de totais. */
  measures: OutputColumn[];
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Identificador do catálogo entre aspas. Recusa qualquer coisa fora da allow-list. */
export function ident(name: string): Prisma.Sql {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Identificador inválido no catálogo: ${name}`);
  }
  return Prisma.raw(`"${name}"`);
}

const GRANULARITY_SQL: Record<Granularity, string> = {
  dia: "day",
  semana: "week",
  mes: "month",
  ano: "year",
};

const AGG_SQL: Record<Aggregation, string> = {
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
  count: "COUNT",
};

/** Escapa `\`, `%` e `_` para um ILIKE literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function param(field: ConsultaField, value: Value, now: Date): Prisma.Sql {
  switch (field.type) {
    case "data": {
      const iso = isRelativeDate(value)
        ? resolveRelativeDate(value, now)
        : String(value);
      return Prisma.sql`CAST(${iso} AS date)`;
    }
    case "numero":
    case "moeda":
    case "horas":
      return Prisma.sql`CAST(${Number(value)} AS numeric)`;
    case "booleano":
      return Prisma.sql`CAST(${Boolean(value)} AS boolean)`;
    default:
      return Prisma.sql`CAST(${String(value)} AS text)`;
  }
}

/** Expressão do campo para comparação (datas comparam pelo dia). */
function fieldExpr(field: ConsultaField): Prisma.Sql {
  const column = ident(field.column);
  return field.type === "data" ? Prisma.sql`CAST(${column} AS date)` : column;
}

function conditionSql(
  field: ConsultaField,
  condition: Condition,
  now: Date,
): Prisma.Sql {
  const expr = fieldExpr(field);
  const value = condition.value;
  const one = () => param(field, value as Value, now);
  const list = () =>
    Prisma.join((value as Value[]).map((item) => param(field, item, now)));
  switch (condition.op) {
    case "eq":
      return Prisma.sql`${expr} = ${one()}`;
    case "neq":
      return Prisma.sql`${expr} IS DISTINCT FROM ${one()}`;
    case "in":
      return Prisma.sql`${expr} IN (${list()})`;
    case "nin":
      return Prisma.sql`(${expr} IS NULL OR ${expr} NOT IN (${list()}))`;
    case "contains":
      return Prisma.sql`${ident(field.column)} ILIKE ${`%${escapeLike(String(value))}%`} ESCAPE '\\'`;
    case "gt":
      return Prisma.sql`${expr} > ${one()}`;
    case "gte":
      return Prisma.sql`${expr} >= ${one()}`;
    case "lt":
      return Prisma.sql`${expr} < ${one()}`;
    case "lte":
      return Prisma.sql`${expr} <= ${one()}`;
    case "between": {
      const [from, to] = value as Value[];
      return Prisma.sql`${expr} BETWEEN ${param(field, from, now)} AND ${param(field, to, now)}`;
    }
    case "is_null":
      return Prisma.sql`${ident(field.column)} IS NULL`;
    case "not_null":
      return Prisma.sql`${ident(field.column)} IS NOT NULL`;
  }
}

/** Escopo de linha obrigatório da entidade (§4.2). Sem universo → FALSE. */
export function scopeSql(entity: ConsultaEntity, scope: RowScope): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (!scope.broad) {
    if (scope.managerUserId) {
      parts.push(
        entity.scope === "pessoa_projetos"
          ? Prisma.sql`${scope.managerUserId} = ANY(${ident("project_manager_ids")})`
          : Prisma.sql`${ident("project_manager_id")} = ${scope.managerUserId}`,
      );
    } else if (scope.ownConsultantId) {
      parts.push(Prisma.sql`${ident("consultant_id")} = ${scope.ownConsultantId}`);
    } else {
      return Prisma.sql`FALSE`;
    }
  }
  if (scope.financeHoursLimited && entity.financeStatusColumn) {
    parts.push(
      Prisma.sql`${ident(entity.financeStatusColumn)} IN ('APPROVED', 'CLOSED')`,
    );
  }
  return parts.length > 0 ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

function whereSql(
  entity: ConsultaEntity,
  spec: ConsultaSpec,
  scope: RowScope,
  now: Date,
): Prisma.Sql {
  const scoped = scopeSql(entity, scope);
  const conditions = spec.filters?.conditions ?? [];
  if (conditions.length === 0) return Prisma.sql`WHERE (${scoped})`;
  const joiner = spec.filters?.logic === "or" ? " OR " : " AND ";
  const parts = conditions.map((condition) => {
    const field = mustField(entity, condition.field);
    return Prisma.sql`(${conditionSql(field, condition, now)})`;
  });
  return Prisma.sql`WHERE (${scoped}) AND (${Prisma.join(parts, joiner)})`;
}

function mustField(entity: ConsultaEntity, key: string): ConsultaField {
  const field = getField(entity, key);
  if (!field) throw new Error(`Campo fora do catálogo: ${key}`);
  return field;
}

function groupExpr(field: ConsultaField, granularity?: Granularity): Prisma.Sql {
  const column = ident(field.column);
  if (field.type !== "data") return column;
  const unit = GRANULARITY_SQL[granularity ?? "dia"];
  return Prisma.sql`CAST(date_trunc(${Prisma.raw(`'${unit}'`)}, ${column}) AS date)`;
}

function measureExpr(field: ConsultaField, agg: Aggregation): Prisma.Sql {
  if (!fieldAggregations(field).includes(agg)) {
    throw new Error(`Agregação fora do catálogo: ${agg}(${field.key})`);
  }
  return Prisma.sql`${Prisma.raw(AGG_SQL[agg])}(${ident(field.column)})`;
}

function orderSql(
  spec: ConsultaSpec,
  columns: OutputColumn[],
  tieBreak: Prisma.Sql,
): Prisma.Sql {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const parts: Prisma.Sql[] = [];
  for (const item of spec.sort) {
    const column = byKey.get(item.key);
    if (!column) continue;
    parts.push(
      Prisma.sql`${ident(column.alias)} ${Prisma.raw(item.dir === "desc" ? "DESC NULLS LAST" : "ASC NULLS LAST")}`,
    );
  }
  parts.push(tieBreak);
  return Prisma.sql`ORDER BY ${Prisma.join(parts, ", ")}`;
}

/** Compila uma spec VALIDADA para as três consultas da tela/exportação. */
export function compileConsulta(
  entity: ConsultaEntity,
  spec: ConsultaSpec,
  scope: RowScope,
  now: Date = new Date(),
): CompiledConsulta {
  const view = ident(entity.view);
  const where = whereSql(entity, spec, scope, now);
  const grouped = spec.groupBy.length > 0;

  const measures: OutputColumn[] = spec.measures.map((measure, index) => {
    const field = mustField(entity, measure.field);
    return {
      key: measureKey(measure),
      label: `${AGGREGATION_LABELS[measure.agg]} de ${field.label}`,
      type: measure.agg === "count" ? "numero" : field.type,
      kind: "measure",
      field: field.key,
      agg: measure.agg,
      alias: `m${index}`,
    };
  });
  const measureSelect = spec.measures.map((measure, index) =>
    Prisma.sql`${measureExpr(mustField(entity, measure.field), measure.agg)} AS ${ident(`m${index}`)}`,
  );
  const totals =
    measureSelect.length > 0
      ? Prisma.sql`SELECT ${Prisma.join(measureSelect)} FROM ${view} ${where}`
      : null;

  if (grouped) {
    const groups: OutputColumn[] = spec.groupBy.map((group, index) => {
      const field = mustField(entity, group.field);
      return {
        key: field.key,
        label:
          field.type === "data"
            ? `${field.label} (${GRANULARITY_LABELS[group.granularity ?? "dia"]})`
            : field.label,
        type: field.type,
        kind: "group",
        field: field.key,
        ...(field.type === "data"
          ? { granularity: group.granularity ?? "dia" }
          : {}),
        alias: `g${index}`,
      };
    });
    const groupExprs = spec.groupBy.map((group) =>
      groupExpr(mustField(entity, group.field), group.granularity),
    );
    const groupSelect = groupExprs.map(
      (expr, index) => Prisma.sql`${expr} AS ${ident(`g${index}`)}`,
    );
    const positions = Prisma.raw(
      spec.groupBy.map((_, index) => String(index + 1)).join(", "),
    );
    const columns = [...groups, ...measures];
    const order = orderSql(spec, columns, positions);
    return {
      grouped: true,
      columns,
      rows: (offset, limit) =>
        Prisma.sql`SELECT ${Prisma.join([...groupSelect, ...measureSelect])} FROM ${view} ${where} GROUP BY ${positions} ${order} LIMIT ${limit} OFFSET ${offset}`,
      count: Prisma.sql`SELECT CAST(COUNT(*) AS integer) AS "total" FROM (SELECT 1 FROM ${view} ${where} GROUP BY ${Prisma.join(groupExprs)}) AS "grupos"`,
      totals,
      measures,
    };
  }

  const columns: OutputColumn[] = spec.columns.map((key, index) => {
    const field = mustField(entity, key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      kind: "column",
      field: field.key,
      alias: `c${index}`,
    };
  });
  const select = spec.columns.map((key, index) =>
    Prisma.sql`${ident(mustField(entity, key).column)} AS ${ident(`c${index}`)}`,
  );
  if (entity.detail) {
    select.push(Prisma.sql`${ident(entity.detail.column)} AS "_detail"`);
  }
  const order = orderSql(spec, columns, Prisma.sql`${ident("id")} ASC`);
  return {
    grouped: false,
    columns,
    detail: entity.detail,
    rows: (offset, limit) =>
      Prisma.sql`SELECT ${Prisma.join(select)} FROM ${view} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`,
    count: Prisma.sql`SELECT CAST(COUNT(*) AS integer) AS "total" FROM ${view} ${where}`,
    totals,
    measures,
  };
}
