-- Новости KTTF: «от чьего лица» и версии на языках сайта — ADR-098.
--
-- Только добавляет: режим сообщения (по умолчанию «от себя» — как было),
-- зеркала режима у темы, язык оригинала новости и таблицу версий.
-- Данные: первые сообщения тем раздела «Новости KTTF», написанные
-- администратором, переходят в голос KTTF — это и есть новый режим по
-- умолчанию для раздела; язык оригинала таких тем — русский.

-- CreateEnum
CREATE TYPE "ForumAuthoredAs" AS ENUM ('SELF', 'KTTF', 'KTTF_WITH_COAUTHOR');

-- AlterTable
ALTER TABLE "ForumTopic" ADD COLUMN     "authoredAs" "ForumAuthoredAs" NOT NULL DEFAULT 'SELF',
ADD COLUMN     "lastPostAuthoredAs" "ForumAuthoredAs" NOT NULL DEFAULT 'SELF',
ADD COLUMN     "locale" TEXT;

-- AlterTable
ALTER TABLE "ForumPost" ADD COLUMN     "authoredAs" "ForumAuthoredAs" NOT NULL DEFAULT 'SELF';

-- CreateTable
CREATE TABLE "ForumTopicTranslation" (
    "topicId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ForumTopicTranslation_pkey" PRIMARY KEY ("topicId","locale")
);

-- AddForeignKey
ALTER TABLE "ForumTopicTranslation" ADD CONSTRAINT "ForumTopicTranslation_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ForumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumTopicTranslation" ADD CONSTRAINT "ForumTopicTranslation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Новости KTTF, уже опубликованные администратором, — от лица KTTF.
UPDATE "ForumPost" AS p
SET "authoredAs" = 'KTTF'
FROM "ForumTopic" AS t, "ForumSection" AS s, "User" AS u
WHERE p."topicId" = t."id"
  AND t."sectionId" = s."id"
  AND s."slug" = 'kttf'
  AND p."number" = 1
  AND p."authorId" = u."id"
  AND u."isAdmin" = true;

UPDATE "ForumTopic" AS t
SET "authoredAs" = p."authoredAs"
FROM "ForumPost" AS p
WHERE p."topicId" = t."id" AND p."number" = 1 AND p."authoredAs" <> 'SELF';

UPDATE "ForumTopic" AS t
SET "lastPostAuthoredAs" = p."authoredAs"
FROM "ForumPost" AS p
WHERE p."topicId" = t."id" AND p."number" = t."postsCount" AND p."authoredAs" <> 'SELF';

UPDATE "ForumTopic" AS t
SET "locale" = 'ru'
FROM "ForumSection" AS s
WHERE t."sectionId" = s."id" AND s."slug" = 'kttf' AND t."locale" IS NULL;
