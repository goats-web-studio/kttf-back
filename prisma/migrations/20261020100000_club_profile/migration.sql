-- Страница клуба — ADR-055, docs/09: поля профиля, часы, цены, дневная статистика.
-- Только добавляет: существующие клубы получают пустые удобства и план FREE.

-- CreateEnum
CREATE TYPE "ClubAmenity" AS ENUM ('AIR_CONDITIONING', 'SHOWER', 'PARKING', 'LOCKER_ROOM', 'WIFI', 'CAFE', 'SHOP', 'KIDS');

-- CreateEnum
CREATE TYPE "FloorType" AS ENUM ('SPORT_COVER', 'LINOLEUM', 'WOOD', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('PHONE', 'WHATSAPP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ClubPlan" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "PriceKind" AS ENUM ('TABLE_RENT', 'MEMBERSHIP', 'TRAINING', 'KIDS', 'OTHER');

-- CreateEnum
CREATE TYPE "PriceUnit" AS ENUM ('HOUR', 'VISIT', 'MONTH', 'COURSE', 'NONE');

-- CreateEnum
CREATE TYPE "TrafficSource" AS ENUM ('ORGANIC', 'CAMPAIGN');

-- AlterTable
ALTER TABLE "Club" ADD COLUMN     "amenities" "ClubAmenity"[] DEFAULT ARRAY[]::"ClubAmenity"[],
ADD COLUMN     "ceilingHeightCm" INTEGER,
ADD COLUMN     "coverUrl" TEXT,
ADD COLUMN     "floorType" "FloorType",
ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "hoursNote" TEXT,
ADD COLUMN     "plan" "ClubPlan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "planUntil" TIMESTAMP(3),
ADD COLUMN     "primaryContact" "ContactKind",
ADD COLUMN     "profileReviewedAt" TIMESTAMP(3),
ADD COLUMN     "tableBrand" TEXT,
ADD COLUMN     "telegram" TEXT,
ADD COLUMN     "twoGisUrl" TEXT,
ADD COLUMN     "website" TEXT;

-- CreateTable
CREATE TABLE "ClubHours" (
    "clubId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "opensMin" INTEGER NOT NULL,
    "closesMin" INTEGER NOT NULL,

    CONSTRAINT "ClubHours_pkey" PRIMARY KEY ("clubId","weekday","opensMin")
);

-- CreateTable
CREATE TABLE "ClubPrice" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kind" "PriceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "priceKzt" INTEGER NOT NULL,
    "unit" "PriceUnit" NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "ClubPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubStatDaily" (
    "clubId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "source" "TrafficSource" NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "phoneClicks" INTEGER NOT NULL DEFAULT 0,
    "whatsappClicks" INTEGER NOT NULL DEFAULT 0,
    "telegramClicks" INTEGER NOT NULL DEFAULT 0,
    "instagramClicks" INTEGER NOT NULL DEFAULT 0,
    "websiteClicks" INTEGER NOT NULL DEFAULT 0,
    "routeClicks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ClubStatDaily_pkey" PRIMARY KEY ("clubId","date","source")
);

-- CreateIndex
CREATE INDEX "ClubPrice_clubId_sortOrder_idx" ON "ClubPrice"("clubId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ClubHours" ADD CONSTRAINT "ClubHours_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPrice" ADD CONSTRAINT "ClubPrice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubStatDaily" ADD CONSTRAINT "ClubStatDaily_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

