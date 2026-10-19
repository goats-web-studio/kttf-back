-- Инвентарь игрока и столы клуба из каталога маркета — ADR-058, docs/10 4.2. Только добавляет.

-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "bladeProductId" TEXT,
ADD COLUMN     "rubberBackhandProductId" TEXT,
ADD COLUMN     "rubberForehandProductId" TEXT;

-- CreateTable
CREATE TABLE "ClubTable" (
    "clubId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ClubTable_pkey" PRIMARY KEY ("clubId","productId")
);

-- CreateIndex
CREATE INDEX "ClubTable_productId_idx" ON "ClubTable"("productId");

-- CreateIndex
CREATE INDEX "Player_bladeProductId_idx" ON "Player"("bladeProductId");

-- CreateIndex
CREATE INDEX "Player_rubberForehandProductId_idx" ON "Player"("rubberForehandProductId");

-- CreateIndex
CREATE INDEX "Player_rubberBackhandProductId_idx" ON "Player"("rubberBackhandProductId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_bladeProductId_fkey" FOREIGN KEY ("bladeProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_rubberForehandProductId_fkey" FOREIGN KEY ("rubberForehandProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_rubberBackhandProductId_fkey" FOREIGN KEY ("rubberBackhandProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTable" ADD CONSTRAINT "ClubTable_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubTable" ADD CONSTRAINT "ClubTable_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

