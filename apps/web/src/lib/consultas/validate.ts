/**
 * Validação SEMÂNTICA da spec contra o catálogo e as permissões do usuário
 * (ESPECIFICAÇÃO §4 e §5). Roda depois do Zod (`spec.ts`) e antes do
 * compilador. Regra de ouro: campo que existe mas o usuário não pode ver é
 * REJEITADO com FORBIDDEN (não é mascarado nem ignorado).
 */
import { canSeeEntity, canSeeField, type ConsultaAccess } from "./access";
import { fieldAggregations, getEntity, getField } from "./catalog";
import { isIsoDate, isRelativeDate } from "./dates";
import { ConsultaError } from "./errors";
import {
  consultaSpecSchema,
  measureKey,
  OPS_BY_TYPE,
  SPEC_LIMITS,
} from "./spec";
import type {
  Condition,
  ConsultaEntity,
  ConsultaField,
  ConsultaSpec,
  Value,
} from "./types";

export interface ValidatedConsulta {
  entity: ConsultaEntity;
  /** Spec normalizada: sem agrupamento, `columns` nunca vazio. */
  spec: ConsultaSpec;
  /** Usa algum campo `financeiro`/`custo_sensivel` (dispara auditoria). */
  usesSensitive: boolean;
}

/** Forma de código aceita em listas abertas (`openOptions`), ex.: valores legados. */
const OPEN_OPTION_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function invalid(message: string): never {
  throw new ConsultaError("INVALID", message);
}

function resolveField(
  entity: ConsultaEntity,
  access: ConsultaAccess,
  key: string,
): ConsultaField {
  const field = getField(entity, key);
  if (!field) invalid(`Campo desconhecido: ${key}.`);
  if (!canSeeField(access, field)) {
    throw new ConsultaError(
      "FORBIDDEN",
      `Você não tem permissão para usar o campo “${field.label}”.`,
    );
  }
  return field;
}

function checkScalar(field: ConsultaField, value: Value): void {
  switch (field.type) {
    case "texto":
    case "pessoa":
      if (typeof value !== "string") invalid(`“${field.label}” espera texto.`);
      return;
    case "lista":
      if (
        typeof value !== "string" ||
        !(
          field.options?.some((option) => option.value === value) ||
          (field.openOptions && OPEN_OPTION_RE.test(value))
        )
      ) {
        invalid(`Valor inválido para “${field.label}”.`);
      }
      return;
    case "data":
      if (isRelativeDate(value)) return;
      if (typeof value !== "string" || !isIsoDate(value)) {
        invalid(`“${field.label}” espera uma data (aaaa-mm-dd).`);
      }
      return;
    case "numero":
    case "moeda":
    case "horas":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        invalid(`“${field.label}” espera um número.`);
      }
      return;
    case "booleano":
      if (typeof value !== "boolean") invalid(`“${field.label}” espera Sim/Não.`);
      return;
  }
}

function checkCondition(field: ConsultaField, condition: Condition): void {
  const { op, value } = condition;
  if (!OPS_BY_TYPE[field.type].includes(op)) {
    invalid(`Operador não permitido para “${field.label}”.`);
  }
  if (op === "is_null" || op === "not_null") {
    if (value !== undefined) invalid("Este operador não usa valor.");
    return;
  }
  if (op === "in" || op === "nin") {
    if (!Array.isArray(value) || value.length === 0) {
      invalid(`Informe ao menos um valor para “${field.label}”.`);
    }
    if (value.length > SPEC_LIMITS.values) invalid("Valores demais no filtro.");
    value.forEach((item) => checkScalar(field, item));
    return;
  }
  if (op === "between") {
    if (!Array.isArray(value) || value.length !== 2) {
      invalid(`“Entre” exige dois valores em “${field.label}”.`);
    }
    value.forEach((item) => checkScalar(field, item));
    return;
  }
  if (value === undefined || Array.isArray(value)) {
    invalid(`Informe um valor para “${field.label}”.`);
  }
  checkScalar(field, value);
  if (op === "contains" && (value as string).trim() === "") {
    invalid(`Informe o texto a procurar em “${field.label}”.`);
  }
}

/**
 * Valida (Zod + semântica) e normaliza a spec para o usuário. Lança
 * {@link ConsultaError} INVALID (400) ou FORBIDDEN (403).
 */
export function validateConsulta(
  raw: unknown,
  access: ConsultaAccess,
): ValidatedConsulta {
  const parsed = consultaSpecSchema.safeParse(raw);
  if (!parsed.success) invalid("Consulta inválida.");
  const spec = parsed.data as ConsultaSpec;

  const entity = getEntity(spec.entity);
  if (!entity) invalid("Entidade desconhecida.");
  if (!canSeeEntity(access, entity.key)) {
    throw new ConsultaError(
      "FORBIDDEN",
      `Você não tem permissão para consultar “${entity.label}”.`,
    );
  }

  const used: ConsultaField[] = [];
  const take = (key: string) => {
    const field = resolveField(entity, access, key);
    used.push(field);
    return field;
  };

  // Filtros.
  for (const condition of spec.filters?.conditions ?? []) {
    checkCondition(take(condition.field), condition);
  }
  const filters =
    spec.filters && spec.filters.conditions.length > 0 ? spec.filters : null;

  // Agrupamento.
  const groupKeys = new Set<string>();
  for (const group of spec.groupBy) {
    const field = take(group.field);
    if (!field.groupable) invalid(`Não é possível agrupar por “${field.label}”.`);
    if (group.granularity && field.type !== "data") {
      invalid(`Granularidade só vale para datas (“${field.label}”).`);
    }
    if (groupKeys.has(field.key)) invalid(`Agrupamento repetido: “${field.label}”.`);
    groupKeys.add(field.key);
  }
  const grouped = spec.groupBy.length > 0;

  // Medidas.
  const measureKeys = new Set<string>();
  for (const measure of spec.measures) {
    const field = take(measure.field);
    if (!fieldAggregations(field).includes(measure.agg)) {
      invalid(`Agregação não permitida para “${field.label}”.`);
    }
    const key = measureKey(measure);
    if (measureKeys.has(key)) invalid("Medida repetida.");
    measureKeys.add(key);
  }
  if (grouped && spec.measures.length === 0) {
    invalid("Agrupamento exige ao menos uma medida.");
  }

  // Colunas (sem agrupamento). Vazio → colunas padrão visíveis.
  let columns: string[] = [];
  if (!grouped) {
    columns =
      spec.columns.length > 0
        ? spec.columns
        : entity.defaultColumns.filter((key) => {
            const field = getField(entity, key);
            return field ? canSeeField(access, field) : false;
          });
    if (columns.length === 0) invalid("Escolha ao menos uma coluna.");
    const seen = new Set<string>();
    for (const key of columns) {
      take(key);
      if (seen.has(key)) invalid("Coluna repetida.");
      seen.add(key);
    }
  }

  // Ordenação: com agrupamento, por grupo ou medida; sem, por coluna exibida.
  const sortable = grouped
    ? new Set([...groupKeys, ...measureKeys])
    : new Set(columns);
  for (const item of spec.sort) {
    if (!sortable.has(item.key)) {
      // Pode ser um campo existente porém oculto: checa permissão primeiro.
      const field = getField(entity, item.key);
      if (field && !canSeeField(access, field)) resolveField(entity, access, item.key);
      invalid("Ordenação por um campo que não está no resultado.");
    }
  }

  return {
    entity,
    spec: {
      entity: entity.key,
      filters,
      columns,
      groupBy: spec.groupBy,
      measures: spec.measures,
      sort: spec.sort,
      ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
    },
    usesSensitive: used.some((field) => field.sensitivity !== "publico"),
  };
}
