import {
  PRODUCT_ATTRIBUTES,
  type AttributeFilter,
  type ListProductsQuery,
  type ProductCategory,
  type ProductFilters,
  type ProductSort,
} from '@kttf/shared/types';

import { Prisma } from '../../generated/prisma/client.js';
import { VISIBLE } from './catalog-views.js';

/**
 * Сколько найденных поиском товаров список берёт в работу. Каталог — тысячи
 * позиций, и запрос из двух букв не должен превращаться в выборку всей
 * таблицы ради одной страницы. Потолок — страховка, а не план.
 */
export const SEARCH_SCAN_MAX = 1000;

/** Сколько слов запроса учитывается: больше в названии товара не бывает. */
const SEARCH_TOKENS_MAX = 5;

/**
 * Порог похожести подсказок: ниже — уже не опечатка, а другой товар. Сравнение
 * `word_similarity`: запрос сверяется с куском названия, а не со всем
 * названием, иначе «тенерджи» не похоже на «Butterfly Tenergy 05».
 */
export const SUGGEST_MIN_SIMILARITY = 0.3;

/**
 * Условие выборки списка товаров.
 *
 * Фильтры по характеристикам — пути в `Json`: перечисление — «любое из»,
 * число — границы, да/нет — равенство. Варианты — «есть любой из». Всё
 * складывается в одно условие Prisma, и список остаётся двумя запросами:
 * число и страница.
 */
export function productWhere(
  query: Pick<ListProductsQuery, 'category' | 'brandId'>,
  filters: ProductFilters | null,
  options: { readonly withHidden: boolean; readonly ids?: readonly string[] },
): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];

  if (query.category !== undefined && filters !== null) {
    for (const filter of filters.attrs) {
      const condition = attributeCondition(query.category, filter);
      if (condition !== null) and.push(condition);
    }

    for (const option of filters.options) {
      and.push({
        OR: option.values.map((value) => ({
          options: { path: [option.axis], array_contains: [value] },
        })),
      });
    }
  }

  return {
    ...(options.withHidden ? {} : VISIBLE),
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.brandId === undefined ? {} : { brandId: { in: query.brandId } }),
    ...(options.ids === undefined ? {} : { id: { in: [...options.ids] } }),
    ...(and.length === 0 ? {} : { AND: and }),
  };
}

function attributeCondition(
  category: ProductCategory,
  filter: AttributeFilter,
): Prisma.ProductWhereInput | null {
  const def = PRODUCT_ATTRIBUTES[category].find((item) => item.key === filter.key);
  const path = [filter.key];

  if (def === undefined) return null;

  switch (filter.kind) {
    case 'in':
      return {
        OR: filter.values.map((value) => ({
          // Несколько значений хранится списком — ищется вхождение, а не равенство.
          attrs: def.kind === 'enums' ? { path, array_contains: [value] } : { path, equals: value },
        })),
      };
    case 'range':
      // Границы сравнимы только с одним числом: список чисел («39 / 40 / 41»)
      // фильтра не имеет, и неверная ссылка отбрасывается молча, как и прочее.
      if (def.kind !== 'number') return null;

      return {
        attrs: {
          path,
          ...(filter.min === undefined ? {} : { gte: filter.min }),
          ...(filter.max === undefined ? {} : { lte: filter.max }),
        },
      };
    case 'bool':
      return { attrs: { path, equals: filter.value } };
  }
}

/** Порядок списка. Последним — идентификатор: без него страницы теряют и повторяют строки. */
export function productOrder(sort: ProductSort): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'popular':
      return [{ popularity: 'desc' }, { name: 'asc' }, { id: 'asc' }];
    case 'name':
      return [{ brand: { name: 'asc' } }, { name: 'asc' }, { id: 'asc' }];
    case 'new':
      return [{ createdAt: 'desc' }, { id: 'asc' }];
  }
}

/** Слова запроса строчными, без повторов. */
export function searchTokens(search: string): string[] {
  const words = search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  return [...new Set(words)].slice(0, SEARCH_TOKENS_MAX);
}

/** Шаблон LIKE «содержит»: знаки шаблона из запроса — буквально. */
export function containsPattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Товары, подходящие под поиск, — идентификаторами.
 *
 * Каждое слово запроса должно найтись в названии, производителе или русском
 * написании: «tibhar lebesson» находит «Tibhar E. Lebesson». Сравнение по
 * `lower(...) LIKE` — его обслуживают индексы pg_trgm из миграции. Prisma
 * не умеет «содержит без регистра» по элементам массива, поэтому это сырой
 * запрос; ввод пользователя в нём — только параметрами.
 */
export function searchIdsSql(tokens: readonly string[], withHidden: boolean): Prisma.Sql {
  const conditions = tokens.map((token) => {
    const pattern = containsPattern(token);

    return Prisma.sql`(lower(p."name") LIKE ${pattern}
      OR lower(b."name") LIKE ${pattern}
      OR EXISTS (SELECT 1 FROM unnest(p."aliases") AS alias WHERE lower(alias) LIKE ${pattern}))`;
  });

  return Prisma.sql`SELECT p."id" FROM "Product" p
    JOIN "Brand" b ON b."id" = p."brandId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ${withHidden ? Prisma.empty : Prisma.sql`AND p."status" = 'PUBLISHED' AND p."hiddenAt" IS NULL`}
    LIMIT ${SEARCH_SCAN_MAX}`;
}

/**
 * Подсказки при вводе: похожесть с опечатками по «производитель название» и
 * по русским написаниям, лучшая из них. Равные — по популярности.
 */
export function suggestSql(
  q: string,
  category: ProductCategory | undefined,
  limit: number,
): Prisma.Sql {
  const query = q.toLowerCase();

  return Prisma.sql`SELECT s."id" FROM (
      SELECT p."id", p."popularity", p."name",
        GREATEST(
          word_similarity(${query}, lower(b."name" || ' ' || p."name")),
          COALESCE((SELECT max(word_similarity(${query}, lower(alias))) FROM unnest(p."aliases") AS alias), 0)
        ) AS score
      FROM "Product" p
      JOIN "Brand" b ON b."id" = p."brandId"
      WHERE p."status" = 'PUBLISHED' AND p."hiddenAt" IS NULL
      ${category === undefined ? Prisma.empty : Prisma.sql`AND p."category" = CAST(${category} AS "ProductCategory")`}
    ) s
    WHERE s.score >= ${SUGGEST_MIN_SIMILARITY}
    ORDER BY s.score DESC, s."popularity" DESC, s."name" ASC
    LIMIT ${limit}`;
}

/**
 * Свободный адрес: основа, если не занята, иначе `основа-2`, `основа-3`…
 * `taken` — занятые адреса, начинающиеся с основы.
 */
export function pickSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
}
