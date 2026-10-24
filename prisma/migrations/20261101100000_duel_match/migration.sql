-- Матч дуэли — ADR-068, docs/13 §3.7. Только добавляет: табло, перенос,
-- контакты и напоминание у дуэли, контакт у отклика, два типа уведомлений и
-- предмет форума DUEL. Раздел форума — следующей миграцией: новое значение
-- перечисления в той же транзакции использовать нельзя.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_RESCHEDULE';
ALTER TYPE "NotificationType" ADD VALUE 'DUEL_REMINDER';

-- AlterEnum
ALTER TYPE "ForumSubjectType" ADD VALUE 'DUEL';

-- AlterTable
ALTER TABLE "Duel" ADD COLUMN     "agreedAt" TIMESTAMP(3),
ADD COLUMN     "authorContact" TEXT,
ADD COLUMN     "opponentContact" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3),
ADD COLUMN     "rescheduleAt" TIMESTAMP(3),
ADD COLUMN     "rescheduleById" TEXT,
ADD COLUMN     "rescheduleEndsAt" TIMESTAMP(3),
ADD COLUMN     "rescheduleMessage" TEXT,
ADD COLUMN     "rescheduleStartsAt" TIMESTAMP(3),
ADD COLUMN     "sets" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- Уже назначенные до миграции: согласованы «давно», напоминание им положено.
UPDATE "Duel" SET "agreedAt" = "updatedAt" WHERE "startsAt" IS NOT NULL;

-- AlterTable
ALTER TABLE "DuelResponse" ADD COLUMN     "contact" TEXT;

-- CreateIndex
CREATE INDEX "Duel_status_startsAt_idx" ON "Duel"("status", "startsAt");
