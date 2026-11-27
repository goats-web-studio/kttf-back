-- Досрочный старт финала (ADR-143): позиция сетки заранее закреплена за
-- местом в группе, которая ещё доигрывается. { groupId, group, place }.

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "seedA" JSONB,
ADD COLUMN "seedB" JSONB;
