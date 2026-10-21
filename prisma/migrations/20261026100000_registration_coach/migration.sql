-- Тренер участника на турнире — T3 (ADR-059). Только добавляет; заполняет
-- уже существующие записи.

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "coachManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "coachName" TEXT,
ADD COLUMN     "coachPlayerId" TEXT;

-- CreateIndex
CREATE INDEX "Registration_coachPlayerId_idx" ON "Registration"("coachPlayerId");

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_coachPlayerId_fkey" FOREIGN KEY ("coachPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Начатые турниры: тренер из истории — период, покрывающий старт турнира
-- (без отметки старта — назначенную дату). Пересекающихся периодов быть не
-- должно; если есть — берётся начавшийся позже.
UPDATE "Registration" AS r
SET "coachPlayerId" = (
    SELECT ct."coachPlayerId"
    FROM "CoachTenure" AS ct
    WHERE ct."playerId" = r."playerId"
      AND ct."from" <= COALESCE(t."startedAt", t."startsAt")
      AND (ct."to" IS NULL OR ct."to" > COALESCE(t."startedAt", t."startsAt"))
    ORDER BY ct."from" DESC
    LIMIT 1
)
FROM "Tournament" AS t
WHERE t."id" = r."tournamentId"
  AND t."status" IN ('RUNNING', 'FINISHED', 'RATED');

-- Не начатые: тренер из анкеты как есть — дальше он идёт за анкетой.
-- Отменённые остаются без тренера.
UPDATE "Registration" AS r
SET "coachPlayerId" = p."coachPlayerId",
    "coachName" = p."coachName"
FROM "Tournament" AS t, "Player" AS p
WHERE t."id" = r."tournamentId"
  AND p."id" = r."playerId"
  AND t."status" IN ('DRAFT', 'PUBLISHED', 'REG_OPEN', 'REG_CLOSED');
