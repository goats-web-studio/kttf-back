-- Встречи игрока ищутся по playerAId или playerBId: профиль, личные встречи,
-- соперники в подсказках подписок (DEV-127). Без индексов каждый такой запрос
-- читал всю таблицу встреч.

-- CreateIndex
CREATE INDEX "Match_playerAId_idx" ON "Match"("playerAId");

-- CreateIndex
CREATE INDEX "Match_playerBId_idx" ON "Match"("playerBId");
