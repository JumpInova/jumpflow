-- Microsoft 365 (M3: transcrição do Teams → ata do Checkpoint) — parte 2/2.
--
-- Aditivo:
-- - CheckpointTeamsTranscript: máquina de estados da transcrição do Teams de UM
--   Checkpoint (PENDING → WAITING_TRANSCRIPT → GENERATING → DONE |
--   NO_TRANSCRIPT | FAILED), com claim atômico (leaseOwner/leaseUntil) e só
--   contadores/códigos. O VTT bruto e nomes/falas de participantes NUNCA são
--   guardados aqui.
-- Nenhum dado existente é alterado.

-- CreateEnum
CREATE TYPE "CheckpointTranscriptStatus" AS ENUM ('PENDING', 'WAITING_TRANSCRIPT', 'GENERATING', 'DONE', 'NO_TRANSCRIPT', 'FAILED');

-- CreateEnum
CREATE TYPE "CheckpointTranscriptMode" AS ENUM ('GENERATE', 'SUPPLEMENT');

-- CreateTable
CREATE TABLE "CheckpointTeamsTranscript" (
    "id" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "status" "CheckpointTranscriptStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "CheckpointTranscriptMode",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "accessDeniedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "transcriptsUsed" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "aiSummary" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckpointTeamsTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckpointTeamsTranscript_checkpointId_key" ON "CheckpointTeamsTranscript"("checkpointId");

-- CreateIndex
CREATE INDEX "CheckpointTeamsTranscript_status_nextAttemptAt_idx" ON "CheckpointTeamsTranscript"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "CheckpointTeamsTranscript" ADD CONSTRAINT "CheckpointTeamsTranscript_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
