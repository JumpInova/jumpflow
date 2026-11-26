-- Consultores: histórico de projetos + relatório de consultores.
--
-- Sem mudança de tabela: o histórico é derivado de "Allocation" (projeto,
-- perfil, início, fim, status). Apenas registra na Matriz de Permissões:
--   CONSULTORES_PROJETOS  (Histórico de projetos)   view: ADMIN, AREA_MANAGER,
--                          FINANCE, PEOPLE, PROJECT_MANAGER, SALES
--   CONSULTORES_RELATORIO (Relatório de consultores) view: ADMIN, AREA_MANAGER, PEOPLE
--
-- Aditivo: INSERTs com ON CONFLICT DO NOTHING (células existentes preservadas).

INSERT INTO "Permission" ("id", "code", "name", "module", "sortOrder", "active", "parentId", "createdAt", "updatedAt")
SELECT 'perm_consultores_projetos', 'CONSULTORES_PROJETOS', 'Histórico de projetos', 'Pessoas', 60, true, p."id", NOW(), NOW()
FROM "Permission" p WHERE p."code" = 'CONSULTORES'
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "Permission" ("id", "code", "name", "module", "sortOrder", "active", "parentId", "createdAt", "updatedAt")
SELECT 'perm_consultores_relatorio', 'CONSULTORES_RELATORIO', 'Relatório de consultores', 'Pessoas', 60, true, p."id", NOW(), NOW()
FROM "Permission" p WHERE p."code" = 'CONSULTORES'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId", "canView", "canCreate", "canEdit", "canDelete", "updatedAt")
SELECT r."id", p."id", g."canView", g."canCreate", g."canEdit", g."canDelete", NOW()
FROM (VALUES
  ('CONSULTORES_PROJETOS', 'ADMIN', true, false, false, false),
  ('CONSULTORES_PROJETOS', 'AREA_MANAGER', true, false, false, false),
  ('CONSULTORES_PROJETOS', 'FINANCE', true, false, false, false),
  ('CONSULTORES_PROJETOS', 'PEOPLE', true, false, false, false),
  ('CONSULTORES_PROJETOS', 'PROJECT_MANAGER', true, false, false, false),
  ('CONSULTORES_PROJETOS', 'SALES', true, false, false, false),
  ('CONSULTORES_RELATORIO', 'ADMIN', true, false, false, false),
  ('CONSULTORES_RELATORIO', 'AREA_MANAGER', true, false, false, false),
  ('CONSULTORES_RELATORIO', 'PEOPLE', true, false, false, false)
) AS g("code", "roleKey", "canView", "canCreate", "canEdit", "canDelete")
JOIN "Permission" p ON p."code" = g."code"
JOIN "Role" r ON r."key" = g."roleKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
