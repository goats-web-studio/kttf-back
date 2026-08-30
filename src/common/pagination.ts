import type { Page, PageQuery } from '@kttf/shared/types';

/**
 * Серверные помощники постраничности.
 *
 * Сам контракт — `pageQuerySchema`, `PageQuery` и конверт `Page` — живёт в
 * общем коде: его обязаны одинаково понимать обе стороны. Здесь остаётся то,
 * что нужно только серверу: арифметика смещения для запроса к базе.
 */

/** Смещение для запроса к базе. */
export function skipOf({ page, limit }: PageQuery): number {
  return (page - 1) * limit;
}

export function pageOf<T>(items: readonly T[], total: number, query: PageQuery): Page<T> {
  return { items, total, page: query.page, limit: query.limit };
}
