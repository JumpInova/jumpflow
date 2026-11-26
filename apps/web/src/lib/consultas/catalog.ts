/**
 * Catálogo de dados do módulo Consultas — FONTE ÚNICA (ESPECIFICAÇÃO §3).
 *
 * Compartilhado por compilador, tela do catálogo, construtor visual e (C3)
 * prompt da IA. A coluna física de cada campo sai daqui (`field.column`); não
 * existe outro mapa. Cada entidade aponta para uma view SQL curada criada por
 * migration (`packages/database/prisma/migrations/20261127100000_consultas_fundacao`).
 *
 * Puro (sem Prisma/React). Dados `pessoal` (CPF, bancários, endereço,
 * remuneração acordada) NÃO entram no catálogo.
 */
import { activityLabels, timeEntryStatusLabels } from "@/lib/timesheet/types";
import {
  consultantStatusLabels,
  contractTypeLabels,
  seniorityLabels,
} from "@/lib/consultants/labels";
import { CONSULTAS_CODES } from "@/lib/auth/permission-codes";
import type {
  Aggregation,
  ConsultaEntity,
  ConsultaField,
  ConsultaMetric,
  Granularity,
} from "./types";

function optionsOf(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

const NUMERIC_AGGS: Aggregation[] = ["sum", "avg", "min", "max", "count"];
const RATE_AGGS: Aggregation[] = ["avg", "min", "max", "count"];

const PROJECT_STATUS_OPTIONS = optionsOf({
  PROPOSAL: "Proposta",
  ACTIVE: "Ativo",
  PAUSED: "Pausado",
  CLOSED: "Encerrado",
  CANCELLED: "Cancelado",
});

const ALLOCATION_STATUS_OPTIONS = optionsOf({
  ACTIVE: "Ativa",
  PLANNED: "Planejada",
  ENDED: "Encerrada",
  CANCELLED: "Cancelada",
  INACTIVE: "Inativa",
});

const SENIORITY_OPTIONS = optionsOf(seniorityLabels);

/* Campos repetidos entre entidades (mesmo significado, mesma coluna). */

const consultorField = (source: string): ConsultaField => ({
  key: "consultor",
  label: "Consultor",
  column: "consultor",
  type: "pessoa",
  description: "Nome do consultor.",
  source,
  example: "Ana Souza",
  groupable: true,
  sensitivity: "publico",
  owner: "People",
});

const areaField: ConsultaField = {
  key: "area",
  label: "Área",
  column: "area",
  type: "texto",
  description: "Área do consultor no cadastro.",
  source: "Consultant.area",
  example: "Dados",
  groupable: true,
  sensitivity: "publico",
  owner: "People",
};

const seniorityField: ConsultaField = {
  key: "senioridade",
  label: "Senioridade",
  column: "senioridade",
  type: "lista",
  description: "Senioridade do consultor no cadastro.",
  source: "Consultant.seniority",
  options: SENIORITY_OPTIONS,
  groupable: true,
  sensitivity: "publico",
  owner: "People",
};

const projectFields: ConsultaField[] = [
  {
    key: "projeto",
    label: "Projeto",
    column: "projeto",
    type: "texto",
    description: "Nome do projeto.",
    source: "Project.name",
    example: "Atlas",
    groupable: true,
    sensitivity: "publico",
    owner: "Operação",
  },
  {
    key: "status_projeto",
    label: "Status do projeto",
    column: "status_projeto",
    type: "lista",
    description: "Situação atual do projeto.",
    source: "Project.status",
    options: PROJECT_STATUS_OPTIONS,
    groupable: true,
    sensitivity: "publico",
    owner: "Operação",
  },
  {
    key: "cliente",
    label: "Cliente",
    column: "cliente",
    type: "texto",
    description: "Cliente dono do projeto.",
    source: "Project.client → Client.name",
    example: "Vix Energia",
    groupable: true,
    sensitivity: "publico",
    owner: "Comercial",
  },
  {
    key: "gestor_projeto",
    label: "Gestor do projeto",
    column: "gestor_projeto",
    type: "pessoa",
    description: "Gestor responsável pelo projeto.",
    source: "Project.managerUserId → User.name",
    groupable: true,
    sensitivity: "publico",
    owner: "Operação",
  },
];

const HOURS_METRICS: ConsultaMetric[] = [
  {
    label: "Horas lançadas",
    formula: "SOMA(horas)",
    description: "Todas as horas lançadas, em qualquer situação.",
  },
  {
    label: "Horas aprovadas",
    formula: "SOMA(horas) onde situação ∈ {Aprovado, Fechado}",
    description: "Horas já aprovadas (inclui as de meses fechados).",
  },
  {
    label: "Horas faturáveis",
    formula: "SOMA(horas) onde faturável = Sim",
    description: "Horas marcadas como faturáveis, em qualquer situação.",
  },
  {
    label: "Receita",
    formula:
      "SOMA(horas × valor-hora de venda vigente) onde faturável = Sim e situação ∈ {Aprovado, Fechado}",
    description:
      "Mesmo valor-hora dos Relatórios (precedência alocação → consultor → projeto → padrão do projeto → padrão do cliente).",
  },
];

export const CONSULTA_ENTITIES: readonly ConsultaEntity[] = [
  {
    key: "horas",
    label: "Horas",
    description:
      "Um registro por lançamento de horas, já com consultor, projeto, cliente, gestor e o valor-hora de venda vigente na data.",
    view: "consulta_horas",
    permissionCode: CONSULTAS_CODES.hours,
    scope: "pessoa_projeto",
    financeStatusColumn: "status",
    detail: {
      column: "consultant_id",
      hrefPrefix: "/app/consultores/",
      label: "Abrir consultor",
    },
    defaultColumns: [
      "data",
      "consultor",
      "cliente",
      "projeto",
      "atividade",
      "horas",
      "status",
    ],
    metrics: HOURS_METRICS,
    examples: [
      {
        label: "Horas por projeto no mês",
        spec: {
          entity: "horas",
          filters: {
            logic: "and",
            conditions: [
              { field: "data", op: "gte", value: { relative: "inicio_mes" } },
            ],
          },
          columns: [],
          groupBy: [{ field: "projeto" }],
          measures: [
            { field: "horas", agg: "sum" },
            { field: "horas_aprovadas", agg: "sum" },
          ],
          sort: [{ key: "sum:horas", dir: "desc" }],
        },
      },
      {
        label: "Lançamentos pendentes de aprovação",
        spec: {
          entity: "horas",
          filters: {
            logic: "and",
            conditions: [{ field: "status", op: "eq", value: "SUBMITTED" }],
          },
          columns: ["data", "consultor", "projeto", "horas", "status"],
          groupBy: [],
          measures: [{ field: "horas", agg: "sum" }],
          sort: [{ key: "data", dir: "asc" }],
        },
      },
      {
        label: "Horas por consultor e mês",
        spec: {
          entity: "horas",
          filters: null,
          columns: [],
          groupBy: [
            { field: "consultor" },
            { field: "data", granularity: "mes" },
          ],
          measures: [{ field: "horas", agg: "sum" }],
          sort: [{ key: "data", dir: "desc" }],
        },
      },
    ],
    fields: [
      {
        key: "data",
        label: "Data",
        column: "data",
        type: "data",
        description: "Dia trabalhado do lançamento.",
        source: "TimeEntry.date",
        example: "2026-11-03",
        aggregations: ["min", "max", "count"],
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      consultorField("TimeEntry.consultant → Consultant.name"),
      areaField,
      seniorityField,
      ...projectFields,
      {
        key: "perfil",
        label: "Perfil na alocação",
        column: "perfil",
        type: "texto",
        description: "Perfil/papel da alocação a que o lançamento pertence.",
        source: "TimeEntry.allocation → Allocation.role",
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "atividade",
        label: "Atividade",
        column: "atividade",
        type: "lista",
        description: "Tipo de atividade lançada (dia útil, férias, sobreaviso…).",
        source: "TimeEntry.activityType",
        options: optionsOf(activityLabels),
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "status",
        label: "Situação",
        column: "status",
        type: "lista",
        description: "Etapa do lançamento no fluxo de aprovação.",
        source: "TimeEntry.status",
        options: optionsOf(timeEntryStatusLabels),
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "faturavel",
        label: "Faturável",
        column: "faturavel",
        type: "booleano",
        description: "Se o lançamento entra na cobrança do cliente.",
        source: "TimeEntry.billable",
        groupable: true,
        sensitivity: "publico",
        owner: "Financeiro",
      },
      {
        key: "descricao",
        label: "Descrição",
        column: "descricao",
        type: "texto",
        description: "Texto livre informado pelo consultor no lançamento.",
        source: "TimeEntry.description",
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "horas",
        label: "Horas lançadas",
        column: "horas",
        type: "horas",
        description: "Horas do lançamento (saída − início − pausa).",
        source: "TimeEntry.hours",
        example: "8",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "horas_aprovadas",
        label: "Horas aprovadas",
        column: "horas_aprovadas",
        type: "horas",
        description:
          "Horas do lançamento quando aprovado ou fechado; 0 nas demais situações.",
        source: "TimeEntry.hours → situação Aprovado/Fechado",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "horas_faturaveis",
        label: "Horas faturáveis",
        column: "horas_faturaveis",
        type: "horas",
        description: "Horas do lançamento quando faturável; 0 caso contrário.",
        source: "TimeEntry.hours → faturável",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Financeiro",
      },
      {
        key: "horas_equivalentes",
        label: "Horas equivalentes",
        column: "horas_equivalentes",
        type: "horas",
        description:
          "Horas × fator do lançamento (ex.: sobreaviso vale fração da hora). Base da remuneração.",
        source: "TimeEntry.hours × TimeEntry.multiplier",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "horas_extra",
        label: "Horas extra",
        column: "horas_extra",
        type: "horas",
        description: "Excedente do dia atribuído ao lançamento.",
        source: "TimeEntry.overtimeHours",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "enviado_em",
        label: "Enviado em",
        column: "enviado_em",
        type: "data",
        description:
          "Quando o lançamento foi enviado para aprovação (horário de São Paulo).",
        source: "TimeEntry.submittedAt",
        aggregations: ["min", "max", "count"],
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "valor_hora_venda",
        label: "Valor-hora de venda",
        column: "valor_hora_venda",
        type: "moeda",
        description:
          "Valor-hora de venda vigente na data do lançamento (mesma regra dos Relatórios).",
        source:
          "ProjectSaleRate (alocação → consultor → projeto) → Project.billingHourlyRate → Client.defaultHourlyRate",
        aggregations: RATE_AGGS,
        sensitivity: "financeiro",
        owner: "Financeiro",
      },
      {
        key: "valor_bruto",
        label: "Valor (horas × valor-hora)",
        column: "valor_bruto",
        type: "moeda",
        description:
          "Horas lançadas × valor-hora de venda vigente, em qualquer situação e faturável ou não.",
        source: "TimeEntry.hours × valor-hora de venda vigente",
        aggregations: NUMERIC_AGGS,
        sensitivity: "financeiro",
        owner: "Financeiro",
      },
      {
        key: "receita",
        label: "Receita",
        column: "receita",
        type: "moeda",
        description:
          "Horas × valor-hora de venda vigente, só para lançamentos faturáveis aprovados ou fechados.",
        source: "TimeEntry.hours × valor-hora de venda (faturável, Aprovado/Fechado)",
        aggregations: NUMERIC_AGGS,
        sensitivity: "financeiro",
        owner: "Financeiro",
      },
    ],
  },
  {
    key: "alocacoes",
    label: "Alocações",
    description:
      "Um registro por alocação de consultor em projeto, com período, percentual, situação e horas lançadas na alocação.",
    view: "consulta_alocacoes",
    permissionCode: CONSULTAS_CODES.allocations,
    scope: "pessoa_projeto",
    detail: {
      column: "consultant_id",
      hrefPrefix: "/app/consultores/",
      label: "Abrir consultor",
    },
    defaultColumns: [
      "consultor",
      "cliente",
      "projeto",
      "perfil",
      "percentual",
      "inicio",
      "fim",
      "status",
    ],
    metrics: [
      {
        label: "% de ocupação",
        formula: "SOMA(percentual) das alocações vigentes, por consultor",
        description:
          "Quanto da capacidade do consultor está comprometida hoje (100% = dedicação integral).",
      },
    ],
    examples: [
      {
        label: "Ocupação por consultor (alocações vigentes)",
        spec: {
          entity: "alocacoes",
          filters: {
            logic: "and",
            conditions: [{ field: "vigente", op: "eq", value: true }],
          },
          columns: [],
          groupBy: [{ field: "consultor" }],
          measures: [{ field: "percentual", agg: "sum" }],
          sort: [{ key: "sum:percentual", dir: "desc" }],
        },
      },
      {
        label: "Alocações que terminam nos próximos 30 dias",
        spec: {
          entity: "alocacoes",
          filters: {
            logic: "and",
            conditions: [
              {
                field: "fim",
                op: "between",
                value: [
                  { relative: "hoje" },
                  { relative: "hoje", offsetDays: 30 },
                ],
              },
            ],
          },
          columns: ["consultor", "projeto", "perfil", "fim"],
          groupBy: [],
          measures: [],
          sort: [{ key: "fim", dir: "asc" }],
        },
      },
    ],
    fields: [
      consultorField("Allocation.consultant → Consultant.name"),
      areaField,
      seniorityField,
      ...projectFields,
      {
        key: "perfil",
        label: "Perfil",
        column: "perfil",
        type: "texto",
        description: "Perfil/papel do consultor na alocação.",
        source: "Allocation.role",
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "percentual",
        label: "% alocado",
        column: "percentual",
        type: "numero",
        description: "Percentual da capacidade do consultor dedicado à alocação.",
        source: "Allocation.allocationPercent",
        example: "50",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "inicio",
        label: "Início",
        column: "inicio",
        type: "data",
        description: "Data de início da alocação.",
        source: "Allocation.startDate",
        aggregations: ["min", "max", "count"],
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "fim",
        label: "Fim",
        column: "fim",
        type: "data",
        description: "Data de término prevista (vazia = sem término).",
        source: "Allocation.endDate",
        aggregations: ["min", "max", "count"],
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "status",
        label: "Situação",
        column: "status",
        type: "lista",
        description: "Situação cadastrada da alocação.",
        source: "Allocation.status",
        options: ALLOCATION_STATUS_OPTIONS,
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "vigente",
        label: "Vigente hoje",
        column: "vigente",
        type: "booleano",
        description:
          "Alocação ativa cujo período inclui hoje (fuso de São Paulo).",
        source: "Allocation.status = Ativa e início ≤ hoje ≤ fim",
        groupable: true,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "horas_lancadas",
        label: "Horas lançadas",
        column: "horas_lancadas",
        type: "horas",
        description: "Total de horas lançadas na alocação, em qualquer situação.",
        // Soma lançamentos em qualquer situação: oculto para o escopo do
        // Financeiro (que só vê horas APPROVED/CLOSED, como nos Relatórios).
        financeRestricted: true,
        source: "SOMA(TimeEntry.hours) da alocação",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "horas_aprovadas",
        label: "Horas aprovadas",
        column: "horas_aprovadas",
        type: "horas",
        description: "Horas da alocação aprovadas ou fechadas.",
        source: "SOMA(TimeEntry.hours) da alocação, situação Aprovado/Fechado",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "valor_hora_venda_atual",
        label: "Valor-hora de venda (hoje)",
        column: "valor_hora_venda_atual",
        type: "moeda",
        description:
          "Valor-hora de venda vigente hoje para esta alocação (mesma regra dos Relatórios).",
        source:
          "ProjectSaleRate (alocação → consultor → projeto) → Project.billingHourlyRate → Client.defaultHourlyRate",
        aggregations: RATE_AGGS,
        sensitivity: "financeiro",
        owner: "Financeiro",
      },
    ],
  },
  {
    key: "consultores",
    label: "Consultores",
    description:
      "Um registro por consultor, com dados de cadastro não pessoais e a ocupação atual.",
    view: "consulta_consultores",
    permissionCode: CONSULTAS_CODES.consultants,
    scope: "pessoa_projetos",
    detail: {
      column: "consultant_id",
      hrefPrefix: "/app/consultores/",
      label: "Abrir consultor",
    },
    defaultColumns: [
      "nome",
      "cargo",
      "area",
      "senioridade",
      "status",
      "percentual_alocado",
    ],
    metrics: [
      {
        label: "% de ocupação",
        formula: "SOMA(Allocation.allocationPercent) das alocações ativas",
        description: "Campo “% alocado (ativo)” deste registro.",
      },
    ],
    examples: [
      {
        label: "Consultores ativos por área e senioridade",
        spec: {
          entity: "consultores",
          filters: {
            logic: "and",
            conditions: [{ field: "status", op: "eq", value: "ACTIVE" }],
          },
          columns: [],
          groupBy: [{ field: "area" }, { field: "senioridade" }],
          measures: [{ field: "nome", agg: "count" }],
          sort: [{ key: "area", dir: "asc" }],
        },
      },
      {
        label: "Consultores ativos sem alocação",
        spec: {
          entity: "consultores",
          filters: {
            logic: "and",
            conditions: [
              { field: "status", op: "eq", value: "ACTIVE" },
              { field: "alocacoes_ativas", op: "eq", value: 0 },
            ],
          },
          columns: ["nome", "cargo", "area", "senioridade"],
          groupBy: [],
          measures: [],
          sort: [{ key: "nome", dir: "asc" }],
        },
      },
    ],
    fields: [
      {
        key: "nome",
        label: "Nome",
        column: "nome",
        type: "pessoa",
        description: "Nome do consultor.",
        source: "Consultant.name",
        example: "Ana Souza",
        aggregations: ["count"],
        groupable: true,
        sensitivity: "publico",
        owner: "People",
      },
      {
        key: "email",
        label: "E-mail",
        column: "email",
        type: "texto",
        description: "E-mail corporativo do consultor.",
        source: "Consultant.email",
        sensitivity: "publico",
        owner: "People",
      },
      {
        key: "cargo",
        label: "Cargo",
        column: "cargo",
        type: "texto",
        description: "Cargo do consultor no cadastro.",
        source: "Consultant.jobTitle",
        groupable: true,
        sensitivity: "publico",
        owner: "People",
      },
      areaField,
      seniorityField,
      {
        key: "status",
        label: "Situação",
        column: "status",
        type: "lista",
        description: "Situação do consultor (ativo, afastado, inativo).",
        source: "Consultant.status",
        options: optionsOf(consultantStatusLabels),
        groupable: true,
        sensitivity: "publico",
        owner: "People",
      },
      {
        key: "tipo_contrato",
        label: "Tipo de contratação",
        column: "tipo_contrato",
        type: "lista",
        description: "Modalidade de contratação (CLT, PJ, CLT FLEX).",
        source: "Consultant.contractType",
        options: optionsOf(contractTypeLabels),
        groupable: true,
        sensitivity: "publico",
        owner: "People",
      },
      {
        key: "alocacoes_ativas",
        label: "Alocações ativas",
        column: "alocacoes_ativas",
        type: "numero",
        description: "Quantidade de alocações com situação Ativa.",
        source: "CONTAGEM(Allocation) com status Ativa",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "percentual_alocado",
        label: "% alocado (ativo)",
        column: "percentual_alocado",
        type: "numero",
        description:
          "Soma do percentual das alocações ativas (ocupação). Acima de 100 = sobrealocado.",
        source: "SOMA(Allocation.allocationPercent) com status Ativa",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "projetos_ativos",
        label: "Projetos ativos",
        column: "projetos_ativos",
        type: "numero",
        description: "Quantidade de projetos distintos com alocação ativa.",
        source: "CONTAGEM DISTINTA(Allocation.projectId) com status Ativa",
        aggregations: NUMERIC_AGGS,
        sensitivity: "publico",
        owner: "Operação",
      },
      {
        key: "cadastrado_em",
        label: "Cadastrado em",
        column: "cadastrado_em",
        type: "data",
        description: "Data de criação do cadastro do consultor.",
        source: "Consultant.createdAt",
        aggregations: ["min", "max", "count"],
        groupable: true,
        sensitivity: "publico",
        owner: "People",
      },
    ],
  },
];

/** Entidade pelo `key` (catálogo completo, sem filtro de permissão). */
export function getEntity(key: string): ConsultaEntity | undefined {
  return CONSULTA_ENTITIES.find((entity) => entity.key === key);
}

/** Campo pelo `key` dentro da entidade. */
export function getField(
  entity: ConsultaEntity,
  key: string,
): ConsultaField | undefined {
  return entity.fields.find((field) => field.key === key);
}

/** Agregações que o campo aceita (`count` vale para qualquer campo). */
export function fieldAggregations(field: ConsultaField): Aggregation[] {
  const list = field.aggregations ?? [];
  return list.includes("count") ? list : [...list, "count"];
}

/** Rótulo PT-BR da opção de uma lista (cai no valor bruto). */
export function optionLabel(field: ConsultaField, value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  return field.options?.find((option) => option.value === raw)?.label ?? raw;
}

export const SENSITIVITY_LABELS: Record<ConsultaField["sensitivity"], string> = {
  publico: "Público",
  financeiro: "Financeiro",
  custo_sensivel: "Custo sensível",
};

export const FIELD_TYPE_LABELS: Record<ConsultaField["type"], string> = {
  texto: "Texto",
  lista: "Lista",
  data: "Data",
  pessoa: "Pessoa",
  numero: "Número",
  moeda: "Moeda (R$)",
  horas: "Horas",
  booleano: "Sim/Não",
};

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  sum: "Soma",
  avg: "Média",
  min: "Mínimo",
  max: "Máximo",
  count: "Contagem",
};

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  dia: "dia",
  semana: "semana",
  mes: "mês",
  ano: "ano",
};
