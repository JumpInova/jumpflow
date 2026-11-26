/**
 * Tipos do módulo Consultas (docs/consultas/ESPECIFICACAO.md §3 e §5).
 * Puro: sem Prisma, sem React — importável por servidor, cliente e testes.
 */

export type FieldType =
  | "texto"
  | "lista"
  | "data"
  | "pessoa"
  | "numero"
  | "moeda"
  | "horas"
  | "booleano";

export type Aggregation = "sum" | "avg" | "min" | "max" | "count";

export type Sensitivity = "publico" | "financeiro" | "custo_sensivel";

export type Granularity = "dia" | "semana" | "mes" | "ano";

export type Op =
  | "eq"
  | "neq"
  | "in"
  | "nin"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "is_null"
  | "not_null";

export type RelativeDate = {
  relative: "hoje" | "inicio_mes" | "inicio_semana";
  offsetDays?: number;
};

export type Value = string | number | boolean | RelativeDate;

export type Condition = { field: string; op: Op; value?: Value | Value[] };

export type ConsultaSpec = {
  entity: string;
  filters: { logic: "and" | "or"; conditions: Condition[] } | null;
  columns: string[];
  groupBy: { field: string; granularity?: Granularity }[];
  measures: { field: string; agg: Aggregation }[];
  sort: { key: string; dir: "asc" | "desc" }[];
  limit?: number;
};

/**
 * Como o escopo de linha (seção 4.2) é aplicado à view:
 * - `pessoa_projeto`: a view tem `consultant_id` e `project_manager_id`
 *   (uma linha por lançamento/alocação/despesa/decisão);
 * - `pessoa_projetos`: a view tem `consultant_id` e `project_manager_ids`
 *   (array dos gestores dos projetos em que a pessoa está/esteve alocada);
 * - `projeto`: a linha é do projeto (sem consultor). A view tem
 *   `project_manager_id`; PM vê os próprios projetos e o escopo "próprio
 *   consultor" não alcança nenhuma linha (FALSE);
 * - `amplo`: dado que o módulo de origem só mostra a quem tem visão ampla
 *   (ex.: Pagamentos). Fora do escopo amplo dos Relatórios → FALSE.
 */
export type ScopeKind = "pessoa_projeto" | "pessoa_projetos" | "projeto" | "amplo";

export type ConsultaField = {
  key: string;
  label: string;
  /** Coluna da view. Única fonte do identificador físico (seção 3). */
  column: string;
  type: FieldType;
  description: string;
  source: string;
  example?: string;
  options?: { value: string; label: string }[];
  /**
   * Lista "aberta": além das `options`, aceita códigos fora da lista (ex.:
   * valores legados de `TimeEntry.activityType`) desde que tenham forma de
   * código (`[A-Z0-9_]`). O construtor só oferece as `options`.
   */
  openOptions?: boolean;
  aggregations?: Aggregation[];
  groupable?: boolean;
  sensitivity: Sensitivity;
  owner?: string;
  /**
   * O campo agrega horas de QUALQUER situação numa linha que não é de horas
   * (ex.: `horas_lancadas` em Alocações). O recorte do Financeiro (só
   * APPROVED/CLOSED) não pode ser aplicado por linha nesses casos, então o
   * campo fica OCULTO para quem tem `financeHoursLimited` (some do catálogo e
   * é recusado com FORBIDDEN). Use o equivalente aprovado (`horas_aprovadas`).
   */
  financeRestricted?: boolean;
};

export type ConsultaMetric = {
  label: string;
  formula: string;
  description: string;
  /**
   * Mesma régua dos campos (§4.3): métrica `financeiro` só aparece para quem
   * vê campos financeiros; some do catálogo entregue ao cliente e à IA.
   */
  sensitivity: Sensitivity;
};

export type ConsultaEntity = {
  key: string;
  label: string;
  description: string;
  view: string;
  permissionCode: string;
  scope: ScopeKind;
  /**
   * Coluna de status (lista) usada para o recorte do Financeiro nas horas
   * (`financeHoursLimited` dos Relatórios: só APPROVED/CLOSED). Opcional.
   */
  financeStatusColumn?: string;
  /** Página de detalhe por linha (não agrupada): prefixo + valor da coluna. */
  detail?: { column: string; hrefPrefix: string; label: string };
  defaultColumns: string[];
  examples: { label: string; spec: ConsultaSpec }[];
  metrics?: ConsultaMetric[];
  fields: ConsultaField[];
};
