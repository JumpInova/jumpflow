-- Consultas — Fase C1 (Fundação). docs/consultas/ESPECIFICACAO.md §2, §3.
--
-- 1) Matriz de Permissões: códigos do módulo Consultas (módulo "Gestão").
--    Somente `canView` é concedido por padrão; CONSULTANT e SALES sem células.
-- 2) Views SQL curadas (somente leitura) das entidades Horas, Alocações e
--    Consultores. Cada view resolve os joins uma vez e expõe as colunas técnicas
--    de escopo de linha (consultant_id, project_id, project_manager_id[s]).
--
-- Aditivo: INSERTs com ON CONFLICT DO NOTHING (células existentes preservadas)
-- e CREATE OR REPLACE VIEW (nenhuma tabela/coluna alterada).

-- ───────────────────────────── 1. Matriz ─────────────────────────────

INSERT INTO "Permission" ("id", "code", "name", "module", "sortOrder", "active", "parentId", "createdAt", "updatedAt")
VALUES ('perm_consultas', 'CONSULTAS', 'Consultas', 'Gestão', 105, true, NULL, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Permission" ("id", "code", "name", "module", "sortOrder", "active", "parentId", "createdAt", "updatedAt")
SELECT g."id", g."code", g."name", 'Gestão', g."sortOrder", true, p."id", NOW(), NOW()
FROM (VALUES
  ('perm_consultas_horas', 'CONSULTAS_HORAS', 'Consultas: Horas', 106),
  ('perm_consultas_alocacoes', 'CONSULTAS_ALOCACOES', 'Consultas: Alocações', 106),
  ('perm_consultas_consultores', 'CONSULTAS_CONSULTORES', 'Consultas: Consultores', 106),
  ('perm_consultas_projetos', 'CONSULTAS_PROJETOS', 'Consultas: Projetos', 106),
  ('perm_consultas_aprovacoes', 'CONSULTAS_APROVACOES', 'Consultas: Aprovações', 106),
  ('perm_consultas_despesas', 'CONSULTAS_DESPESAS', 'Consultas: Despesas', 106),
  ('perm_consultas_faturamento', 'CONSULTAS_FATURAMENTO', 'Consultas: Faturamento', 106),
  ('perm_consultas_pagamentos', 'CONSULTAS_PAGAMENTOS', 'Consultas: Pagamentos', 106),
  ('perm_consultas_skills', 'CONSULTAS_SKILLS', 'Consultas: Skills e certificados', 106),
  ('perm_consultas_ausencias', 'CONSULTAS_AUSENCIAS', 'Consultas: Ausências', 106),
  ('perm_consultas_criar', 'CONSULTAS_CRIAR', 'Criar consultas', 107),
  ('perm_consultas_compartilhar', 'CONSULTAS_COMPARTILHAR', 'Compartilhar visões', 107),
  ('perm_consultas_exportar', 'CONSULTAS_EXPORTAR', 'Exportar resultados', 107),
  ('perm_consultas_agendar', 'CONSULTAS_AGENDAR', 'Agendar envio', 107),
  ('perm_consultas_ia', 'CONSULTAS_IA', 'Assistente de IA', 107)
) AS g("id", "code", "name", "sortOrder")
JOIN "Permission" p ON p."code" = 'CONSULTAS'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId", "canView", "canCreate", "canEdit", "canDelete", "updatedAt")
SELECT r."id", p."id", true, false, false, false, NOW()
FROM (VALUES
  ('CONSULTAS', 'ADMIN'), ('CONSULTAS', 'AREA_MANAGER'), ('CONSULTAS', 'PROJECT_MANAGER'), ('CONSULTAS', 'FINANCE'), ('CONSULTAS', 'PEOPLE'),
  ('CONSULTAS_HORAS', 'ADMIN'), ('CONSULTAS_HORAS', 'AREA_MANAGER'), ('CONSULTAS_HORAS', 'PROJECT_MANAGER'), ('CONSULTAS_HORAS', 'FINANCE'),
  ('CONSULTAS_ALOCACOES', 'ADMIN'), ('CONSULTAS_ALOCACOES', 'AREA_MANAGER'), ('CONSULTAS_ALOCACOES', 'PROJECT_MANAGER'), ('CONSULTAS_ALOCACOES', 'FINANCE'), ('CONSULTAS_ALOCACOES', 'PEOPLE'),
  ('CONSULTAS_CONSULTORES', 'ADMIN'), ('CONSULTAS_CONSULTORES', 'AREA_MANAGER'), ('CONSULTAS_CONSULTORES', 'PROJECT_MANAGER'), ('CONSULTAS_CONSULTORES', 'PEOPLE'),
  ('CONSULTAS_PROJETOS', 'ADMIN'), ('CONSULTAS_PROJETOS', 'AREA_MANAGER'), ('CONSULTAS_PROJETOS', 'PROJECT_MANAGER'), ('CONSULTAS_PROJETOS', 'FINANCE'),
  ('CONSULTAS_APROVACOES', 'ADMIN'), ('CONSULTAS_APROVACOES', 'AREA_MANAGER'), ('CONSULTAS_APROVACOES', 'PROJECT_MANAGER'),
  ('CONSULTAS_DESPESAS', 'ADMIN'), ('CONSULTAS_DESPESAS', 'FINANCE'),
  ('CONSULTAS_FATURAMENTO', 'ADMIN'), ('CONSULTAS_FATURAMENTO', 'FINANCE'),
  ('CONSULTAS_PAGAMENTOS', 'ADMIN'), ('CONSULTAS_PAGAMENTOS', 'FINANCE'),
  ('CONSULTAS_SKILLS', 'ADMIN'), ('CONSULTAS_SKILLS', 'AREA_MANAGER'), ('CONSULTAS_SKILLS', 'PEOPLE'),
  ('CONSULTAS_AUSENCIAS', 'ADMIN'), ('CONSULTAS_AUSENCIAS', 'AREA_MANAGER'), ('CONSULTAS_AUSENCIAS', 'PEOPLE'),
  ('CONSULTAS_CRIAR', 'ADMIN'), ('CONSULTAS_CRIAR', 'AREA_MANAGER'), ('CONSULTAS_CRIAR', 'PROJECT_MANAGER'), ('CONSULTAS_CRIAR', 'FINANCE'), ('CONSULTAS_CRIAR', 'PEOPLE'),
  ('CONSULTAS_COMPARTILHAR', 'ADMIN'), ('CONSULTAS_COMPARTILHAR', 'AREA_MANAGER'), ('CONSULTAS_COMPARTILHAR', 'FINANCE'), ('CONSULTAS_COMPARTILHAR', 'PEOPLE'),
  ('CONSULTAS_EXPORTAR', 'ADMIN'), ('CONSULTAS_EXPORTAR', 'AREA_MANAGER'), ('CONSULTAS_EXPORTAR', 'FINANCE'), ('CONSULTAS_EXPORTAR', 'PEOPLE'),
  ('CONSULTAS_AGENDAR', 'ADMIN'), ('CONSULTAS_AGENDAR', 'FINANCE'),
  ('CONSULTAS_IA', 'ADMIN'), ('CONSULTAS_IA', 'AREA_MANAGER'), ('CONSULTAS_IA', 'PROJECT_MANAGER'), ('CONSULTAS_IA', 'FINANCE'), ('CONSULTAS_IA', 'PEOPLE')
) AS g("code", "roleKey")
JOIN "Permission" p ON p."code" = g."code"
JOIN "Role" r ON r."key" = g."roleKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ───────────────────────────── 2. Views ─────────────────────────────
--
-- Valor-hora de VENDA vigente: mesma regra de `resolveBillingRate`
-- (apps/web/src/lib/db/reports.ts → resolveSaleRate em lib/projects/rates.ts):
--   faixa ativa na data ⇔ startsAt::date <= data < endsAt::date (endsAt nulo = aberta);
--   precedência: alocação → consultor (sem alocação) → projeto (sem consultor/
--   alocação) → Project.billingHourlyRate → Client.defaultHourlyRate;
--   empate na mesma precedência: a faixa de início (dia) mais recente; no mesmo
--   dia, o maior `id` em ordem binária (COLLATE "C") — mesma chave de
--   desempate de `newestFirst` em rates.ts, sem depender da ordem do Prisma.
-- As datas são `timestamp` em UTC (convenção do Prisma), então `::date` dá o
-- mesmo dia que `toIsoDate` (UTC) usado no código.
--
-- Valor-hora de CUSTO não entra nas views: o custo é CIFRADO na aplicação
-- (field-encryption) e não pode ser lido pelo Postgres (ver ANDAMENTO, C1).

CREATE OR REPLACE VIEW "consulta_horas" AS
SELECT
  te."id"                                   AS "id",
  te."date"::date                           AS "data",
  te."consultantId"                         AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  c."seniority"::text                       AS "senioridade",
  te."projectId"                            AS "project_id",
  p."name"                                  AS "projeto",
  p."status"::text                          AS "status_projeto",
  p."clientId"                              AS "client_id",
  cl."name"                                 AS "cliente",
  p."managerUserId"                         AS "project_manager_id",
  pm."name"                                 AS "gestor_projeto",
  te."allocationId"                         AS "allocation_id",
  a."role"                                  AS "perfil",
  te."activityType"                         AS "atividade",
  te."status"::text                         AS "status",
  te."billable"                             AS "faturavel",
  te."description"                          AS "descricao",
  te."hours"                                AS "horas",
  ROUND(te."hours" * te."multiplier", 2)    AS "horas_equivalentes",
  te."overtimeHours"                        AS "horas_extra",
  CASE WHEN te."status" IN ('APPROVED', 'CLOSED') THEN te."hours" ELSE 0 END
                                            AS "horas_aprovadas",
  CASE WHEN te."billable" THEN te."hours" ELSE 0 END
                                            AS "horas_faturaveis",
  (te."submittedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
                                            AS "enviado_em",
  sr."valor"                                AS "valor_hora_venda",
  te."hours" * sr."valor"                   AS "valor_bruto",
  CASE WHEN te."billable" AND te."status" IN ('APPROVED', 'CLOSED')
       THEN te."hours" * sr."valor" ELSE 0 END
                                            AS "receita"
FROM "TimeEntry" te
JOIN "Consultant" c ON c."id" = te."consultantId"
JOIN "Project" p ON p."id" = te."projectId"
JOIN "Client" cl ON cl."id" = p."clientId"
LEFT JOIN "User" pm ON pm."id" = p."managerUserId"
LEFT JOIN "Allocation" a ON a."id" = te."allocationId"
LEFT JOIN LATERAL (
  SELECT COALESCE(
    (SELECT r."hourlyRate" FROM "ProjectSaleRate" r
      WHERE r."projectId" = te."projectId"
        AND te."allocationId" IS NOT NULL
        AND r."allocationId" = te."allocationId"
        AND r."startsAt"::date <= te."date"::date
        AND (r."endsAt" IS NULL OR te."date"::date < r."endsAt"::date)
      ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC
      LIMIT 1),
    (SELECT r."hourlyRate" FROM "ProjectSaleRate" r
      WHERE r."projectId" = te."projectId"
        AND r."allocationId" IS NULL
        AND r."consultantId" = te."consultantId"
        AND r."startsAt"::date <= te."date"::date
        AND (r."endsAt" IS NULL OR te."date"::date < r."endsAt"::date)
      ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC
      LIMIT 1),
    (SELECT r."hourlyRate" FROM "ProjectSaleRate" r
      WHERE r."projectId" = te."projectId"
        AND r."allocationId" IS NULL
        AND r."consultantId" IS NULL
        AND r."startsAt"::date <= te."date"::date
        AND (r."endsAt" IS NULL OR te."date"::date < r."endsAt"::date)
      ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC
      LIMIT 1),
    p."billingHourlyRate",
    cl."defaultHourlyRate"
  ) AS "valor"
) sr ON TRUE;

CREATE OR REPLACE VIEW "consulta_alocacoes" AS
SELECT
  a."id"                                    AS "id",
  a."consultantId"                          AS "consultant_id",
  c."name"                                  AS "consultor",
  c."area"                                  AS "area",
  c."seniority"::text                       AS "senioridade",
  a."projectId"                             AS "project_id",
  p."name"                                  AS "projeto",
  p."status"::text                          AS "status_projeto",
  p."clientId"                              AS "client_id",
  cl."name"                                 AS "cliente",
  p."managerUserId"                         AS "project_manager_id",
  pm."name"                                 AS "gestor_projeto",
  a."role"                                  AS "perfil",
  a."allocationPercent"                     AS "percentual",
  a."startDate"::date                       AS "inicio",
  a."endDate"::date                         AS "fim",
  a."status"::text                          AS "status",
  (a."status" = 'ACTIVE'
    AND a."startDate"::date <= hoje."dia"
    AND (a."endDate" IS NULL OR a."endDate"::date >= hoje."dia"))
                                            AS "vigente",
  COALESCE(h."horas_lancadas", 0)           AS "horas_lancadas",
  COALESCE(h."horas_aprovadas", 0)          AS "horas_aprovadas",
  sr."valor"                                AS "valor_hora_venda_atual"
FROM "Allocation" a
JOIN "Consultant" c ON c."id" = a."consultantId"
JOIN "Project" p ON p."id" = a."projectId"
JOIN "Client" cl ON cl."id" = p."clientId"
LEFT JOIN "User" pm ON pm."id" = p."managerUserId"
CROSS JOIN LATERAL (
  SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS "dia"
) hoje
LEFT JOIN LATERAL (
  SELECT
    SUM(te."hours") AS "horas_lancadas",
    SUM(CASE WHEN te."status" IN ('APPROVED', 'CLOSED') THEN te."hours" ELSE 0 END) AS "horas_aprovadas"
  FROM "TimeEntry" te
  WHERE te."allocationId" = a."id"
) h ON TRUE
LEFT JOIN LATERAL (
  SELECT COALESCE(
    (SELECT r."hourlyRate" FROM "ProjectSaleRate" r
      WHERE r."projectId" = a."projectId"
        AND r."allocationId" = a."id"
        AND r."startsAt"::date <= hoje."dia"
        AND (r."endsAt" IS NULL OR hoje."dia" < r."endsAt"::date)
      ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC
      LIMIT 1),
    (SELECT r."hourlyRate" FROM "ProjectSaleRate" r
      WHERE r."projectId" = a."projectId"
        AND r."allocationId" IS NULL
        AND r."consultantId" = a."consultantId"
        AND r."startsAt"::date <= hoje."dia"
        AND (r."endsAt" IS NULL OR hoje."dia" < r."endsAt"::date)
      ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC
      LIMIT 1),
    (SELECT r."hourlyRate" FROM "ProjectSaleRate" r
      WHERE r."projectId" = a."projectId"
        AND r."allocationId" IS NULL
        AND r."consultantId" IS NULL
        AND r."startsAt"::date <= hoje."dia"
        AND (r."endsAt" IS NULL OR hoje."dia" < r."endsAt"::date)
      ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC
      LIMIT 1),
    p."billingHourlyRate",
    cl."defaultHourlyRate"
  ) AS "valor"
) sr ON TRUE;

CREATE OR REPLACE VIEW "consulta_consultores" AS
SELECT
  c."id"                                    AS "id",
  c."id"                                    AS "consultant_id",
  c."name"                                  AS "nome",
  c."email"                                 AS "email",
  c."jobTitle"                              AS "cargo",
  c."area"                                  AS "area",
  c."seniority"::text                       AS "senioridade",
  c."status"::text                          AS "status",
  c."contractType"::text                    AS "tipo_contrato",
  COALESCE(al."alocacoes_ativas", 0)        AS "alocacoes_ativas",
  COALESCE(al."percentual_alocado", 0)      AS "percentual_alocado",
  COALESCE(al."projetos_ativos", 0)         AS "projetos_ativos",
  ((c."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date AS "cadastrado_em",
  COALESCE(al."project_manager_ids", ARRAY[]::text[]) AS "project_manager_ids"
FROM "Consultant" c
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE a."status" = 'ACTIVE')                       AS "alocacoes_ativas",
    COALESCE(SUM(a."allocationPercent") FILTER (WHERE a."status" = 'ACTIVE'), 0) AS "percentual_alocado",
    COUNT(DISTINCT a."projectId") FILTER (WHERE a."status" = 'ACTIVE')  AS "projetos_ativos",
    ARRAY_AGG(DISTINCT p."managerUserId")
      FILTER (WHERE p."managerUserId" IS NOT NULL AND a."status" <> 'CANCELLED')
                                                                        AS "project_manager_ids"
  FROM "Allocation" a
  JOIN "Project" p ON p."id" = a."projectId"
  WHERE a."consultantId" = c."id"
) al ON TRUE;
