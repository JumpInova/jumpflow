/**
 * Assistente de IA de Consultas (ESPECIFICAÇÃO §6 C3) — parte PURA.
 *
 * Linguagem natural → `ConsultaSpec` JSON. Regras:
 * - o prompt leva SÓ o catálogo já filtrado para o usuário (`visibleCatalog`):
 *   entidades, campos e métricas que ele pode ver — nunca dados, nunca nomes
 *   físicos (view/coluna/origem);
 * - a saída passa pelo MESMO Zod + validação semântica/permissão do construtor
 *   (`validateConsulta`); campo fora do catálogo do usuário é recusado;
 * - 1 retentativa com o erro; depois desiste com mensagem amigável;
 * - a explicação mostrada ao usuário é gerada AQUI, de forma determinística a
 *   partir da spec validada (não pela IA), para nunca divergir do que roda.
 *
 * Sem Prisma/React: o provider chega por parâmetro (`AiTextProvider`).
 */
import type { AiTextProvider } from "@/lib/ai/provider";
import type { ConsultaAccess } from "./access";
import { AGGREGATION_LABELS, getField, GRANULARITY_LABELS, optionLabel } from "./catalog";
import { isRelativeDate, RELATIVE_DATE_LABELS } from "./dates";
import { isConsultaError } from "./errors";
import { formatIsoDate } from "./format";
import { consultaSpecSchema, OP_LABELS, OPS_BY_TYPE, SPEC_LIMITS } from "./spec";
import {
  RELATIVE_ANCHORS,
  type Condition,
  type ConsultaEntity,
  type ConsultaField,
  type ConsultaSpec,
  type Value,
} from "./types";
import { validateConsulta } from "./validate";

/** Tamanho do pedido em linguagem natural. */
export const AI_REQUEST_LIMITS = { min: 3, max: 500 } as const;
/** Tentativas com o provider (1 + 1 retentativa com o erro). */
export const AI_MAX_ATTEMPTS = 2;
/** Teto de tokens da resposta (uma spec cabe folgada). */
const AI_MAX_TOKENS = 1200;
/** Descrição de campo no prompt (economia de tokens). */
const DESCRIPTION_MAX = 180;
/** Exemplos por entidade no prompt. */
const EXAMPLES_PER_ENTITY = 2;

export const AI_FRIENDLY = {
  unavailable:
    "O assistente de IA está indisponível no momento. Use o construtor manual abaixo.",
  gaveUp:
    "Não consegui montar uma consulta válida para esse pedido. Reformule com mais detalhes (entidade, período, agrupamento) ou use o construtor.",
  cannotAnswer:
    "Esse pedido não pode ser atendido com os dados disponíveis para o seu perfil. Reformule ou use o construtor.",
} as const;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Campo como o modelo o vê: só significado de negócio, sem nome físico. */
function promptField(field: ConsultaField) {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    description: truncate(field.description, DESCRIPTION_MAX),
    ...(field.options ? { options: field.options.map((option) => option.value) } : {}),
    ...(field.aggregations?.length ? { aggregations: field.aggregations } : {}),
    ...(field.groupable ? { groupable: true } : {}),
  };
}

/**
 * Catálogo do prompt a partir do catálogo JÁ filtrado (`visibleCatalog`). Não
 * recebe `access`: quem chama é obrigado a passar só o que o usuário vê.
 */
export function buildPromptCatalog(entities: readonly ConsultaEntity[]) {
  return entities.map((entity) => ({
    key: entity.key,
    label: entity.label,
    description: truncate(entity.description, DESCRIPTION_MAX * 2),
    fields: entity.fields.map(promptField),
    ...(entity.metrics?.length
      ? { metrics: entity.metrics.map((metric) => ({ label: metric.label, formula: metric.formula })) }
      : {}),
    examples: entity.examples
      .slice(0, EXAMPLES_PER_ENTITY)
      .map((example) => ({ pedido: example.label, spec: example.spec })),
  }));
}

function opsTable(): string {
  return Object.entries(OPS_BY_TYPE)
    .map(([type, ops]) => `- ${type}: ${ops.join(", ")}`)
    .join("\n");
}

/** Instruções fixas (sistema). Menciona JSON (exigência do modo JSON do DeepSeek). */
export function buildSystemPrompt(): string {
  return [
    "Você converte pedidos em português sobre dados operacionais em UMA consulta no formato JSON (ConsultaSpec).",
    "Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois, sem cercas de código.",
    "",
    "Formato:",
    '{"entity": string, "filters": {"logic": "and"|"or", "conditions": [{"field": string, "op": string, "value"?: valor | valor[]}]} | null, "columns": string[], "groupBy": [{"field": string, "granularity"?: "dia"|"semana"|"mes"|"ano"}], "measures": [{"field": string, "agg": "sum"|"avg"|"min"|"max"|"count"}], "sort": [{"key": string, "dir": "asc"|"desc"}], "limit"?: number}',
    "",
    "Regras:",
    "1. Use SOMENTE entidades e campos (pela `key`) do catálogo fornecido. Todos os campos pertencem à entidade escolhida.",
    `2. Filtros: um nível só, até ${SPEC_LIMITS.conditions} condições. Operadores permitidos por tipo de campo:`,
    opsTable(),
    `3. Valores: texto/pessoa = string; lista = uma das "options" (o código, não o rótulo); numero/moeda/horas = número; booleano = true/false; data = "aaaa-mm-dd" ou relativa {"relative": ${RELATIVE_ANCHORS.map((anchor) => `"${anchor}"`).join("|")}, "offsetDays"?: inteiro} (dias somados à âncora; calendário de São Paulo).`,
    "   Períodos: prefira as âncoras a contas com offsetDays. Exemplos:",
    '   - "mês passado" → {"field": <data>, "op": "between", "value": [{"relative": "inicio_mes_anterior"}, {"relative": "fim_mes_anterior"}]}',
    '   - "próximo mês" (ex.: férias que começam no próximo mês) → "between" [{"relative": "inicio_proximo_mes"}, {"relative": "fim_proximo_mes"}]',
    '   - "este mês" → "between" [{"relative": "inicio_mes"}, {"relative": "fim_mes"}]; "este ano" / "no ano" → "gte" {"relative": "inicio_ano"}',
    '   - "ano passado" → "between" [{"relative": "inicio_ano_anterior"}, {"relative": "fim_ano_anterior"}]; "últimos 30 dias" → "gte" {"relative": "hoje", "offsetDays": -30}',
    '   "in"/"nin" exigem lista não vazia; "between" exige lista com exatamente 2 valores; "is_null"/"not_null" não têm "value".',
    `4. groupBy: no máximo ${SPEC_LIMITS.groupBy}, só campos com "groupable": true; "granularity" só para campos do tipo data.`,
    '5. measures: "agg" precisa estar em "aggregations" do campo ("count" vale para qualquer campo). Com groupBy, ao menos uma medida e "columns" = [].',
    '6. Sem groupBy: "columns" lista os campos exibidos; medidas viram uma linha de totais.',
    '7. sort: "key" = key de um campo do resultado (coluna ou agrupamento) ou "agg:campo" de uma medida (ex.: "sum:horas").',
    `8. "limit" é opcional (1 a 50000). Use para pedidos como "top 10".`,
    "9. Use os campos e métricas do catálogo que descrevem EXATAMENTE o pedido; não invente campos.",
    '10. NUNCA troque o que foi pedido por outra medida parecida (ex.: pediram receita, valor ou custo e o catálogo só tem horas). Se algum campo, métrica ou entidade necessária não está no catálogo fornecido, responda {"error": "fora do catálogo"} em vez de montar outra consulta.',
    '11. Se o pedido não puder ser atendido com o catálogo, responda {"error": "motivo curto"}.',
  ].join("\n");
}

/** Prompt do usuário: data de referência, catálogo filtrado e o pedido. */
export function buildUserPrompt(input: {
  catalog: ReturnType<typeof buildPromptCatalog>;
  request: string;
  today: string;
  previousError?: string;
}): string {
  const parts = [
    `Data de hoje (America/Sao_Paulo): ${input.today}.`,
    "Catálogo disponível (JSON):",
    JSON.stringify(input.catalog),
    "",
    `Pedido: ${input.request}`,
  ];
  if (input.previousError) {
    parts.push(
      "",
      `A resposta anterior foi recusada: ${input.previousError}`,
      "Corrija e responda de novo somente com o objeto JSON.",
    );
  }
  return parts.join("\n");
}

/** Extrai o objeto JSON da resposta (tolera cercas/prosa em volta). */
export function parseAiJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Primeiro problema do Zod em texto curto (para a retentativa). */
function zodProblem(raw: unknown): string | null {
  const parsed = consultaSpecSchema.safeParse(raw);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? issue.path.join(".") : "(raiz)";
  return `formato inválido em ${path}: ${issue.message}`;
}

export type AiSpecCheck =
  | { ok: true; spec: ConsultaSpec; entity: ConsultaEntity }
  | { ok: false; kind: "cannot_answer" | "invalid"; error: string };

/**
 * Valida a saída do modelo com o MESMO Zod + validação semântica/permissão do
 * construtor. A mensagem de erro (para a retentativa) nunca cita campo que o
 * usuário não pode ver: FORBIDDEN vira um aviso genérico.
 */
export function checkAiOutput(text: string, access: ConsultaAccess): AiSpecCheck {
  const raw = parseAiJson(text);
  if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, kind: "invalid", error: "a resposta não era um objeto JSON." };
  }
  if ("error" in raw && !("entity" in raw)) {
    return { ok: false, kind: "cannot_answer", error: "pedido fora do catálogo." };
  }
  const structural = zodProblem(raw);
  if (structural) return { ok: false, kind: "invalid", error: structural };
  try {
    const validated = validateConsulta(raw, access);
    return { ok: true, spec: validated.spec, entity: validated.entity };
  } catch (error) {
    if (isConsultaError(error)) {
      if (error.code === "FORBIDDEN") {
        return {
          ok: false,
          kind: "invalid",
          error: "usou entidade ou campo que não está no catálogo fornecido. Use somente as keys do catálogo.",
        };
      }
      return { ok: false, kind: "invalid", error: error.message };
    }
    return { ok: false, kind: "invalid", error: "consulta inválida." };
  }
}

export type AiGenerateResult =
  | {
      ok: true;
      spec: ConsultaSpec;
      entity: ConsultaEntity;
      explanation: string[];
      attempts: number;
    }
  | {
      ok: false;
      reason: "unavailable" | "gave_up" | "cannot_answer";
      message: string;
      attempts: number;
    };

/**
 * Orquestra a geração: até {@link AI_MAX_ATTEMPTS} chamadas, a 2ª com o erro
 * da 1ª. `entities` = catálogo JÁ filtrado do usuário; `access` = o mesmo
 * acesso usado na validação.
 */
export async function generateConsultaSpec(input: {
  provider: AiTextProvider;
  entities: readonly ConsultaEntity[];
  access: ConsultaAccess;
  request: string;
  today: string;
}): Promise<AiGenerateResult> {
  const catalog = buildPromptCatalog(input.entities);
  const system = buildSystemPrompt();
  let previousError: string | undefined;
  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt++) {
    const text = await input.provider.complete(
      buildUserPrompt({ catalog, request: input.request, today: input.today, previousError }),
      { system, json: true, maxTokens: AI_MAX_TOKENS, entityType: "Consulta" },
    );
    if (text === null) {
      return { ok: false, reason: "unavailable", message: AI_FRIENDLY.unavailable, attempts: attempt };
    }
    const checked = checkAiOutput(text, input.access);
    if (checked.ok) {
      return {
        ok: true,
        spec: checked.spec,
        entity: checked.entity,
        explanation: explainSpec(checked.entity, checked.spec),
        attempts: attempt,
      };
    }
    if (checked.kind === "cannot_answer") {
      return { ok: false, reason: "cannot_answer", message: AI_FRIENDLY.cannotAnswer, attempts: attempt };
    }
    previousError = checked.error;
  }
  return { ok: false, reason: "gave_up", message: AI_FRIENDLY.gaveUp, attempts: AI_MAX_ATTEMPTS };
}

/* ───────────────────── Explicação determinística ───────────────────── */

const NUMBER = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

function describeValue(field: ConsultaField, value: Value): string {
  if (isRelativeDate(value)) {
    const base = RELATIVE_DATE_LABELS[value.relative].toLowerCase();
    const offset = value.offsetDays ?? 0;
    if (offset === 0) return base;
    const days = Math.abs(offset);
    return `${base} ${offset > 0 ? "+" : "−"} ${days} dia${days === 1 ? "" : "s"}`;
  }
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") return NUMBER.format(value);
  if (field.type === "lista") return `“${optionLabel(field, value)}”`;
  if (field.type === "data") return formatIsoDate(value);
  return `“${value}”`;
}

function describeCondition(entity: ConsultaEntity, condition: Condition): string {
  const field = getField(entity, condition.field);
  if (!field) return condition.field;
  const op = OP_LABELS[condition.op];
  if (condition.op === "is_null" || condition.op === "not_null") return `${field.label} ${op}`;
  const value = condition.value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => describeValue(field, item));
    if (condition.op === "between") return `${field.label} entre ${parts[0]} e ${parts[1]}`;
    return `${field.label} ${op} ${parts.join(", ")}`;
  }
  return value === undefined ? `${field.label} ${op}` : `${field.label} ${op} ${describeValue(field, value)}`;
}

function labelOf(entity: ConsultaEntity, key: string): string {
  return getField(entity, key)?.label ?? key;
}

function measureLabel(entity: ConsultaEntity, measure: { field: string; agg: string }): string {
  const agg = AGGREGATION_LABELS[measure.agg as keyof typeof AGGREGATION_LABELS] ?? measure.agg;
  return `${agg} de ${labelOf(entity, measure.field)}`;
}

function sortLabel(entity: ConsultaEntity, spec: ConsultaSpec, key: string): string {
  const measure = spec.measures.find((item) => `${item.agg}:${item.field}` === key);
  return measure ? measureLabel(entity, measure) : labelOf(entity, key);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/**
 * Explicação em PT-BR do que a spec faz, gerada a partir da spec validada (não
 * pela IA). Uma frase por aspecto, na ordem em que o usuário confere.
 */
export function explainSpec(entity: ConsultaEntity, spec: ConsultaSpec): string[] {
  const lines: string[] = [`Entidade: ${entity.label}.`];
  const conditions = spec.filters?.conditions ?? [];
  if (conditions.length === 0) {
    lines.push("Sem filtros: considera todos os registros que o seu perfil pode ver.");
  } else {
    const joiner = spec.filters?.logic === "or" ? " OU " : " E ";
    lines.push(`Filtros: ${conditions.map((c) => describeCondition(entity, c)).join(joiner)}.`);
  }
  if (spec.groupBy.length > 0) {
    const groups = spec.groupBy.map((group) => {
      const label = labelOf(entity, group.field);
      return group.granularity ? `${label} (por ${GRANULARITY_LABELS[group.granularity]})` : label;
    });
    lines.push(`Agrupa por ${joinList(groups)}.`);
    lines.push(`Calcula ${joinList(spec.measures.map((m) => measureLabel(entity, m)))}.`);
  } else {
    lines.push(`Mostra as colunas ${joinList(spec.columns.map((key) => labelOf(entity, key)))}.`);
    if (spec.measures.length > 0) {
      lines.push(`Totais: ${joinList(spec.measures.map((m) => measureLabel(entity, m)))}.`);
    }
  }
  if (spec.sort.length > 0) {
    const sorts = spec.sort.map(
      (item) => `${sortLabel(entity, spec, item.key)} (${item.dir === "asc" ? "crescente" : "decrescente"})`,
    );
    lines.push(`Ordena por ${joinList(sorts)}.`);
  }
  if (spec.limit !== undefined) {
    lines.push(`Limita a ${NUMBER.format(spec.limit)} ${spec.groupBy.length > 0 ? "grupos" : "linhas"}.`);
  }
  return lines;
}

/** Normaliza e valida o pedido do usuário (texto livre). */
export function normalizeAiRequest(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < AI_REQUEST_LIMITS.min || text.length > AI_REQUEST_LIMITS.max) return null;
  return text;
}
