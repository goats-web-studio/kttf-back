import { z } from 'zod';

/**
 * Постраничность списков.
 *
 * Потолок обязателен: без него `?limit=100000` превращает публичный список в
 * способ положить базу одним запросом. ТС 8.1 требует p95 меньше 200 мс —
 * выборка без границы это требование не выполнит никогда.
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

/** Смещение для запроса к базе. */
export function skipOf({ page, limit }: PageQuery): number {
  return (page - 1) * limit;
}

export function pageOf<T>(items: readonly T[], total: number, query: PageQuery): Page<T> {
  return { items, total, page: query.page, limit: query.limit };
}
