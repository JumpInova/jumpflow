-- Microsoft 365 (M2: E-mail de atas → ata do Checkpoint → cards) — parte 2/2.
--
-- Aditivo:
-- - CalendarEvent.redactedAt (opcional): evento redigido pelo organizador; só a
--   visão dele volta a gravar conteúdo (achado menor da validação da M1).
-- - CheckpointEmailMinutes: estado da busca da ata por e-mail + metadados da
--   origem (internetMessageId ÚNICO = um e-mail alimenta no máximo um
--   Checkpoint). Nunca guarda assunto, remetente, corpo ou anexo.
-- - CheckpointActionItem: card de Ação/próximo passo (PENDING|ACCEPTED|DONE|DISMISSED).
-- Nenhum dado existente é alterado.

-- CreateEnum
CREATE TYPE "CheckpointEmailMinutesStatus" AS ENUM ('SEARCHING', 'AMBIGUOUS', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "CheckpointActionItemStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DONE', 'DISMISSED');

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "redactedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CheckpointEmailMinutes" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "status" "CheckpointEmailMinutesStatus" NOT NULL DEFAULT 'SEARCHING',
    "internetMessageId" TEXT,
    "webLink" TEXT,
    "receivedAt" TIMESTAMP(3),
    "attachmentsUsed" INTEGER NOT NULL DEFAULT 0,
    "attachmentsSkipped" INTEGER NOT NULL DEFAULT 0,
    "aiSummary" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckpointEmailMinutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckpointActionItem" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerText" TEXT,
    "dueDate" DATE,
    "dueText" TEXT,
    "sourceQuote" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT true,
    "status" "CheckpointActionItemStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckpointActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckpointEmailMinutes_checkpointId_key" ON "CheckpointEmailMinutes"("checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckpointEmailMinutes_internetMessageId_key" ON "CheckpointEmailMinutes"("internetMessageId");

-- CreateIndex
CREATE INDEX "CheckpointEmailMinutes_status_lastCheckedAt_idx" ON "CheckpointEmailMinutes"("status", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "CheckpointActionItem_checkpointId_status_idx" ON "CheckpointActionItem"("checkpointId", "status");

-- AddForeignKey
ALTER TABLE "CheckpointEmailMinutes" ADD CONSTRAINT "CheckpointEmailMinutes_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointActionItem" ADD CONSTRAINT "CheckpointActionItem_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckpointActionItem" ADD CONSTRAINT "CheckpointActionItem_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
