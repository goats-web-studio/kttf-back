-- Заявка на пробную с сайта и уведомления внутри сайта — T3 (ADR-059,
-- docs/11 3.3.3). Только добавляет.
-- CreateEnum
CREATE TYPE "TrialFor" AS ENUM ('SELF', 'CHILD');

-- CreateEnum
CREATE TYPE "TrialStatus" AS ENUM ('NEW', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrialTargetKind" AS ENUM ('COACH', 'CLUB');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TRIAL_REQUEST_NEW', 'TRIAL_REQUEST_CANCELLED', 'TRIAL_REQUEST_ANSWERED');

-- AlterTable
ALTER TABLE "ClubStatDaily" ADD COLUMN     "trialRequests" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CoachStatDaily" ADD COLUMN     "trialRequests" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TrialRequest" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetKind" "TrialTargetKind" NOT NULL,
    "coachId" TEXT,
    "clubId" TEXT,
    "forWhom" "TrialFor" NOT NULL,
    "childAge" INTEGER,
    "preferredTime" TEXT,
    "comment" TEXT,
    "status" "TrialStatus" NOT NULL DEFAULT 'NEW',
    "reply" TEXT,
    "source" "TrafficSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,

    CONSTRAINT "TrialRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "data" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrialRequest_coachId_status_createdAt_idx" ON "TrialRequest"("coachId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TrialRequest_clubId_status_createdAt_idx" ON "TrialRequest"("clubId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TrialRequest_userId_createdAt_idx" ON "TrialRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TrialRequest_trainingId_userId_status_idx" ON "TrialRequest"("trainingId", "userId", "status");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "TrialRequest" ADD CONSTRAINT "TrialRequest_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "Training"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialRequest" ADD CONSTRAINT "TrialRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialRequest" ADD CONSTRAINT "TrialRequest_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialRequest" ADD CONSTRAINT "TrialRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialRequest" ADD CONSTRAINT "TrialRequest_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

