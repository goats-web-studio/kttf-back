-- Стена игрока, управление лентой, одна подписка на человека — ADR-075.

-- AlterTable
ALTER TABLE "ForumTopic" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FeedCuration" (
    "itemId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedCuration_pkey" PRIMARY KEY ("itemId")
);

-- Тренер и его профиль игрока — один человек: подписка на страницу тренера
-- переезжает на игрока. Повтор (подписан на обоих) схлопывается.
INSERT INTO "Follow" ("userId", "targetType", "targetId", "createdAt")
SELECT f."userId", 'PLAYER', c."playerId", f."createdAt"
FROM "Follow" f
JOIN "Coach" c ON c."id" = f."targetId"
WHERE f."targetType" = 'COACH'
ON CONFLICT ("userId", "targetType", "targetId") DO NOTHING;

DELETE FROM "Follow" WHERE "targetType" = 'COACH';
