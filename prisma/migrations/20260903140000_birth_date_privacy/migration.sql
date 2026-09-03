-- Приватность даты рождения: ADR-037.

-- AlterTable
-- Умолчание true: до появления полной даты профиль показывал только год.
-- Включённая галочка у существующих профилей ничего не меняет в том, что
-- о человеке видно.
ALTER TABLE "Player" ADD COLUMN     "birthYearOnly" BOOLEAN NOT NULL DEFAULT true;
