-- «Записаться» второй стороне тренировки — ADR-059: клубу — к тренеру на его
-- тренировку в зале, тренеру — в группу клуба. Только добавляет.

-- AlterTable
ALTER TABLE "ClubStatDaily" ADD COLUMN     "coachTrainingClicks" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CoachStatDaily" ADD COLUMN     "clubGroupClicks" INTEGER NOT NULL DEFAULT 0;

