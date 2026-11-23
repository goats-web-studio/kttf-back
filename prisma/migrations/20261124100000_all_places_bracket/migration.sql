-- Сетка «на все места» — ADR-104.
ALTER TABLE "Match" ADD COLUMN "placeFrom" INTEGER,
ADD COLUMN "placeTo" INTEGER,
ADD COLUMN "winnerPlace" INTEGER,
ADD COLUMN "loserPlace" INTEGER;
