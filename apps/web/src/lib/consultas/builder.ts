/**
 * Helpers PUROS do construtor visual: valores iniciais de filtro, opções de
 * ordenação e poda da spec ao trocar entidade/modo. Não decidem permissão —
 * o servidor revalida tudo (`validateConsulta`).
 */
import { fieldAggregations, getField, AGGREGATION_LABELS } from "./catalog";
import { emptySpec, measureKey, OPS_BY_TYPE } from "./spec";
import type {
  Condition,
  ConsultaEntity,
  ConsultaField,
  ConsultaSpec,
  Op,
  Value,
} from "./types";

/** Valor padrão coerente com tipo + operador (o usuário ajusta depois). */
export function defaultValueFor(
  field: ConsultaField,
  op: Op,
): Condition["value"] {
  if (op === "is_null" || op === "not_null") return undefined;
  const scalar = (): Value => {
    switch (field.type) {
      case "lista":
        return field.options?.[0]?.value ?? "";
      case "booleano":
        return true;
      case "data":
        return { relative: "inicio_mes" };
      case "numero":
      case "moeda":
      case "horas":
        return 0;
      default:
        return "";
    }
  };
  if (op === "in" || op === "nin") return [scalar()];
  if (op === "between") {
    return field.type === "data"
      ? [{ relative: "inicio_mes" }, { relative: "hoje" }]
      : [scalar(), scalar()];
  }
  return scalar();
}

/** Nova condição para o primeiro operador permitido do campo. */
export function newCondition(field: ConsultaField): Condition {
  const op = OPS_BY_TYPE[field.type][0];
  return { field: field.key, op, value: defaultValueFor(field, op) };
}

/** Troca o operador preservando o valor quando a forma é compatível. */
export function changeOperator(
  field: ConsultaField,
  condition: Condition,
  op: Op,
): Condition {
  const wasList = Array.isArray(condition.value);
  const wantsList = op === "in" || op === "nin" || op === "between";
  const keep =
    op !== "is_null" &&
    op !== "not_null" &&
    condition.value !== undefined &&
    wasList === wantsList &&
    !(op === "between" && (condition.value as Value[]).length !== 2);
  return {
    field: field.key,
    op,
    value: keep ? condition.value : defaultValueFor(field, op),
  };
}

export interface SortOption {
  key: string;
  label: string;
}

/** Chaves ordenáveis da spec atual (colunas, ou grupos + medidas). */
export function sortOptions(
  entity: ConsultaEntity,
  spec: ConsultaSpec,
): SortOption[] {
  const label = (key: string) => getField(entity, key)?.label ?? key;
  if (spec.groupBy.length > 0) {
    return [
      ...spec.groupBy.map((group) => ({ key: group.field, label: label(group.field) })),
      ...spec.measures.map((measure) => ({
        key: measureKey(measure),
        label: `${AGGREGATION_LABELS[measure.agg]} de ${label(measure.field)}`,
      })),
    ];
  }
  return spec.columns.map((key) => ({ key, label: label(key) }));
}

/**
 * Remove da spec o que não existe na entidade (catálogo visível) ou não cabe
 * no modo atual: campos sumidos, agregações inválidas, ordenação órfã.
 */
export function pruneSpec(entity: ConsultaEntity, spec: ConsultaSpec): ConsultaSpec {
  const has = (key: string) => Boolean(getField(entity, key));
  const conditions = (spec.filters?.conditions ?? []).filter((condition) =>
    has(condition.field),
  );
  const groupBy = spec.groupBy
    .filter((group) => getField(entity, group.field)?.groupable)
    .slice(0, 2);
  const measures = spec.measures.filter((measure) => {
    const field = getField(entity, measure.field);
    return field ? fieldAggregations(field).includes(measure.agg) : false;
  });
  const columns = spec.columns.filter(has);
  const next: ConsultaSpec = {
    ...spec,
    entity: entity.key,
    filters:
      conditions.length > 0
        ? { logic: spec.filters?.logic ?? "and", conditions }
        : null,
    groupBy,
    measures,
    columns,
  };
  const sortable = new Set(sortOptions(entity, next).map((option) => option.key));
  return { ...next, sort: spec.sort.filter((item) => sortable.has(item.key)) };
}

/** Spec inicial de uma entidade (lista com as colunas padrão). */
export function initialSpec(entity: ConsultaEntity): ConsultaSpec {
  return emptySpec(entity.key, [...entity.defaultColumns]);
}

/** Campos que aceitam alguma agregação além de contagem, primeiro. */
export function measurableFields(entity: ConsultaEntity): ConsultaField[] {
  const numeric = entity.fields.filter((field) =>
    (field.aggregations ?? []).some((agg) => agg !== "count"),
  );
  const others = entity.fields.filter((field) => !numeric.includes(field));
  return [...numeric, ...others];
}

/**
 * Mensagem amigável quando algum filtro está incompleto (valor vazio ou número
 * inválido), para não depender do erro genérico do servidor.
 */
export function incompleteFilterMessage(
  entity: ConsultaEntity,
  spec: ConsultaSpec,
): string | null {
  for (const condition of spec.filters?.conditions ?? []) {
    if (condition.op === "is_null" || condition.op === "not_null") continue;
    const field = getField(entity, condition.field);
    if (!field) continue;
    const values = Array.isArray(condition.value)
      ? condition.value
      : [condition.value];
    const bad =
      values.length === 0 ||
      values.some(
        (value) =>
          value === undefined ||
          (typeof value === "number" && !Number.isFinite(value)) ||
          (typeof value === "string" &&
            value.trim() === "" &&
            field.type !== "texto" &&
            field.type !== "pessoa") ||
          (condition.op === "contains" &&
            typeof value === "string" &&
            value.trim() === ""),
      );
    if (bad) return `Preencha o valor do filtro “${field.label}”.`;
  }
  return null;
}
