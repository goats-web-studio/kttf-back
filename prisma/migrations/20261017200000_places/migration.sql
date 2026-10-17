-- Справочник стран и городов, администратор платформы: ADR-046.
--
-- Город у клуба и игрока был свободной строкой. Здесь строки переезжают
-- в справочник: заводится Казахстан с городами республиканского значения
-- и областными центрами, всё, что уже вписано в данных и не совпало
-- с ними, добавляется отдельными городами, и колонки заменяются ссылками.

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKk" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKk" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Country_code_key" ON "Country"("code");

-- CreateIndex
CREATE UNIQUE INDEX "City_countryId_name_key" ON "City"("countryId", "name");

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Заполнение. Идентификаторы — gen_random_uuid(), встроенная в Postgres 13+:
-- в колонке тот же UUID v4, что выдаёт Prisma.
INSERT INTO "Country" ("id", "code", "name", "nameKk", "sortOrder")
VALUES (gen_random_uuid()::text, 'KZ', 'Казахстан', 'Қазақстан', 10);

-- Столицы и города республиканского значения впереди, областные центры
-- и крупные города следом — по алфавиту, порядок у них общий.
INSERT INTO "City" ("id", "countryId", "name", "nameKk", "sortOrder")
SELECT gen_random_uuid()::text, country."id", city."name", city."nameKk", city."sortOrder"
FROM "Country" country,
  (VALUES
    ('Астана', 'Астана', 10),
    ('Алматы', 'Алматы', 20),
    ('Шымкент', 'Шымкент', 30),
    ('Актау', 'Ақтау', 100),
    ('Актобе', 'Ақтөбе', 100),
    ('Атырау', 'Атырау', 100),
    ('Жезказган', 'Жезқазған', 100),
    ('Караганда', 'Қарағанды', 100),
    ('Кокшетау', 'Көкшетау', 100),
    ('Конаев', 'Қонаев', 100),
    ('Костанай', 'Қостанай', 100),
    ('Кызылорда', 'Қызылорда', 100),
    ('Павлодар', 'Павлодар', 100),
    ('Петропавловск', 'Петропавл', 100),
    ('Семей', 'Семей', 100),
    ('Талдыкорган', 'Талдықорған', 100),
    ('Тараз', 'Тараз', 100),
    ('Туркестан', 'Түркістан', 100),
    ('Уральск', 'Орал', 100),
    ('Усть-Каменогорск', 'Өскемен', 100)
  ) AS city("name", "nameKk", "sortOrder")
WHERE country."code" = 'KZ';

-- Всё, что уже вписано и не совпало со справочником без учёта регистра
-- и пробелов по краям. Из нескольких написаний одного города берётся
-- первое по алфавиту: какое из них правильное, решит администратор,
-- переименовав запись, — ссылки при этом не пострадают.
INSERT INTO "City" ("id", "countryId", "name")
SELECT gen_random_uuid()::text, country."id", written."name"
FROM "Country" country,
  (
    SELECT DISTINCT ON (lower(btrim(source."city"))) btrim(source."city") AS "name"
    FROM (
      SELECT "city" FROM "Club"
      UNION ALL
      SELECT "city" FROM "Player"
    ) source
    WHERE btrim(source."city") <> ''
    ORDER BY lower(btrim(source."city")), btrim(source."city")
  ) written
WHERE country."code" = 'KZ'
  AND NOT EXISTS (
    SELECT 1 FROM "City" known WHERE lower(known."name") = lower(written."name")
  );

ALTER TABLE "Club" ADD COLUMN "cityId" TEXT;
ALTER TABLE "Player" ADD COLUMN "cityId" TEXT;

-- На случай пустой строки в данных: схема её не пропускала, но колонка
-- позволяла. Такой записи нужен хоть какой-то город — берётся столица,
-- администратор поправит.
UPDATE "Club" club
SET "cityId" = COALESCE(
  (SELECT city."id" FROM "City" city WHERE lower(city."name") = lower(btrim(club."city"))),
  (SELECT city."id" FROM "City" city WHERE city."name" = 'Астана')
);

UPDATE "Player" player
SET "cityId" = COALESCE(
  (SELECT city."id" FROM "City" city WHERE lower(city."name") = lower(btrim(player."city"))),
  (SELECT city."id" FROM "City" city WHERE city."name" = 'Астана')
);

-- DropIndex
DROP INDEX "Club_city_idx";

-- DropIndex
DROP INDEX "Player_city_rating_idx";

-- AlterTable
ALTER TABLE "Club" DROP COLUMN "city",
ALTER COLUMN "cityId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Player" DROP COLUMN "city",
ALTER COLUMN "cityId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Club_cityId_idx" ON "Club"("cityId");

-- CreateIndex
CREATE INDEX "Player_cityId_rating_idx" ON "Player"("cityId", "rating" DESC);

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
