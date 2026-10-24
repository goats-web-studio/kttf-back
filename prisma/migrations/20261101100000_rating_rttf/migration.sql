-- Формула рейтинга RTTF — ADR-069. Только добавляет.
--
-- Новичок теперь считается по турнирам, а не по встречам: счётчик
-- турниров у игрока и его снимок на старте турнира. Бонус призёру —
-- отдельный тип события журнала.

-- AlterEnum
ALTER TYPE "RatingEventType" ADD VALUE 'BONUS';

-- AlterTable
ALTER TABLE "Player" ADD COLUMN "ratedTournaments" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Registration" ADD COLUMN "tournamentsAtStart" INTEGER;

-- Счётчик турниров из журнала: турнир засчитан, если в нём есть хотя бы
-- одна рейтинговая встреча игрока.
UPDATE "Player" AS p
SET "ratedTournaments" = sub.n
FROM (
  SELECT "playerId", COUNT(DISTINCT "tournamentId")::int AS n
  FROM "RatingEvent"
  WHERE "type" = 'MATCH' AND "tournamentId" IS NOT NULL
  GROUP BY "playerId"
) AS sub
WHERE p."id" = sub."playerId";

UPDATE "Player" SET "isProvisional" = ("ratedTournaments" < 5);

-- Снимок на старте для уже стартовавших турниров: сколько турниров игрок
-- успел сыграть до старта этого.
UPDATE "Registration" AS r
SET "tournamentsAtStart" = (
  SELECT COUNT(DISTINCT e."tournamentId")::int
  FROM "RatingEvent" AS e
  WHERE e."playerId" = r."playerId"
    AND e."type" = 'MATCH'
    AND e."tournamentId" IS NOT NULL
    AND e."tournamentId" <> r."tournamentId"
    AND e."createdAt" < COALESCE(t."startedAt", NOW())
)
FROM "Tournament" AS t
WHERE t."id" = r."tournamentId" AND r."ratingAtStart" IS NOT NULL;
