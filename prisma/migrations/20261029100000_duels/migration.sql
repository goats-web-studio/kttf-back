-- Дуэли и спарринги — ADR-065, docs/13. Только добавляет: предложения,
-- варианты времени, отклики, ссылку события журнала на дуэль и восемь
-- типов уведомлений. Match и турниры не трогаются: дуэль — своя запись
-- со счётом в партиях.
-- CreateEnum
CREATE TYPE "DuelKind" AS ENUM ('DUEL', 'SPARRING');

-- CreateEnum
CREATE TYPE "DuelStatus" AS ENUM ('OPEN', 'CHALLENGE', 'SCHEDULED', 'REPORTED', 'DISPUTED', 'COMPLETED', 'UNCONFIRMED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DuelResponseStatus" AS ENUM ('NEW', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DuelRatingSkip" AS ENUM ('PAIR', 'PLAYER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'DUEL_CHALLENGE';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_RESPONSE';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_RESULT';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_DISPUTED';

-- AlterTable
ALTER TABLE "RatingEvent" ADD COLUMN     "duelId" TEXT;

-- CreateTable
CREATE TABLE "Duel" (
    "id" TEXT NOT NULL,
    "kind" "DuelKind" NOT NULL,
    "rated" BOOLEAN NOT NULL,
    "bestOf" INTEGER,
    "status" "DuelStatus" NOT NULL,
    "authorId" TEXT NOT NULL,
    "challenge" BOOLEAN NOT NULL DEFAULT false,
    "opponentId" TEXT,
    "clubId" TEXT,
    "venueName" TEXT,
    "venueAddress" TEXT,
    "cityId" TEXT NOT NULL,
    "note" TEXT,
    "slotsFrom" TIMESTAMP(3) NOT NULL,
    "slotsUntil" TIMESTAMP(3) NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "playAt" TIMESTAMP(3) NOT NULL,
    "winnerId" TEXT,
    "winnerSets" INTEGER,
    "loserSets" INTEGER,
    "reportedById" TEXT,
    "reportedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "disputeComment" TEXT,
    "disputedAt" TIMESTAMP(3),
    "resolutionComment" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "ratingSkipped" "DuelRatingSkip",
    "provisional" BOOLEAN,
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "annulledAt" TIMESTAMP(3),
    "annulReason" TEXT,
    "annulledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Duel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuelSlot" (
    "id" TEXT NOT NULL,
    "duelId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DuelSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuelResponse" (
    "id" TEXT NOT NULL,
    "duelId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "slotId" TEXT,
    "proposedStartsAt" TIMESTAMP(3),
    "proposedEndsAt" TIMESTAMP(3),
    "message" TEXT,
    "status" "DuelResponseStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "DuelResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Duel_status_slotsUntil_idx" ON "Duel"("status", "slotsUntil");

-- CreateIndex
CREATE INDEX "Duel_status_reportedAt_idx" ON "Duel"("status", "reportedAt");

-- CreateIndex
CREATE INDEX "Duel_cityId_status_playAt_idx" ON "Duel"("cityId", "status", "playAt");

-- CreateIndex
CREATE INDEX "Duel_authorId_createdAt_idx" ON "Duel"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "Duel_opponentId_createdAt_idx" ON "Duel"("opponentId", "createdAt");

-- CreateIndex
CREATE INDEX "Duel_rated_createdAt_idx" ON "Duel"("rated", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Duel_rated_startsAt_idx" ON "Duel"("rated", "startsAt");

-- CreateIndex
CREATE INDEX "DuelSlot_duelId_startsAt_idx" ON "DuelSlot"("duelId", "startsAt");

-- CreateIndex
CREATE INDEX "DuelResponse_duelId_status_idx" ON "DuelResponse"("duelId", "status");

-- CreateIndex
CREATE INDEX "DuelResponse_playerId_createdAt_idx" ON "DuelResponse"("playerId", "createdAt");

-- CreateIndex
CREATE INDEX "RatingEvent_duelId_idx" ON "RatingEvent"("duelId");

-- AddForeignKey
ALTER TABLE "RatingEvent" ADD CONSTRAINT "RatingEvent_duelId_fkey" FOREIGN KEY ("duelId") REFERENCES "Duel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_opponentId_fkey" FOREIGN KEY ("opponentId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_annulledById_fkey" FOREIGN KEY ("annulledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuelSlot" ADD CONSTRAINT "DuelSlot_duelId_fkey" FOREIGN KEY ("duelId") REFERENCES "Duel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuelResponse" ADD CONSTRAINT "DuelResponse_duelId_fkey" FOREIGN KEY ("duelId") REFERENCES "Duel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuelResponse" ADD CONSTRAINT "DuelResponse_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuelResponse" ADD CONSTRAINT "DuelResponse_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "DuelSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

