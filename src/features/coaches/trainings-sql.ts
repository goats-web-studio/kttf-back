import { CHILD_AUDIENCES, TIME_OF_DAY_BOUNDS, type ListTrainingsQuery } from '@kttf/shared/types';

import { skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Страница блоков раздела «Тренировки» считается в базе: какие блоки
 * попали на страницу, в каком порядке и сколько их всего. Сами тренировки
 * страницы потом читает обычная выборка Prisma (`TrainingsService.list`).
 *
 * `trainingsFilterSql` повторяет `trainingsWhere` условие в условие. Оба
 * нужны: Prisma не группирует по выражению (зал — без регистра и пробелов
 * по краям) и не сортирует группы по полям клуба, а `trainingsWhere`
 * остаётся источником для выборки тренировок и других мест. Правится одно —
 * правится и другое; равенство ответов проверяет
 * `scripts/check-trainings-blocks.mjs` на живой базе.
 *
 * Псевдонимы: `t` — тренировка, `cl` — её клуб, `co` — её тренер.
 */

/** Страница опубликована — `PUBLIC_COACH`. Связь `is` — тренер есть и подходит. */
const PUBLIC_COACH_SQL = Prisma.sql`co."id" IS NOT NULL AND co."status" = 'APPROVED' AND co."hiddenAt" IS NULL`;

/** Клуб есть и не скрыт — `club: { is: { hiddenAt: null } }`. */
const OPEN_CLUB_SQL = Prisma.sql`cl."id" IS NOT NULL AND cl."hiddenAt" IS NULL`;

/** `PUBLIC_TRAINING`. */
const PUBLIC_TRAINING_SQL = Prisma.sql`(
  (t."author" = 'COACH' AND ${PUBLIC_COACH_SQL} AND t."clubId" IS NULL)
  OR (t."author" = 'COACH' AND ${PUBLIC_COACH_SQL} AND t."link" = 'CONFIRMED' AND ${OPEN_CLUB_SQL})
  OR (t."author" = 'CLUB' AND ${OPEN_CLUB_SQL})
)`;

/**
 * Пробельные символы `String.prototype.trim` — для `btrim`: ключ зала обязан
 * совпадать с `venueKey`, а голый `trim` в Postgres срезает только пробел.
 */
const JS_WHITESPACE = String.fromCodePoint(
  ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680],
  ...[0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a],
  ...[0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff],
);

/** Пустой `OR` у Prisma — ложь; здесь так же. */
function anyOf(conditions: readonly Prisma.Sql[]): Prisma.Sql {
  return conditions.length === 0
    ? Prisma.sql`FALSE`
    : Prisma.sql`(${Prisma.join(conditions, ' OR ')})`;
}

/** Условие `trainingsWhere(query)` для строк `"Training" t` с клубом `cl` и тренером `co`. */
export function trainingsFilterSql(query: ListTrainingsQuery): Prisma.Sql {
  const and: Prisma.Sql[] = [PUBLIC_TRAINING_SQL];

  if (query.kind !== undefined) {
    and.push(Prisma.sql`t."kind" = ANY(${query.kind}::text[]::"TrainingKind"[])`);
  }

  if (query.place !== undefined) {
    and.push(Prisma.sql`t."place" = ANY(${query.place}::text[]::"TrainingPlace"[])`);
  }

  if (query.clubId !== undefined) and.push(Prisma.sql`t."clubId" = ${query.clubId}`);

  if (query.priceTo !== undefined) {
    and.push(Prisma.sql`t."priceKzt" IS NOT NULL AND t."priceKzt" <= ${query.priceTo}`);
  }

  if (query.audience !== undefined) {
    and.push(Prisma.sql`t."audiences" && ${query.audience}::text[]::"TrainingAudience"[]`);
  }

  if (query.age !== undefined) {
    and.push(Prisma.sql`t."audiences" && ${[...CHILD_AUDIENCES]}::text[]::"TrainingAudience"[]
      AND (t."kidsFromAge" IS NULL OR t."kidsFromAge" <= ${query.age})`);
  }

  if (query.cityId !== undefined) {
    and.push(Prisma.sql`(
      (t."clubId" IS NOT NULL AND cl."id" IS NOT NULL AND cl."cityId" = ANY(${query.cityId}::text[]))
      OR (t."clubId" IS NULL AND co."id" IS NOT NULL AND co."cityId" = ANY(${query.cityId}::text[]))
    )`);
  }

  // День и время — у одного и того же занятия.
  const slot: Prisma.Sql[] = [];

  if (query.day !== undefined) slot.push(Prisma.sql`s."weekday" = ANY(${query.day}::int[])`);

  if (query.time !== undefined) {
    slot.push(
      anyOf(
        query.time.map((time) => {
          const [from, to] = TIME_OF_DAY_BOUNDS[time];

          return Prisma.sql`(s."startMin" >= ${from} AND s."startMin" < ${to})`;
        }),
      ),
    );
  }

  if (slot.length > 0) {
    and.push(Prisma.sql`EXISTS (SELECT 1 FROM "TrainingSlot" s
      WHERE s."trainingId" = t."id" AND ${Prisma.join(slot, ' AND ')})`);
  }

  if (query.open === true) and.push(Prisma.sql`t."enrollment" IN ('OPEN', 'FEW')`);

  if (query.language !== undefined) {
    const has = Prisma.sql`${query.language}::"CoachLanguage" = ANY(co."languages")`;

    and.push(Prisma.sql`(
      (t."author" = 'COACH' AND co."id" IS NOT NULL AND ${has})
      OR (t."author" = 'CLUB' AND t."link" = 'CONFIRMED' AND ${PUBLIC_COACH_SQL} AND ${has})
    )`);
  }

  return Prisma.join(and, ' AND ');
}

/** Строка страницы блоков: блок и его тренировки. Страница пуста — одна строка с `ids = null`. */
export interface TrainingBlockRow {
  readonly total: number;
  readonly ids: string[] | null;
}

/**
 * Страница блоков — правила `groupTrainings`:
 * - блок — клуб (`clubId`), зал вне KTTF (`venueKey`: без регистра и
 *   пробелов по краям) или один «выезд и онлайн»;
 * - клубы по свежести страницы клуба (без отметки — в конце), затем по
 *   названию; залы — по первому написанию названия, затем адреса; «выезд
 *   и онлайн» последним. Последний ключ — сам ключ блока: порядок не
 *   зависит от того, как база отдала строки;
 * - первое написание зала — у самой ранней тренировки (`createdAt`, `id`);
 * - `ids` — тренировки блока, `total` — блоков всего: он приходит и тогда,
 *   когда страница за последним блоком.
 */
export function trainingBlocksSql(query: ListTrainingsQuery): Prisma.Sql {
  const skip = skipOf(query);

  return Prisma.sql`WITH matched AS (
    SELECT t."id", t."createdAt", t."clubId", t."venueName", t."venueAddress",
      CASE
        WHEN t."clubId" IS NOT NULL THEN 0
        WHEN t."venueName" IS NOT NULL AND t."venueAddress" IS NOT NULL THEN 1
        ELSE 2
      END AS "rank",
      CASE
        WHEN t."clubId" IS NOT NULL THEN t."clubId"
        WHEN t."venueName" IS NOT NULL AND t."venueAddress" IS NOT NULL THEN
          lower(btrim(t."venueName", ${JS_WHITESPACE}) COLLATE "und-x-icu") || chr(10) ||
          lower(btrim(t."venueAddress", ${JS_WHITESPACE}) COLLATE "und-x-icu")
        ELSE ''
      END AS "key"
    FROM "Training" t
    LEFT JOIN "Club" cl ON cl."id" = t."clubId"
    LEFT JOIN "Coach" co ON co."id" = t."coachId"
    WHERE ${trainingsFilterSql(query)}
  ), blocks AS (
    SELECT m."rank", m."key", min(m."clubId") AS "clubId",
      array_agg(m."id" ORDER BY m."createdAt", m."id") AS "ids",
      (array_agg(m."venueName" ORDER BY m."createdAt", m."id"))[1] AS "venueName",
      (array_agg(m."venueAddress" ORDER BY m."createdAt", m."id"))[1] AS "venueAddress"
    FROM matched m
    GROUP BY m."rank", m."key"
  ), ordered AS (
    SELECT b."ids", row_number() OVER (ORDER BY
      b."rank",
      cl."profileReviewedAt" DESC NULLS LAST,
      coalesce(cl."name", b."venueName") COLLATE "ru-x-icu",
      b."venueAddress" COLLATE "ru-x-icu",
      b."key"
    ) AS "position"
    FROM blocks b
    LEFT JOIN "Club" cl ON cl."id" = b."clubId"
  )
  SELECT c."total", o."ids"
  FROM (SELECT count(*)::int AS "total" FROM blocks) c
  LEFT JOIN ordered o ON o."position" > ${skip} AND o."position" <= ${skip + query.limit}
  ORDER BY o."position"`;
}
