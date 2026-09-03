-- Анкета игрока и Telegram у аккаунта: ТЗ 2.2, ТЗ 2.1, ADR-035.

-- CreateEnum
CREATE TYPE "PlayingHand" AS ENUM ('RIGHT', 'LEFT');

-- CreateEnum
CREATE TYPE "Grip" AS ENUM ('SHAKEHAND', 'PENHOLD');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramId" TEXT;

-- AlterTable
-- Все колонки необязательны: профили, заведённые раньше, остаются
-- действительными и без анкеты.
ALTER TABLE "Player" ADD COLUMN     "birthDate" DATE,
ADD COLUMN     "playingHand" "PlayingHand",
ADD COLUMN     "grip" "Grip",
ADD COLUMN     "blade" TEXT,
ADD COLUMN     "rubberForehand" TEXT,
ADD COLUMN     "rubberBackhand" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "coachPlayerId" TEXT,
ADD COLUMN     "coachName" TEXT;

-- CreateIndex
CREATE INDEX "Player_coachPlayerId_idx" ON "Player"("coachPlayerId");

-- AddForeignKey
-- ON DELETE SET NULL: удаление тренера не должно уносить с собой учеников.
ALTER TABLE "Player" ADD CONSTRAINT "Player_coachPlayerId_fkey" FOREIGN KEY ("coachPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
