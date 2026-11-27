-- Финал вкруг «с зачётом» (ADR-134): встреча из группы переносится копией в
-- финальную группу. Ссылка на исходную встречу отличает копию: её не считают
-- рейтинг, история и статистика игрока.

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "carriedFromId" TEXT;

-- CreateIndex
CREATE INDEX "Match_carriedFromId_idx" ON "Match"("carriedFromId");

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_carriedFromId_fkey" FOREIGN KEY ("carriedFromId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
