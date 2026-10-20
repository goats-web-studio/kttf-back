-- Страница тренера — ADR-059, docs/11 4: тренер и заявка, тренировки тренера и клуба
-- со связью «вторая сторона подтверждает», документы, заслуги, дневная
-- статистика. Только добавляет.
-- CreateEnum
CREATE TYPE "CoachStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TrainingPlace" AS ENUM ('CLUB', 'VISIT', 'ONLINE');

-- CreateEnum
CREATE TYPE "CoachLanguage" AS ENUM ('KK', 'RU', 'EN');

-- CreateEnum
CREATE TYPE "TrainingKind" AS ENUM ('INDIVIDUAL', 'GROUP', 'SPLIT', 'KIDS_GROUP', 'VIDEO_REVIEW', 'CAMP', 'SPARRING', 'OTHER');

-- CreateEnum
CREATE TYPE "TrainingAudience" AS ENUM ('KIDS', 'TEENS', 'ADULT_BEGINNERS', 'AMATEURS', 'ATHLETES');

-- CreateEnum
CREATE TYPE "SportsRank" AS ENUM ('YOUTH_3', 'YOUTH_2', 'YOUTH_1', 'RANK_3', 'RANK_2', 'RANK_1', 'KMS', 'MS', 'MSMK', 'ZMS');

-- CreateEnum
CREATE TYPE "CoachCategory" AS ENUM ('HIGHEST', 'FIRST', 'SECOND', 'NONE');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('DIPLOMA', 'CERTIFICATE', 'COURSE', 'LICENSE', 'OTHER');

-- CreateEnum
CREATE TYPE "AchievementRole" AS ENUM ('AS_PLAYER', 'AS_COACH');

-- CreateEnum
CREATE TYPE "CoachPlan" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "TrainingAuthor" AS ENUM ('COACH', 'CLUB');

-- CreateEnum
CREATE TYPE "TrainingLink" AS ENUM ('NONE', 'PENDING', 'CONFIRMED', 'DECLINED');

-- CreateTable
CREATE TABLE "Coach" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "CoachStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "headline" TEXT,
    "about" TEXT,
    "coverUrl" TEXT,
    "photoUrl" TEXT,
    "coachingSince" INTEGER,
    "cityId" TEXT,
    "formats" "TrainingPlace"[] DEFAULT ARRAY[]::"TrainingPlace"[],
    "visitAreas" TEXT,
    "languages" "CoachLanguage"[] DEFAULT ARRAY[]::"CoachLanguage"[],
    "phone" TEXT,
    "whatsapp" TEXT,
    "telegram" TEXT,
    "instagram" TEXT,
    "primaryContact" "ContactKind",
    "sportsRank" "SportsRank",
    "coachCategory" "CoachCategory",
    "refereeCategory" TEXT,
    "education" TEXT,
    "profileReviewedAt" TIMESTAMP(3),
    "plan" "CoachPlan" NOT NULL DEFAULT 'FREE',
    "planUntil" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),
    "hiddenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Training" (
    "id" TEXT NOT NULL,
    "author" "TrainingAuthor" NOT NULL,
    "coachId" TEXT,
    "clubId" TEXT,
    "link" "TrainingLink" NOT NULL DEFAULT 'NONE',
    "linkAt" TIMESTAMP(3),
    "kind" "TrainingKind" NOT NULL,
    "audiences" "TrainingAudience"[],
    "kidsFromAge" INTEGER,
    "place" "TrainingPlace" NOT NULL,
    "venueName" TEXT,
    "venueAddress" TEXT,
    "title" TEXT NOT NULL,
    "schedule" TEXT,
    "priceKzt" INTEGER,
    "unit" "PriceUnit" NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Training_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachCredential" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT,
    "year" INTEGER,
    "fileKey" TEXT,
    "filePublic" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "CoachCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachAchievement" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "role" "AchievementRole" NOT NULL,
    "year" INTEGER,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "CoachAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachStatDaily" (
    "coachId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "source" "TrafficSource" NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "phoneClicks" INTEGER NOT NULL DEFAULT 0,
    "whatsappClicks" INTEGER NOT NULL DEFAULT 0,
    "telegramClicks" INTEGER NOT NULL DEFAULT 0,
    "instagramClicks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CoachStatDaily_pkey" PRIMARY KEY ("coachId","date","source")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coach_playerId_key" ON "Coach"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Coach_slug_key" ON "Coach"("slug");

-- CreateIndex
CREATE INDEX "Coach_status_hiddenAt_profileReviewedAt_idx" ON "Coach"("status", "hiddenAt", "profileReviewedAt");

-- CreateIndex
CREATE INDEX "Coach_cityId_idx" ON "Coach"("cityId");

-- CreateIndex
CREATE INDEX "Coach_userId_idx" ON "Coach"("userId");

-- CreateIndex
CREATE INDEX "Training_coachId_sortOrder_idx" ON "Training"("coachId", "sortOrder");

-- CreateIndex
CREATE INDEX "Training_clubId_sortOrder_idx" ON "Training"("clubId", "sortOrder");

-- CreateIndex
CREATE INDEX "Training_place_link_idx" ON "Training"("place", "link");

-- CreateIndex
CREATE INDEX "CoachCredential_coachId_sortOrder_idx" ON "CoachCredential"("coachId", "sortOrder");

-- CreateIndex
CREATE INDEX "CoachAchievement_coachId_sortOrder_idx" ON "CoachAchievement"("coachId", "sortOrder");

-- AddForeignKey
ALTER TABLE "Coach" ADD CONSTRAINT "Coach_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coach" ADD CONSTRAINT "Coach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coach" ADD CONSTRAINT "Coach_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Training" ADD CONSTRAINT "Training_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Training" ADD CONSTRAINT "Training_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachCredential" ADD CONSTRAINT "CoachCredential_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachAchievement" ADD CONSTRAINT "CoachAchievement_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachStatDaily" ADD CONSTRAINT "CoachStatDaily_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;

