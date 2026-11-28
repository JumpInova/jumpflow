/**
 * Permissões de entidade e de coluna do módulo Consultas (ESPECIFICAÇÃO §4.1 e
 * §4.3). Puro: recebe a matriz efetiva e os dois sinais de coluna já resolvidos
 * no servidor, e devolve o que o usuário pode ver. O catálogo entregue ao
 * cliente (e, no C3, à IA) sai de `visibleCatalog` — campo sem permissão SOME.
 */
import {
  CONSULTAS_CODES,
  matrixAllows,
  type PermissionMatrix,
} from "@/lib/auth/permission-codes";
import { CONSULTA_ENTITIES } from "./catalog";
import type { ConsultaEntity, ConsultaField, Sensitivity } from "./types";

export interface ConsultaAccess {
  /** `CONSULTAS` view: abre o módulo (tela do catálogo). */
  module: boolean;
  /** `CONSULTAS_CRIAR`: monta e roda consultas próprias no construtor. */
  create: boolean;
  /** `CONSULTAS_EXPORTAR`: exporta XLSX/CSV. */
  export: boolean;
  /** `CONSULTAS_COMPARTILHAR`: compartilha visões e painéis (ROLES/ALL). */
  share: boolean;
  /** `CONSULTAS_AGENDAR`: agenda envio de visões/painéis por e-mail. */
  schedule: boolean;
  /** `CONSULTAS_IA`: assistente de IA (só com CRIAR — a spec gerada é ad hoc). */
  ai: boolean;
  /** Chaves das entidades liberadas (view no `permissionCode` da entidade). */
  entities: ReadonlySet<string>;
  /** Campos `financeiro`: mesma regra dos Relatórios (`includeFinancials`). */
  financial: boolean;
  /** Campos `custo_sensivel`: só o grupo Dados Sensíveis. */
  sensitiveCost: boolean;
  /** Escopo do Financeiro (horas só APPROVED/CLOSED): oculta `financeRestricted`. */
  financeHoursLimited: boolean;
}

export function buildConsultaAccess(
  matrix: PermissionMatrix,
  columns: { financial: boolean; sensitiveCost: boolean; financeHoursLimited?: boolean },
): ConsultaAccess {
  const moduleView = matrixAllows(matrix, CONSULTAS_CODES.module, "view");
  const entities = new Set<string>();
  if (moduleView) {
    for (const entity of CONSULTA_ENTITIES) {
      if (matrixAllows(matrix, entity.permissionCode, "view")) {
        entities.add(entity.key);
      }
    }
  }
  return {
    module: moduleView,
    create: moduleView && matrixAllows(matrix, CONSULTAS_CODES.create, "view"),
    export: moduleView && matrixAllows(matrix, CONSULTAS_CODES.export, "view"),
    share: moduleView && matrixAllows(matrix, CONSULTAS_CODES.share, "view"),
    schedule: moduleView && matrixAllows(matrix, CONSULTAS_CODES.schedule, "view"),
    ai:
      moduleView &&
      matrixAllows(matrix, CONSULTAS_CODES.create, "view") &&
      matrixAllows(matrix, CONSULTAS_CODES.ai, "view"),
    entities,
    financial: columns.financial,
    sensitiveCost: columns.sensitiveCost,
    financeHoursLimited: columns.financeHoursLimited ?? false,
  };
}

/** Acesso negado em tudo (fail-closed). */
export const NO_CONSULTA_ACCESS: ConsultaAccess = {
  module: false,
  create: false,
  export: false,
  share: false,
  schedule: false,
  ai: false,
  entities: new Set(),
  financial: false,
  sensitiveCost: false,
  financeHoursLimited: false,
};

/** Régua de sensibilidade (§4.3), comum a campos e métricas. */
export function canSeeSensitivity(access: ConsultaAccess, sensitivity: Sensitivity): boolean {
  if (sensitivity === "financeiro") return access.financial;
  if (sensitivity === "custo_sensivel") return access.sensitiveCost;
  return true;
}

export function canSeeField(access: ConsultaAccess, field: ConsultaField): boolean {
  if (field.financeRestricted && access.financeHoursLimited) return false;
  return canSeeSensitivity(access, field.sensitivity);
}

export function canSeeEntity(access: ConsultaAccess, entityKey: string): boolean {
  return access.module && access.entities.has(entityKey);
}

/**
 * Catálogo filtrado para o usuário: só entidades liberadas e, dentro delas, só
 * campos visíveis. Colunas padrão, exemplos e detalhe são podados para nunca
 * citar um campo removido.
 */
export function visibleCatalog(access: ConsultaAccess): ConsultaEntity[] {
  const result: ConsultaEntity[] = [];
  for (const entity of CONSULTA_ENTITIES) {
    if (!canSeeEntity(access, entity.key)) continue;
    const fields = entity.fields.filter((field) => canSeeField(access, field));
    const visible = new Set(fields.map((field) => field.key));
    result.push({
      ...entity,
      fields,
      defaultColumns: entity.defaultColumns.filter((key) => visible.has(key)),
      examples: entity.examples.filter((example) =>
        specFieldKeys(example.spec).every((key) => visible.has(key)),
      ),
      ...(entity.metrics
        ? {
            metrics: entity.metrics.filter((metric) =>
              canSeeSensitivity(access, metric.sensitivity),
            ),
          }
        : {}),
    });
  }
  return result;
}

/** Todos os campos que uma spec referencia (colunas, filtros, grupos, medidas). */
export function specFieldKeys(spec: {
  columns: string[];
  filters: { conditions: { field: string }[] } | null;
  groupBy: { field: string }[];
  measures: { field: string }[];
}): string[] {
  return [
    ...spec.columns,
    ...(spec.filters?.conditions.map((condition) => condition.field) ?? []),
    ...spec.groupBy.map((group) => group.field),
    ...spec.measures.map((measure) => measure.field),
  ];
}
