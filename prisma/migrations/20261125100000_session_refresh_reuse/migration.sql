-- Прежний refresh-токен на минуту после замены — ADR-109.
ALTER TABLE "Session" ADD COLUMN "previousRefreshToken" TEXT,
ADD COLUMN "rotatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Session_previousRefreshToken_key" ON "Session"("previousRefreshToken");
