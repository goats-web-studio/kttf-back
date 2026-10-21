-- Расписание тренировок по дням — T3 (ADR-059, docs/11 3.3.1): занятия «день
-- недели + время» и набор в группу. Только добавляет.

-- CreateEnum
CREATE TYPE "TrainingEnrollment" AS ENUM ('OPEN', 'FEW', 'CLOSED');

-- AlterTable
ALTER TABLE "Training" ADD COLUMN     "enrollment" "TrainingEnrollment";

-- CreateTable
CREATE TABLE "TrainingSlot" (
    "id" TEXT NOT NULL,
    "trainingId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,

    CONSTRAINT "TrainingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingSlot_trainingId_idx" ON "TrainingSlot"("trainingId");

-- CreateIndex
CREATE INDEX "TrainingSlot_weekday_startMin_idx" ON "TrainingSlot"("weekday", "startMin");

-- AddForeignKey
ALTER TABLE "TrainingSlot" ADD CONSTRAINT "TrainingSlot_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "Training"("id") ON DELETE CASCADE ON UPDATE CASCADE;

