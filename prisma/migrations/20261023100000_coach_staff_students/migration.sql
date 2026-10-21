-- Тренерский штаб клуба и история учеников — T2.1 (ADR-059, docs/11 3.2.1).
-- Только добавляет; переносит текущие связи.

-- CreateEnum
CREATE TYPE "ClubCoachStatus" AS ENUM ('REQUESTED_BY_COACH', 'INVITED_BY_CLUB', 'ACTIVE');

-- CreateTable
CREATE TABLE "ClubCoach" (
    "clubId" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "status" "ClubCoachStatus" NOT NULL,
    "position" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ClubCoach_pkey" PRIMARY KEY ("clubId","coachId")
);

-- CreateTable
CREATE TABLE "CoachTenure" (
    "playerId" TEXT NOT NULL,
    "coachPlayerId" TEXT NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3),

    CONSTRAINT "CoachTenure_pkey" PRIMARY KEY ("playerId","coachPlayerId","from")
);

-- CreateIndex
CREATE INDEX "ClubCoach_coachId_idx" ON "ClubCoach"("coachId");

-- CreateIndex
CREATE INDEX "CoachTenure_coachPlayerId_idx" ON "CoachTenure"("coachPlayerId");

-- CreateIndex
CREATE INDEX "CoachTenure_playerId_idx" ON "CoachTenure"("playerId");

-- AddForeignKey
ALTER TABLE "ClubCoach" ADD CONSTRAINT "ClubCoach_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubCoach" ADD CONSTRAINT "ClubCoach_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachTenure" ADD CONSTRAINT "CoachTenure_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachTenure" ADD CONSTRAINT "CoachTenure_coachPlayerId_fkey" FOREIGN KEY ("coachPlayerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Перенос: текущий тренер из анкеты — одной записью с даты заведения
-- профиля игрока. Даты заполнения анкеты в базе нет.
INSERT INTO "CoachTenure" ("playerId", "coachPlayerId", "from", "to")
SELECT "id", "coachPlayerId", "createdAt", NULL
FROM "Player"
WHERE "coachPlayerId" IS NOT NULL;

-- Перенос: тренер с подтверждённой тренировкой в клубе — в штабе клуба.
-- Дата подтверждения — самая ранняя подтверждённая связь пары.
INSERT INTO "ClubCoach" ("clubId", "coachId", "status", "requestedAt", "confirmedAt")
SELECT "clubId", "coachId", 'ACTIVE', COALESCE(MIN("linkAt"), CURRENT_TIMESTAMP), COALESCE(MIN("linkAt"), CURRENT_TIMESTAMP)
FROM "Training"
WHERE "link" = 'CONFIRMED' AND "clubId" IS NOT NULL AND "coachId" IS NOT NULL
GROUP BY "clubId", "coachId";
