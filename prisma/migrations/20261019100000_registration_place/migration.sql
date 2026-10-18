-- Итоговое место в заявке: ADR-048.
--
-- Профиль игрока показывает место в каждом турнире и призовые места.
-- Считать их на каждый показ значило бы поднимать весь турнир, поэтому
-- место записывается при завершении. Турниры, завершённые раньше,
-- досчитываются при первом обращении: placesAt у них пуст.

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "placesAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN     "place" INTEGER,
ADD COLUMN     "placeTo" INTEGER;

