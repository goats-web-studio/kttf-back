-- Просьба исправить имя подтверждённого профиля — ADR-102.
--
-- Имя, год рождения и пол игрового профиля человек сам не меняет: их задал
-- организатор. Просьба идёт той же очередью заявок, что удаление и
-- восстановление (ADR-095), новым видом RENAME.

-- AlterEnum
ALTER TYPE "AccountRequestKind" ADD VALUE 'RENAME';

-- AlterTable
ALTER TABLE "AccountRequest" ADD COLUMN     "claimedMiddleName" TEXT,
ADD COLUMN     "claimedBirthYear" INTEGER,
ADD COLUMN     "claimedGender" TEXT;
