-- Заявки вне рейтинговой планки на рассмотрение организатора: ADR-044.

-- AlterEnum
-- Новые значения в этой же миграции не используются: Postgres не даёт
-- пользоваться значением перечня в той транзакции, где оно добавлено.
ALTER TYPE "RegistrationStatus" ADD VALUE 'PENDING';
ALTER TYPE "RegistrationStatus" ADD VALUE 'REJECTED';

-- AlterTable
-- Умолчание false: у существующих турниров планка остаётся жёсткой, как и
-- была, пока организатор сам не включит рассмотрение заявок.
ALTER TABLE "Tournament" ADD COLUMN     "reviewOutOfRating" BOOLEAN NOT NULL DEFAULT false;
