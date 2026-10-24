-- Игровой профиль подтверждён организатором — ADR-072.
ALTER TABLE "Player" ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- Игровые — заведённые организатором (без аккаунта) и все, у кого уже есть
-- турнир или событие рейтинга. Остальные — анкеты, которые люди завели
-- сами: рейтинга у них не было, было только умолчание 250.
UPDATE "Player" p
SET "confirmedAt" = p."createdAt"
WHERE p."userId" IS NULL
   OR EXISTS (SELECT 1 FROM "Registration" r WHERE r."playerId" = p."id")
   OR EXISTS (SELECT 1 FROM "RatingEvent" e WHERE e."playerId" = p."id");
