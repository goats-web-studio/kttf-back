-- Новости, акции, фото и видео клуба — ADR-055, docs/09 3.2. Только добавляет.

-- CreateEnum
CREATE TYPE "PostKind" AS ENUM ('NEWS', 'PROMO');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'VIDEO');

-- CreateTable
CREATE TABLE "ClubPost" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
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

    CONSTRAINT "ClubPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMedia" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
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

    CONSTRAINT "ClubMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubPost_clubId_publishedAt_idx" ON "ClubPost"("clubId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ClubPost_publishedAt_idx" ON "ClubPost"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ClubMedia_clubId_sortOrder_idx" ON "ClubMedia"("clubId", "sortOrder");

-- CreateIndex
CREATE INDEX "ClubMedia_createdAt_idx" ON "ClubMedia"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ClubPost" ADD CONSTRAINT "ClubPost_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPost" ADD CONSTRAINT "ClubPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMedia" ADD CONSTRAINT "ClubMedia_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMedia" ADD CONSTRAINT "ClubMedia_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

