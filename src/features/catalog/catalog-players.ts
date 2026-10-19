import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ratingBounds } from '../players/rating-band.js';

/** Планка рейтинга «Выбора игроков» — те же поля, что у запроса списка товаров. */
export interface PlayerRatingBand {
  readonly playerRatingFrom?: number | undefined;
  readonly playerRatingTo?: number | undefined;
}

/**
 * Сколько игроков играет каждым товаром — ADR-058, `docs/10` 3.1 (M1.2).
 *
 * Игрок считается один раз, даже если накладка у него с обеих сторон.
 * Слоты разворачиваются в строки (`LATERAL VALUES`), и счёт идёт одним
 * сгруппированным запросом на страницу, а не запросом на товар. Планка
 * рейтинга — то же правило границ, что у списка игроков (`ratingBounds`).
 *
 * `ids = null` — по всем товарам, у которых есть игроки: так строится
 * порядок `players`. Таких товаров — сотни, а не весь каталог.
 */
export function playerCountsSql(ids: readonly string[] | null, band: PlayerRatingBand): Prisma.Sql {
  const bounds = ratingBounds(band.playerRatingFrom, band.playerRatingTo);
  const conditions = [Prisma.sql`slot.pid IS NOT NULL`];

  if (bounds.gte !== undefined) conditions.push(Prisma.sql`p."rating" >= ${bounds.gte}`);
  if (bounds.lt !== undefined) conditions.push(Prisma.sql`p."rating" < ${bounds.lt}`);
  if (ids !== null) conditions.push(Prisma.sql`slot.pid = ANY(${[...ids]}::text[])`);

  return Prisma.sql`SELECT slot.pid AS "productId", count(DISTINCT p."id")::int AS "players"
    FROM "Player" p
    CROSS JOIN LATERAL (VALUES (p."bladeProductId"), (p."rubberForehandProductId"), (p."rubberBackhandProductId")) AS slot(pid)
    WHERE ${Prisma.join(conditions, ' AND ')}
    GROUP BY slot.pid`;
}

export async function countPlayers(
  prisma: Pick<PrismaService, '$queryRaw'>,
  ids: readonly string[] | null,
  band: PlayerRatingBand = {},
): Promise<Map<string, number>> {
  if (ids !== null && ids.length === 0) return new Map();

  const rows = await prisma.$queryRaw<{ productId: string; players: number }[]>(
    playerCountsSql(ids, band),
  );

  return new Map(rows.map((row) => [row.productId, row.players]));
}
