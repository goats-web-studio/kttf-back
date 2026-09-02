-- Офлайн-синхронизация консоли: ТС 6.3, ADR-026.

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SyncOperation" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "clientOpId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "basedOnVersion" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncOperation_tournamentId_clientOpId_key" ON "SyncOperation"("tournamentId", "clientOpId");

-- CreateIndex
CREATE INDEX "SyncOperation_tournamentId_seq_idx" ON "SyncOperation"("tournamentId", "seq");

-- AddForeignKey
ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
