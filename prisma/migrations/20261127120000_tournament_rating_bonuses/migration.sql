-- Бонусы рейтинга — настройки турнира (ADR-139). По умолчанию выключены.
-- Завершённые и обсчитанные турниры считались с бонусами (ADR-069): им
-- флаги ставятся, чтобы «Исправить результаты» (ADR-135) дало те же числа.

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN "prizeBonus" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "noviceBoost" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Tournament" SET "prizeBonus" = true, "noviceBoost" = true
WHERE "status" IN ('FINISHED', 'RATED');
