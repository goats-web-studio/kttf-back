-- Форум по мотивам RTTF — ADR-067. Только добавляет и переносит: у раздела
-- вместо одного типа предмета — список типов (в «Новостях клубов и
-- тренеров» их два) и признак «темы руками»; просмотры темы; докуда
-- человек дочитал тему; предупреждение модератора. Данные для новых типов
-- предмета — следующей миграцией: новое значение перечисления нельзя
-- использовать в той же транзакции, где оно добавлено.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'FORUM_WARNING';

-- AlterEnum
ALTER TYPE "ForumSubjectType" ADD VALUE 'CLUB_POST';
ALTER TYPE "ForumSubjectType" ADD VALUE 'COACH_POST';

-- AlterTable: тип предмета раздела — списком, с переносом
ALTER TABLE "ForumSection"
ADD COLUMN     "manualTopics" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "subjectTypes" "ForumSubjectType"[] DEFAULT ARRAY[]::"ForumSubjectType"[];

UPDATE "ForumSection" SET "subjectTypes" = ARRAY["subjectType"] WHERE "subjectType" IS NOT NULL;

-- Старая колонка "subjectType" остаётся в базе неиспользуемой: её читает код
-- форума до ADR-067, который ещё может работать с этой же базой (другие
-- ветки, старый образ API). Удаляется отдельной миграцией, когда такого кода
-- не останется.

-- AlterTable
ALTER TABLE "ForumTopic" ADD COLUMN     "viewsCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ForumTopicRead" (
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumTopicRead_pkey" PRIMARY KEY ("userId","topicId")
);

-- AddForeignKey
ALTER TABLE "ForumTopicRead" ADD CONSTRAINT "ForumTopicRead_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ForumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumTopicRead" ADD CONSTRAINT "ForumTopicRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
