-- Раздел форума «Дуэли и спарринги» — ADR-068: сюда попадают темы с
-- предметом DUEL, обсуждения со страницы дуэли. После турниров, перед
-- новостями клубов и тренеров. Повторный запуск раздел не задвоит.
INSERT INTO "ForumSection" ("id", "slug", "title", "description", "position", "subjectTypes", "manualTopics")
VALUES (gen_random_uuid(), 'duels', 'Дуэли и спарринги',
        'Обсуждения дуэлей и спаррингов: договориться, разобрать игру', 22,
        ARRAY['DUEL']::"ForumSubjectType"[], true)
ON CONFLICT ("slug") DO UPDATE
SET "subjectTypes" = EXCLUDED."subjectTypes", "position" = EXCLUDED."position";
