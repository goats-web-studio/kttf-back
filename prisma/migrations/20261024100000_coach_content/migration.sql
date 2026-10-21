-- Фото, видео, новости и акции тренера — T2.2 (ADR-059, docs/11 3.2.2).
-- Механика страницы клуба один в один. Только добавляет.

-- CreateTable
CREATE TABLE "CoachPost" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "kind" "PostKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "validUntil" DATE,
    "pinnedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "authorId" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,

    CONSTRAINT "CoachPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachMedia" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "youtubeId" TEXT,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,

    CONSTRAINT "CoachMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachPost_coachId_publishedAt_idx" ON "CoachPost"("coachId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "CoachPost_publishedAt_idx" ON "CoachPost"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "CoachMedia_coachId_sortOrder_idx" ON "CoachMedia"("coachId", "sortOrder");

-- CreateIndex
CREATE INDEX "CoachMedia_createdAt_idx" ON "CoachMedia"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CoachPost" ADD CONSTRAINT "CoachPost_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachPost" ADD CONSTRAINT "CoachPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachMedia" ADD CONSTRAINT "CoachMedia_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachMedia" ADD CONSTRAINT "CoachMedia_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

