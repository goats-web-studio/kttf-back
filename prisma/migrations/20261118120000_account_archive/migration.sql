-- Удаление аккаунта заявкой через администратора, архив профиля и восстановление — ADR-095. Только добавляет.

-- CreateEnum
CREATE TYPE "AccountRequestKind" AS ENUM ('DELETE', 'RESTORE');

-- CreateEnum
CREATE TYPE "AccountRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AccountRequest" (
    "id" TEXT NOT NULL,
    "kind" "AccountRequestKind" NOT NULL,
    "status" "AccountRequestStatus" NOT NULL DEFAULT 'PENDING',
    "userId" TEXT,
    "playerId" TEXT,
    "reason" TEXT,
    "claimedLastName" TEXT,
    "claimedFirstName" TEXT,
    "answer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "AccountRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerArchive" (
    "playerId" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "snapshot" JSONB,
    "photoKey" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerArchive_pkey" PRIMARY KEY ("playerId")
);

-- CreateIndex
CREATE INDEX "AccountRequest_status_createdAt_idx" ON "AccountRequest"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountRequest_userId_kind_createdAt_idx" ON "AccountRequest"("userId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountRequest_playerId_idx" ON "AccountRequest"("playerId");

-- CreateIndex
CREATE INDEX "PlayerArchive_phoneHash_idx" ON "PlayerArchive"("phoneHash");

-- CreateIndex
CREATE INDEX "PlayerArchive_purgeAt_idx" ON "PlayerArchive"("purgeAt");

-- AddForeignKey
ALTER TABLE "AccountRequest" ADD CONSTRAINT "AccountRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRequest" ADD CONSTRAINT "AccountRequest_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRequest" ADD CONSTRAINT "AccountRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerArchive" ADD CONSTRAINT "PlayerArchive_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

