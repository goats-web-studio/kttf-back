-- «Новости клубов и тренеров» — ADR-067. Раздел, где тема — сама новость
-- или акция клуба и тренера; руками тему не завести. Уже опубликованные
-- записи становятся темами: первое сообщение — текст записи, автор — тот,
-- кто её публиковал. Скрытые администратором, записи скрытых клубов и
-- неопубликованных страниц тренера темами не становятся.

INSERT INTO "ForumSection" ("id", "slug", "title", "description", "position", "subjectTypes", "manualTopics")
VALUES (gen_random_uuid(), 'news', 'Новости клубов и тренеров',
        'Новости и акции клубов и тренеров KTTF — обсуждайте под каждой', 25,
        ARRAY['CLUB_POST', 'COACH_POST']::"ForumSubjectType"[], false);

WITH section AS (SELECT "id" FROM "ForumSection" WHERE "slug" = 'news'),
source AS (
    SELECT p."id", p."title", p."body", p."authorId", p."publishedAt", 'CLUB_POST'::"ForumSubjectType" AS "type"
    FROM "ClubPost" p JOIN "Club" c ON c."id" = p."clubId"
    WHERE p."hiddenAt" IS NULL AND c."hiddenAt" IS NULL
    UNION ALL
    SELECT p."id", p."title", p."body", p."authorId", p."publishedAt", 'COACH_POST'::"ForumSubjectType"
    FROM "CoachPost" p JOIN "Coach" c ON c."id" = p."coachId"
    WHERE p."hiddenAt" IS NULL AND c."hiddenAt" IS NULL AND c."status" = 'APPROVED'
),
topics AS (
    INSERT INTO "ForumTopic" ("id", "sectionId", "authorId", "title", "subjectType", "subjectId",
                              "postsCount", "lastPostAt", "lastPostAuthorId", "createdAt")
    SELECT gen_random_uuid(), section."id", source."authorId", left(source."title", 150), source."type",
           source."id", 1, source."publishedAt", source."authorId", source."publishedAt"
    FROM source, section
    RETURNING "id", "subjectId", "authorId", "createdAt"
)
INSERT INTO "ForumPost" ("id", "topicId", "authorId", "number", "body", "images", "createdAt")
SELECT gen_random_uuid(), topics."id", topics."authorId", 1, source."body", '[]', topics."createdAt"
FROM topics JOIN source ON source."id" = topics."subjectId";
