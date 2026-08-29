/** Тот же объект, но без `undefined` среди возможных значений. */
export type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/**
 * Убирает ключи со значением `undefined`.
 *
 * Нужно на стыке Zod и Prisma. Zod для необязательного поля выдаёт
 * `field?: T | undefined`, а Prisma при `exactOptionalPropertyTypes` ожидает
 * либо отсутствие ключа, либо значение — `undefined` для неё не то же самое,
 * что «не трогать». Разница видна на PATCH: присвоение `undefined` там, где
 * поле не передавали, затирает колонку вместо того, чтобы оставить её как есть.
 */
export function defined<T extends object>(value: T): Defined<T> {
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }

  return result as Defined<T>;
}
