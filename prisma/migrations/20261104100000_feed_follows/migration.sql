-- Лента и подписки — ADR-073. Только добавляет.

-- CreateEnum
CREATE TYPE "FollowTarget" AS ENUM ('CLUB', 'COACH', 'PLAYER');

-- CreateTable
CREATE TABLE "Follow" (
    "userId" TEXT NOT NULL,
    "targetType" "FollowTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("userId","targetType","targetId")
);

-- CreateIndex
CREATE INDEX "Follow_targetType_targetId_idx" ON "Follow"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Разделы форума, на которых стоит лента. Новости KTTF — без тем руками:
-- заводит их только администратор. Записи игроков — любой с профилем.
INSERT INTO "ForumSection" ("id", "slug", "title", "description", "position", "subjectTypes", "manualTopics") VALUES
    (gen_random_uuid(), 'kttf', 'Новости KTTF', 'Новости портала: турниры, рейтинг, новое на сайте', 1, '{}', false),
    (gen_random_uuid(), 'posts', 'Записи игроков', 'Записи игроков с фото — видны в ленте на главной', 5, '{}', true)
ON CONFLICT ("slug") DO NOTHING;
