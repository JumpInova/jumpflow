-- Consultas — Fase C2 (Abrangência + visões). docs/consultas/ESPECIFICACAO.md §6.
--
-- 1) Visões salvas (ConsultaView) e painéis (ConsultaPanel), com
--    compartilhamento PRIVATE/ROLES/ALL. Tabelas novas; nada existente muda.
-- 2) Views SQL curadas (somente leitura) das entidades Projetos, Aprovações,
--    Despesas, Faturamento, Pagamentos, Skills, Certificados e Ausências.
--    Cada view expõe as colunas técnicas de escopo de linha do seu tipo
--    (consultant_id / project_manager_id[s]); o servidor aplica o escopo.
--
-- Decisão 5 da especificação: NENHUMA view lê tabela de custo cifrado
-- (Consultant.hourlyCost, ConsultantCompensation, ConsultantBenefit,
-- ConsultantAllocationCostRate, ConsultantProjectRate, ConsultantAdHocPayment)
-- nem linhas de pagamento (ConsultantPaymentLine.unitRate = custo/hora).
--
-- Aditivo: CREATE TYPE/TABLE/INDEX novos e CREATE OR REPLACE VIEW.

-- ─────────────────────── 1. Visões salvas e painéis ───────────────────────

-- CreateEnum
CREATE TYPE "ConsultaVisualization" AS ENUM ('TABLE', 'BAR', 'LINE', 'PIE', 'INDICATOR');

-- CreateEnum
CREATE TYPE "ConsultaSharing" AS ENUM ('PRIVATE', 'ROLES', 'ALL');

-- CreateTable
CREATE TABLE "ConsultaView" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "entity" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "visualization" "ConsultaVisualization" NOT NULL DEFAULT 'TABLE',
    "sharing" "ConsultaSharing" NOT NULL DEFAULT 'PRIVATE',
    "sharedRoles" "RoleName"[] DEFAULT ARRAY[]::"RoleName"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultaView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultaPanel" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "items" JSONB NOT NULL,
    "sharing" "ConsultaSharing" NOT NULL DEFAULT 'PRIVATE',
    "sharedRoles" "RoleName"[] DEFAULT ARRAY[]::"RoleName"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultaPanel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultaView_ownerId_idx" ON "ConsultaView"("ownerId");

-- CreateIndex
CREATE INDEX "ConsultaView_sharing_idx" ON "ConsultaView"("sharing");

-- CreateIndex
CREATE INDEX "ConsultaPanel_ownerId_idx" ON "ConsultaPanel"("ownerId");

-- CreateIndex
CREATE INDEX "ConsultaPanel_sharing_idx" ON "ConsultaPanel"("sharing");

-- AddForeignKey
ALTER TABLE "ConsultaView" ADD CONSTRAINT "ConsultaView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultaPanel" ADD CONSTRAINT "ConsultaPanel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────────────────────── 2. Views ─────────────────────────────
--
-- Convenções (iguais às da C1): datas de calendário (`DateTime` gravado à
-- meia-noite UTC pelo Prisma) viram `::date`; instantes (`...At`) são
-- convertidos para o horário de São Paulo antes de virar data/hora.
-- `project_manager_ids` = gestores dos projetos em que a pessoa está/esteve
-- alocada (alocações não canceladas), mesma regra de `consulta_consultores`.

CREATE OR REPLACE VIEW "consulta_projetos" AS
SELECT
  p."id"                                    AS "id",
  p."id"                                    AS "project_id",
  p."name"                                  AS "projeto",
  p."status"::text                          AS "status",
  p."clientId"                              AS "client_id",
  cl."name"                                 AS "cliente",
  p."managerUserId"                         AS "project_manager_id",
  pm."name"                                 AS "gestor_projeto",
  p."startDate"::date                       AS "inicio",
  p."endDate"::date                         AS "fim",
  bt."name"                                 AS "tipo_cobranca",
  p."opportunityType"::text                 AS "tipo_oportunidade",
  p."paymentType"::text                     AS "condicao_pagamento",
  (p."commercialContractRef" IS NOT NULL)   AS "contrato_vinculado",
  p."dailyEntryRequired"                    AS "lancamento_diario",
  COALESCE(al."consultores_ativos", 0)      AS "consultores_ativos",
  COALESCE(al."percentual_alocado", 0)      AS "percentual_alocado",
  COALESCE(h."horas_lancadas", 0)           AS "horas_lancadas",
  COALESCE(h."horas_aprovadas", 0)          AS "horas_aprovadas",
  p."budgetHours"                           AS "horas_orcadas",
  CASE WHEN p."budgetHours" > 0
       THEN ROUND(COALESCE(h."horas_aprovadas", 0) * 100 / p."budgetHours", 1)
  END                                       AS "consumo_orcamento",
  p."billingHourlyRate"                     AS "valor_hora_padrao",
  p."createdAt"::date                       AS "cadastrado_em"
FROM "Project" p
JOIN "Client" cl ON cl."id" = p."clientId"
LEFT JOIN "User" pm ON pm."id" = p."managerUserId"
LEFT JOIN "BillingType" bt ON bt."id" = p."billingTypeId"
LEFT JOIN LATERAL (
  SELECT
    COUNT(DISTINCT a."consultantId")        AS "consultores_ativos",
    SUM(a."allocationPercent")              AS "percentual_alocado"
  FROM "Allocation" a
  WHERE a."projectId" = p."id" AND a."status" = 'ACTIVE'
) al ON TRUE
LEFT JOIN LATERAL (
  SELECT
    SUM(te."hours") AS "horas_lancadas",
    SUM(CASE WHEN te."status" IN ('APPROVED', 'CLOSED') THEN te."hours" ELSE 0 END) AS "horas_aprovadas"
  FROM "TimeEntry" te
  WHERE te."projectId" = p."id"
) h ON TRUE;

-- Aprovações: uma linha por DECISÃO registrada (Approval). O registro decidido
-- é polimórfico (entityType + entityId); os LEFT JOINs resolvem consultor e
-- projeto de cada tipo. Comentários de decisões de AUSÊNCIA não entram (podem
-- citar motivo de saúde).
CREATE OR REPLACE VIEW "consulta_aprovacoes" AS
SELECT
  ap."id"                                   AS "id",
  ap."entityType"::text                     AS "tipo",
  ap."status"::text                         AS "decisao",
  ap."isAutomatic"                          AS "automatica",
  ap."ruleKey"                              AS "regra",
  u."name"                                  AS "aprovador",
  CASE WHEN ap."entityType" <> 'TIME_OFF' THEN ap."comment" END
                                            AS "comentario",
  (ap."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "decidido_em",
  COALESCE(te."date"::date, ex."date"::date, tf."startDate"::date,
           ce."issuedAt"::date, cs."createdAt"::date)
                                            AS "data_referencia",
  ROUND((EXTRACT(EPOCH FROM (ap."createdAt"
        - COALESCE(te."submittedAt", ex."submittedAt", tf."requestedAt"))) / 3600)::numeric, 1)
                                            AS "horas_ate_decisao",
  te."hours"                                AS "horas_lancamento",
  ref."consultant_id"                       AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  ref."project_id"                          AS "project_id",
  p."name"                                  AS "projeto",
  cl."name"                                 AS "cliente",
  p."managerUserId"                         AS "project_manager_id",
  pm."name"                                 AS "gestor_projeto"
FROM "Approval" ap
LEFT JOIN "TimeEntry" te
  ON ap."entityType" = 'TIME_ENTRY' AND te."id" = ap."entityId"
LEFT JOIN "Expense" ex
  ON ap."entityType" = 'EXPENSE' AND ex."id" = ap."entityId"
LEFT JOIN "ConsultantSkill" cs
  ON ap."entityType" = 'CONSULTANT_SKILL' AND cs."id" = ap."entityId"
LEFT JOIN "Certificate" ce
  ON ap."entityType" = 'CERTIFICATE' AND ce."id" = ap."entityId"
LEFT JOIN "ConsultantTimeOff" tf
  ON ap."entityType" = 'TIME_OFF' AND tf."id" = ap."entityId"
CROSS JOIN LATERAL (
  SELECT
    COALESCE(te."consultantId", ex."consultantId", cs."consultantId",
             ce."consultantId", tf."consultantId") AS "consultant_id",
    COALESCE(te."projectId", ex."projectId")       AS "project_id"
) ref
LEFT JOIN "Consultant" c ON c."id" = ref."consultant_id"
LEFT JOIN "Project" p ON p."id" = ref."project_id"
LEFT JOIN "Client" cl ON cl."id" = p."clientId"
LEFT JOIN "User" u ON u."id" = ap."approverUserId"
LEFT JOIN "User" pm ON pm."id" = p."managerUserId";

-- Despesas: uma linha por despesa. Endereços de origem/destino (milhagem) NÃO
-- entram (dado pessoal); só a quilometragem.
CREATE OR REPLACE VIEW "consulta_despesas" AS
SELECT
  e."id"                                    AS "id",
  e."date"::date                            AS "data",
  e."consultantId"                          AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  e."projectId"                             AS "project_id",
  p."name"                                  AS "projeto",
  cl."name"                                 AS "cliente",
  p."managerUserId"                         AS "project_manager_id",
  pm."name"                                 AS "gestor_projeto",
  COALESCE(et."label", e."category")        AS "tipo",
  e."description"                           AS "descricao",
  e."invoiceNumber"                         AS "nota_fiscal",
  e."status"::text                          AS "status",
  e."amount"                                AS "valor",
  e."distanceKm"                            AS "km",
  (att."id" IS NOT NULL)                    AS "com_comprovante",
  (e."submittedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "enviada_em"
FROM "Expense" e
JOIN "Consultant" c ON c."id" = e."consultantId"
JOIN "Project" p ON p."id" = e."projectId"
JOIN "Client" cl ON cl."id" = p."clientId"
LEFT JOIN "User" pm ON pm."id" = p."managerUserId"
LEFT JOIN "ExpenseType" et ON et."code" = e."category"
LEFT JOIN "ExpenseAttachment" att ON att."expenseId" = e."id";

-- Faturamento: uma linha por fechamento de receita (pré-fatura) por cliente/
-- projeto e competência. Valores de VENDA (receita); nada de custo. A nota
-- fiscal é a emitida mais recente do fechamento (ou a última tentativa).
CREATE OR REPLACE VIEW "consulta_faturamento" AS
SELECT
  rc."id"                                   AS "id",
  make_date(rc."year", rc."month", 1)       AS "competencia",
  rc."clientId"                             AS "client_id",
  cl."name"                                 AS "cliente",
  rc."projectId"                            AS "project_id",
  p."name"                                  AS "projeto",
  p."managerUserId"                         AS "project_manager_id",
  pm."name"                                 AS "gestor_projeto",
  rc."status"::text                         AS "status",
  rc."totalHours"                           AS "horas",
  rc."grossAmount"                          AS "valor_bruto",
  rc."adjustmentAmount"                     AS "ajuste",
  rc."totalAmount"                          AS "valor_total",
  (rc."closedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "fechado_em",
  cu."name"                                 AS "fechado_por",
  fd."invoiceNumber"                        AS "nota_fiscal",
  fd."status"::text                         AS "status_nf",
  (fd."issuedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "nf_emitida_em"
FROM "RevenueClosing" rc
JOIN "Client" cl ON cl."id" = rc."clientId"
LEFT JOIN "Project" p ON p."id" = rc."projectId"
LEFT JOIN "User" pm ON pm."id" = p."managerUserId"
LEFT JOIN "User" cu ON cu."id" = rc."closedByUserId"
LEFT JOIN LATERAL (
  SELECT f."invoiceNumber", f."status", f."issuedAt"
  FROM "FiscalDocument" f
  WHERE f."revenueClosingId" = rc."id"
  ORDER BY (f."status" = 'ISSUED') DESC, f."createdAt" DESC, f."id" DESC
  LIMIT 1
) fd ON TRUE;

-- Pagamentos: uma linha por pagamento mensal de consultor no fluxo de
-- Pagamentos (só PJ e CLT FLEX, igual à tela — CLT puro é folha). Só o total
-- do mês e o valor da NF, que o Financeiro já vê na tela. NÃO entram as linhas
-- do pagamento (valor/hora = custo do consultor, só Dados Sensíveis) nem os
-- valores acordados/benefícios (cifrados).
CREATE OR REPLACE VIEW "consulta_pagamentos" AS
SELECT
  cp."id"                                   AS "id",
  cp."consultantId"                         AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  make_date(cp."year", cp."month", 1)       AS "competencia",
  cp."contractType"::text                   AS "tipo_contrato",
  cp."status"::text                         AS "status",
  cp."totalAmount"                          AS "valor_total",
  cp."invoiceAmount"                        AS "valor_nf",
  cp."expectedPaymentAt"::date              AS "previsao_pagamento",
  (cp."peopleReleasedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "liberado_dp_em",
  (cp."invoiceRequestSentAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "nf_solicitada_em",
  (cp."invoiceReceivedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "nf_recebida_em",
  (cp."invoiceValidatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "nf_validada_em",
  (cp."approvedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "aprovado_em",
  (cp."confirmedPaidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "pago_em"
FROM "ConsultantPayment" cp
JOIN "Consultant" c ON c."id" = cp."consultantId"
WHERE cp."contractType" IN ('PJ', 'CLT_FLEX');

CREATE OR REPLACE VIEW "consulta_skills" AS
SELECT
  cs."id"                                   AS "id",
  cs."consultantId"                         AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  c."seniority"::text                       AS "senioridade",
  c."status"::text                          AS "status_consultor",
  s."name"                                  AS "skill",
  s."category"                              AS "categoria",
  s."type"::text                            AS "tipo",
  cs."level"::text                          AS "nivel",
  CASE cs."level"
    WHEN 'BASIC' THEN 1
    WHEN 'INTERMEDIATE' THEN 2
    WHEN 'ADVANCED' THEN 3
    WHEN 'SPECIALIST' THEN 4
  END                                       AS "nivel_numero",
  cs."yearsExperience"                      AS "anos_experiencia",
  cs."lastUsedAt"::date                     AS "ultimo_uso",
  cs."validationStatus"::text               AS "validacao",
  cs."updatedAt"::date                      AS "atualizado_em",
  COALESCE(mg."ids", ARRAY[]::text[])       AS "project_manager_ids"
FROM "ConsultantSkill" cs
JOIN "Consultant" c ON c."id" = cs."consultantId"
JOIN "Skill" s ON s."id" = cs."skillId"
LEFT JOIN LATERAL (
  SELECT ARRAY_AGG(DISTINCT p."managerUserId")
           FILTER (WHERE p."managerUserId" IS NOT NULL AND a."status" <> 'CANCELLED') AS "ids"
  FROM "Allocation" a
  JOIN "Project" p ON p."id" = a."projectId"
  WHERE a."consultantId" = c."id"
) mg ON TRUE;

CREATE OR REPLACE VIEW "consulta_certificados" AS
SELECT
  ce."id"                                   AS "id",
  ce."consultantId"                         AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  c."seniority"::text                       AS "senioridade",
  ce."name"                                 AS "certificado",
  ce."issuer"                               AS "emissor",
  ce."issuedAt"::date                       AS "emitido_em",
  ce."expiresAt"::date                      AS "expira_em",
  ce."status"::text                         AS "validacao",
  (ce."expiresAt" IS NULL OR ce."expiresAt"::date >= hoje."dia")
                                            AS "vigente",
  (ce."credentialUrl" IS NOT NULL OR ce."fileUrl" IS NOT NULL)
                                            AS "com_comprovante",
  COALESCE(mg."ids", ARRAY[]::text[])       AS "project_manager_ids"
FROM "Certificate" ce
JOIN "Consultant" c ON c."id" = ce."consultantId"
CROSS JOIN LATERAL (
  SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS "dia"
) hoje
LEFT JOIN LATERAL (
  SELECT ARRAY_AGG(DISTINCT p."managerUserId")
           FILTER (WHERE p."managerUserId" IS NOT NULL AND a."status" <> 'CANCELLED') AS "ids"
  FROM "Allocation" a
  JOIN "Project" p ON p."id" = a."projectId"
  WHERE a."consultantId" = c."id"
) mg ON TRUE;

-- Ausências: uma linha por ausência (férias, licença, outra). Observação do
-- pedido e comentário da decisão NÃO entram (podem citar motivo de saúde).
CREATE OR REPLACE VIEW "consulta_ausencias" AS
SELECT
  t."id"                                    AS "id",
  t."consultantId"                          AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  c."seniority"::text                       AS "senioridade",
  t."kind"::text                            AS "tipo",
  t."status"::text                          AS "status",
  t."startDate"::date                       AS "inicio",
  t."endDate"::date                         AS "fim",
  (t."endDate"::date - t."startDate"::date + 1)
                                            AS "dias_corridos",
  t."workingDays"                           AS "dias_uteis",
  t."paid"                                  AS "paga",
  (t."status" IN ('PLANNED', 'CONFIRMED')
    AND t."startDate"::date <= hoje."dia"
    AND t."endDate"::date >= hoje."dia")    AS "em_curso",
  (t."requestedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "solicitada_em",
  (t."decidedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "decidida_em",
  du."name"                                 AS "decidida_por",
  COALESCE(mg."ids", ARRAY[]::text[])       AS "project_manager_ids"
FROM "ConsultantTimeOff" t
JOIN "Consultant" c ON c."id" = t."consultantId"
LEFT JOIN "User" du ON du."id" = t."approvedByUserId"
CROSS JOIN LATERAL (
  SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS "dia"
) hoje
LEFT JOIN LATERAL (
  SELECT ARRAY_AGG(DISTINCT p."managerUserId")
           FILTER (WHERE p."managerUserId" IS NOT NULL AND a."status" <> 'CANCELLED') AS "ids"
  FROM "Allocation" a
  JOIN "Project" p ON p."id" = a."projectId"
  WHERE a."consultantId" = c."id"
) mg ON TRUE;
