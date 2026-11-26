/**
 * Validação ESTRUTURAL da spec de consulta (ESPECIFICAÇÃO §5) com Zod, antes de
 * qualquer checagem semântica (catálogo/permissão, em `validate.ts`) e da
 * compilação. O cliente nunca envia SQL: só esta AST.
 */
import { z } from "zod";
import { RELATIVE_ANCHORS, type ConsultaSpec, type FieldType, type Op } from "./types";

/** Limites de tela e exportação (§4.5). */
export const PAGE_SIZE = 100;
export const MAX_SCREEN_ROWS = 1000;
export const MAX_EXPORT_ROWS = 50_000;

/** Limites estruturais da AST (defesa contra specs abusivas). */
export const SPEC_LIMITS = {
  conditions: 20,
  values: 100,
  columns: 40,
  groupBy: 2,
  measures: 12,
  sort: 3,
  stringLength: 200,
  offsetDays: 3660,
} as const;

const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "Chave inválida.");

const relativeSchema = z
  .object({
    relative: z.enum(RELATIVE_ANCHORS),
    offsetDays: z
      .number()
      .int()
      .min(-SPEC_LIMITS.offsetDays)
      .max(SPEC_LIMITS.offsetDays)
      .optional(),
  })
  .strict();

const valueSchema = z.union([
  z.string().max(SPEC_LIMITS.stringLength),
  z.number().finite(),
  z.boolean(),
  relativeSchema,
]);

export const OPS = [
  "eq",
  "neq",
  "in",
  "nin",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "is_null",
  "not_null",
] as const satisfies readonly Op[];

const conditionSchema = z
  .object({
    field: keySchema,
    op: z.enum(OPS),
    value: z
      .union([valueSchema, z.array(valueSchema).max(SPEC_LIMITS.values)])
      .optional(),
  })
  .strict();

export const consultaSpecSchema = z
  .object({
    entity: keySchema,
    filters: z
      .object({
        logic: z.enum(["and", "or"]),
        conditions: z.array(conditionSchema).max(SPEC_LIMITS.conditions),
      })
      .strict()
      .nullable(),
    columns: z.array(keySchema).max(SPEC_LIMITS.columns),
    groupBy: z
      .array(
        z
          .object({
            field: keySchema,
            granularity: z.enum(["dia", "semana", "mes", "ano"]).optional(),
          })
          .strict(),
      )
      .max(SPEC_LIMITS.groupBy),
    measures: z
      .array(
        z
          .object({
            field: keySchema,
            agg: z.enum(["sum", "avg", "min", "max", "count"]),
          })
          .strict(),
      )
      .max(SPEC_LIMITS.measures),
    sort: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80),
            dir: z.enum(["asc", "desc"]),
          })
          .strict(),
      )
      .max(SPEC_LIMITS.sort),
    limit: z.number().int().min(1).max(MAX_EXPORT_ROWS).optional(),
  })
  .strict() satisfies z.ZodType<ConsultaSpec>;

/**
 * Operadores permitidos por tipo de campo (§5). Tabela única: o compilador
 * recusa o que não está aqui e o construtor só oferece o que está aqui.
 */
export const OPS_BY_TYPE: Record<FieldType, readonly Op[]> = {
  texto: ["eq", "neq", "in", "nin", "contains", "is_null", "not_null"],
  pessoa: ["eq", "neq", "in", "nin", "contains", "is_null", "not_null"],
  lista: ["eq", "neq", "in", "nin", "is_null", "not_null"],
  data: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
  numero: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "nin", "is_null", "not_null"],
  moeda: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
  horas: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
  booleano: ["eq", "neq", "is_null", "not_null"],
};

export const OP_LABELS: Record<Op, string> = {
  eq: "é igual a",
  neq: "é diferente de",
  in: "é um de",
  nin: "não é nenhum de",
  contains: "contém",
  gt: "maior que",
  gte: "maior ou igual a",
  lt: "menor que",
  lte: "menor ou igual a",
  between: "entre",
  is_null: "está vazio",
  not_null: "está preenchido",
};

/** Chave de uma medida na saída e na ordenação: `agg:campo`. */
export function measureKey(measure: { field: string; agg: string }): string {
  return `${measure.agg}:${measure.field}`;
}

/** Spec vazia de uma entidade (ponto de partida do construtor). */
export function emptySpec(entity: string, columns: string[] = []): ConsultaSpec {
  return {
    entity,
    filters: null,
    columns,
    groupBy: [],
    measures: [],
    sort: [],
  };
}
