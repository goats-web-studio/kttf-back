-- Вход по логину и паролю вместо одноразового кода: ТЗ 2.1, ADR-034.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "login" TEXT,
ADD COLUMN     "passwordHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- DropTable
-- Коды больше не выдаются: провайдера SMS не будет, а адаптер в лог — это
-- вход в любой аккаунт для всякого, у кого есть доступ к логам.
DROP TABLE "AuthCode";
