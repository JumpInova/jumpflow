-- Microsoft 365 (M1: Conexão + Agenda) — parte 2/2.
--
-- Aditivo: novas tabelas M365Connection, CalendarEvent, CalendarEventSighting,
-- M365TimeSuggestion; coluna opcional Checkpoint.calendarEventId (FK SetNull) com
-- unicidade (calendarEventId, consultantId) = um rascunho por evento por
-- consultor. Nenhum dado existente é alterado.
--
-- Matriz de Permissões: código novo INTEGRACOES_M365 (visão admin "N de M
-- usuários conectados"), filho de ADMIN_ACESSOS, view só ADMIN. INSERTs com
-- ON CONFLICT DO NOTHING (células existentes preservadas), padrão de
-- 20261126120000_consultores_historico_projetos.

-- CreateEnum
CREATE TYPE "M365ConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REAUTH_REQUIRED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "M365TimeSuggestionStatus" AS ENUM ('PENDING', 'DISMISSED');

-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "calendarEventId" TEXT;

-- CreateTable
CREATE TABLE "M365Connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "M365ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tenantId" TEXT,
    "graphUserId" TEXT,
    "mailbox" TEXT,
    "calendarDeltaLink" TEXT,
    "calendarWindowStart" TIMESTAMP(3),
    "calendarWindowEnd" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "syncLeaseUntil" TIMESTAMP(3),
    "syncLeaseOwner" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "iCalUId" TEXT NOT NULL,
    "subject" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "organizerEmail" TEXT,
    "organizerName" TEXT,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "joinUrl" TEXT,
    "onlineMeetingId" TEXT,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEventSighting" (
    "id" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "graphEventId" TEXT NOT NULL,
    "webLink" TEXT,
    "responseStatus" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEventSighting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "M365TimeSuggestion" (
    "id" TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "projectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchKind" TEXT NOT NULL,
    "status" "M365TimeSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365TimeSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "M365Connection_userId_key" ON "M365Connection"("userId");

-- CreateIndex
CREATE INDEX "M365Connection_status_lastSyncAt_idx" ON "M365Connection"("status", "lastSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_iCalUId_key" ON "CalendarEvent"("iCalUId");

-- CreateIndex
CREATE INDEX "CalendarEvent_startAt_idx" ON "CalendarEvent"("startAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_organizerEmail_idx" ON "CalendarEvent"("organizerEmail");

-- CreateIndex
CREATE INDEX "CalendarEventSighting_calendarEventId_idx" ON "CalendarEventSighting"("calendarEventId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEventSighting_connectionId_graphEventId_key" ON "CalendarEventSighting"("connectionId", "graphEventId");

-- CreateIndex
CREATE INDEX "M365TimeSuggestion_consultantId_date_idx" ON "M365TimeSuggestion"("consultantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "M365TimeSuggestion_consultantId_calendarEventId_key" ON "M365TimeSuggestion"("consultantId", "calendarEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Checkpoint_calendarEventId_consultantId_key" ON "Checkpoint"("calendarEventId", "consultantId");

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "M365Connection" ADD CONSTRAINT "M365Connection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventSighting" ADD CONSTRAINT "CalendarEventSighting_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventSighting" ADD CONSTRAINT "CalendarEventSighting_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "M365Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "M365TimeSuggestion" ADD CONSTRAINT "M365TimeSuggestion_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "Consultant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "M365TimeSuggestion" ADD CONSTRAINT "M365TimeSuggestion_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Matriz: INTEGRACOES_M365 (filho de ADMIN_ACESSOS).
INSERT INTO "Permission" ("id", "code", "name", "module", "sortOrder", "active", "parentId", "createdAt", "updatedAt")
SELECT 'perm_integracoes_m365', 'INTEGRACOES_M365', 'Integração Microsoft 365', 'Administração', 120, true, p."id", NOW(), NOW()
FROM "Permission" p WHERE p."code" = 'ADMIN_ACESSOS'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId", "canView", "canCreate", "canEdit", "canDelete", "updatedAt")
SELECT r."id", p."id", g."canView", g."canCreate", g."canEdit", g."canDelete", NOW()
FROM (VALUES
  ('INTEGRACOES_M365', 'ADMIN', true, false, false, false)
) AS g("code", "roleKey", "canView", "canCreate", "canEdit", "canDelete")
JOIN "Permission" p ON p."code" = g."code"
JOIN "Role" r ON r."key" = g."roleKey"
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
