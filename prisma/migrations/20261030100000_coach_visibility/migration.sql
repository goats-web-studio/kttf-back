-- Кому виден тренер игрока — ADR-066. Только добавляет: у всех профилей
-- остаётся как было — текущий и прежние тренеры видны.

-- CreateEnum
CREATE TYPE "CoachVisibility" AS ENUM ('ALL', 'CURRENT', 'NONE');

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "coachVisibility" "CoachVisibility" NOT NULL DEFAULT 'ALL';
