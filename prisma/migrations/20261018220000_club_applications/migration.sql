-- Заявки клубов: ADR-047.
--
-- Зал, который хочет проводить турниры в KTTF, оставляет заявку на сайте,
-- администратор платформы видит её в кабинете. Таблица новая, данных
-- не трогает.

-- CreateEnum
CREATE TYPE "ClubApplicationStatus" AS ENUM ('NEW', 'DONE');

-- CreateTable
CREATE TABLE "ClubApplication" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "clubName" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT,
    "tableCount" INTEGER,
    "tournaments" TEXT,
    "message" TEXT,
    "status" "ClubApplicationStatus" NOT NULL DEFAULT 'NEW',
    "userId" TEXT,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),

    CONSTRAINT "ClubApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClubApplication_status_createdAt_idx" ON "ClubApplication"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ClubApplication_ipHash_createdAt_idx" ON "ClubApplication"("ipHash", "createdAt");

-- AddForeignKey
ALTER TABLE "ClubApplication" ADD CONSTRAINT "ClubApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

