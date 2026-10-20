-- «Записаться» второй стороне тренировки — ADR-059: клубу — к тренеру на его
-- тренировку в зале, тренеру — в группу клуба; кто записывает и принимает
-- оплату у тренировки тренера в клубе KTTF. Только добавляет.

-- CreateEnum
CREATE TYPE "TrainingBooking" AS ENUM ('COACH', 'CLUB');

-- AlterTable
ALTER TABLE "ClubStatDaily" ADD COLUMN     "coachTrainingClicks" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CoachStatDaily" ADD COLUMN     "clubGroupClicks" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Training" ADD COLUMN     "booking" "TrainingBooking" NOT NULL DEFAULT 'COACH';

