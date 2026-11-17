-- Согласие на обработку персональных данных и удаление аккаунта, ADR-091 и ADR-092. Только добавляет.
ALTER TABLE "User" ADD COLUMN "privacyConsentAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "privacyConsentVersion" TEXT;
ALTER TABLE "Player" ADD COLUMN "deletedAt" TIMESTAMP(3);
