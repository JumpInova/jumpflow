-- Consultas — Fase C3 (IA + agendamento). docs/consultas/ESPECIFICACAO.md §6.
--
-- 1) ConsultaSchedule: envio agendado de visão OU painel por e-mail (XLSX),
--    executado com a permissão de CADA destinatário.
-- 2) ConsultaScheduleRun: uma linha por (agendamento, janela) — UNIQUE é a
--    idempotência; `leaseUntil` é o claim entre instâncias.
-- 3) ConsultaAiUsage: rate limit persistido do assistente de IA (contador por
--    usuário por minuto). Não guarda o texto do usuário.
--
-- Aditivo: só CREATE TYPE/TABLE/INDEX/CONSTRAINT novos.

-- CreateEnum
CREATE TYPE "ConsultaScheduleFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ConsultaScheduleRunStatus" AS ENUM ('RUNNING', 'SENT', 'PARTIAL', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "ConsultaSchedule" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "viewId" TEXT,
    "panelId" TEXT,
    "name" TEXT NOT NULL,
    "frequency" "ConsultaScheduleFrequency" NOT NULL,
    "hour" INTEGER NOT NULL,
    "weekday" INTEGER,
    "monthDay" INTEGER,
    "recipientUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activeSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultaSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultaScheduleRun" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "status" "ConsultaScheduleRunStatus" NOT NULL DEFAULT 'RUNNING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "results" JSONB,

    CONSTRAINT "ConsultaScheduleRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultaAiUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ConsultaAiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultaSchedule_ownerId_idx" ON "ConsultaSchedule"("ownerId");

-- CreateIndex
CREATE INDEX "ConsultaSchedule_active_idx" ON "ConsultaSchedule"("active");

-- CreateIndex
CREATE INDEX "ConsultaSchedule_viewId_idx" ON "ConsultaSchedule"("viewId");

-- CreateIndex
CREATE INDEX "ConsultaSchedule_panelId_idx" ON "ConsultaSchedule"("panelId");

-- CreateIndex
CREATE INDEX "ConsultaScheduleRun_status_leaseUntil_idx" ON "ConsultaScheduleRun"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultaScheduleRun_scheduleId_windowKey_key" ON "ConsultaScheduleRun"("scheduleId", "windowKey");

-- CreateIndex
CREATE INDEX "ConsultaAiUsage_windowStart_idx" ON "ConsultaAiUsage"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultaAiUsage_userId_windowStart_key" ON "ConsultaAiUsage"("userId", "windowStart");

-- AddForeignKey
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "ConsultaView"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "ConsultaPanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultaScheduleRun" ADD CONSTRAINT "ConsultaScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ConsultaSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultaAiUsage" ADD CONSTRAINT "ConsultaAiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exatamente um alvo por agendamento (visão XOR painel).
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_target_check"
  CHECK (num_nonnulls("viewId", "panelId") = 1);

-- Faixas válidas do horário (o Zod já valida; o banco garante).
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_hour_check"
  CHECK ("hour" BETWEEN 0 AND 23);
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_weekday_check"
  CHECK ("weekday" IS NULL OR "weekday" BETWEEN 1 AND 7);
ALTER TABLE "ConsultaSchedule" ADD CONSTRAINT "ConsultaSchedule_monthDay_check"
  CHECK ("monthDay" IS NULL OR "monthDay" BETWEEN 1 AND 31);
