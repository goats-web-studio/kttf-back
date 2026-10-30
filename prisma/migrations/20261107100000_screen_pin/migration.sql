-- Слайд экрана зала, закреплённый из консоли, ADR-082. Только добавляет.
ALTER TABLE "Tournament" ADD COLUMN "screenPin" TEXT;
ALTER TABLE "Tournament" ADD COLUMN "screenPinUntil" TIMESTAMP(3);
