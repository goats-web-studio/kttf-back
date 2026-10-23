-- Форум — ADR-064, docs/12. Только добавляет: разделы, темы, сообщения,
-- «нравится», подписки, жалобы, запреты и три типа уведомлений. Семь
-- разделов на старте — docs/12 4.1; дальше их ведёт администратор.
-- CreateEnum
CREATE TYPE "ForumSubjectType" AS ENUM ('TOURNAMENT', 'CLUB', 'COACH', 'PRODUCT');

-- CreateEnum
CREATE TYPE "ForumReportReason" AS ENUM ('SPAM', 'ABUSE', 'OFFTOPIC', 'OTHER');

-- CreateEnum
CREATE TYPE "ForumReportStatus" AS ENUM ('OPEN', 'ACCEPTED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'FORUM_REPLY';
ALTER TYPE "NotificationType" ADD VALUE 'FORUM_TOPIC_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'FORUM_POST_HIDDEN';

-- CreateTable
CREATE TABLE "ForumSection" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "subjectType" "ForumSubjectType",
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumTopic" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "authorId" TEXT,
    "title" TEXT NOT NULL,
    "subjectType" "ForumSubjectType",
    "subjectId" TEXT,
    "postsCount" INTEGER NOT NULL DEFAULT 0,
    "lastPostAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPostAuthorId" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumPost" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "authorId" TEXT,
    "number" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "quotePostId" TEXT,
    "quoteText" TEXT,
    "images" JSONB NOT NULL DEFAULT '[]',
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,

    CONSTRAINT "ForumPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumLike" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumLike_pkey" PRIMARY KEY ("postId","userId")
);

-- CreateTable
CREATE TABLE "ForumSubscription" (
    "topicId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumSubscription_pkey" PRIMARY KEY ("topicId","userId")
);

-- CreateTable
CREATE TABLE "ForumReport" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ForumReportReason" NOT NULL,
    "comment" TEXT,
    "status" "ForumReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ForumReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForumMute" (
    "userId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumMute_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ForumSection_slug_key" ON "ForumSection"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ForumSection_subjectType_key" ON "ForumSection"("subjectType");

-- CreateIndex
CREATE INDEX "ForumTopic_sectionId_lastPostAt_idx" ON "ForumTopic"("sectionId", "lastPostAt" DESC);

-- CreateIndex
CREATE INDEX "ForumTopic_lastPostAt_idx" ON "ForumTopic"("lastPostAt" DESC);

-- CreateIndex
CREATE INDEX "ForumTopic_authorId_createdAt_idx" ON "ForumTopic"("authorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ForumTopic_subjectType_subjectId_key" ON "ForumTopic"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "ForumPost_authorId_createdAt_idx" ON "ForumPost"("authorId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumPost_topicId_number_key" ON "ForumPost"("topicId", "number");

-- CreateIndex
CREATE INDEX "ForumSubscription_userId_idx" ON "ForumSubscription"("userId");

-- CreateIndex
CREATE INDEX "ForumReport_status_createdAt_idx" ON "ForumReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ForumReport_reporterId_createdAt_idx" ON "ForumReport"("reporterId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ForumReport_postId_reporterId_key" ON "ForumReport"("postId", "reporterId");

-- AddForeignKey
ALTER TABLE "ForumTopic" ADD CONSTRAINT "ForumTopic_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ForumSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumTopic" ADD CONSTRAINT "ForumTopic_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumTopic" ADD CONSTRAINT "ForumTopic_lastPostAuthorId_fkey" FOREIGN KEY ("lastPostAuthorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ForumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPost" ADD CONSTRAINT "ForumPost_quotePostId_fkey" FOREIGN KEY ("quotePostId") REFERENCES "ForumPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumLike" ADD CONSTRAINT "ForumLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumLike" ADD CONSTRAINT "ForumLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumSubscription" ADD CONSTRAINT "ForumSubscription_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ForumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumSubscription" ADD CONSTRAINT "ForumSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumReport" ADD CONSTRAINT "ForumReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumReport" ADD CONSTRAINT "ForumReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumReport" ADD CONSTRAINT "ForumReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumMute" ADD CONSTRAINT "ForumMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumMute" ADD CONSTRAINT "ForumMute_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Разделы на старте
INSERT INTO "ForumSection" ("id", "slug", "title", "description", "position", "subjectType") VALUES
    (gen_random_uuid(), 'tennis', 'Настольный теннис', 'Техника, тактика, игроки, турниры мира', 10, NULL),
    (gen_random_uuid(), 'tournaments', 'Турниры', 'Обсуждения турниров KTTF: формат, результаты, организация', 20, 'TOURNAMENT'),
    (gen_random_uuid(), 'clubs', 'Клубы и залы', 'Отзывы о клубах, где поиграть, условия залов', 30, 'CLUB'),
    (gen_random_uuid(), 'coaches', 'Тренеры и тренировки', 'Отзывы о тренерах, группы, как тренироваться', 40, 'COACH'),
    (gen_random_uuid(), 'equipment', 'Инвентарь', 'Основания, накладки, столы: отзывы и советы', 50, 'PRODUCT'),
    (gen_random_uuid(), 'site', 'Пожелания по сайту', 'Что улучшить в KTTF, ошибки и идеи', 60, NULL),
    (gen_random_uuid(), 'other', 'Всякое разное', 'Всё, что не подошло в другие разделы', 70, NULL);
