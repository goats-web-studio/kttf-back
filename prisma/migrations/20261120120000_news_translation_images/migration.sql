-- Редактор новостей KTTF: фото на каждом языке — ADR-099.
--
-- У версии новости вместо одной обложки — фото по порядку, как у сообщения
-- (`ForumPost.images`), и место версии среди других. Старая обложка
-- переносится первым фото версии; версия без обложки — без фото (тогда
-- показываются фото оригинала, как и было). Место — по времени создания.

-- AlterTable
ALTER TABLE "ForumTopicTranslation" ADD COLUMN     "images" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- Обложка — первым фото.
UPDATE "ForumTopicTranslation"
SET "images" = jsonb_build_array("image")
WHERE "image" IS NOT NULL AND jsonb_typeof("image") = 'object';

-- Место версии — как их показывали: по времени создания.
UPDATE "ForumTopicTranslation" AS t
SET "position" = ranked."position"
FROM (
  SELECT "topicId", "locale",
         (ROW_NUMBER() OVER (PARTITION BY "topicId" ORDER BY "createdAt", "locale") - 1)::INTEGER AS "position"
  FROM "ForumTopicTranslation"
) AS ranked
WHERE t."topicId" = ranked."topicId" AND t."locale" = ranked."locale";

-- AlterTable
ALTER TABLE "ForumTopicTranslation" DROP COLUMN "image";
