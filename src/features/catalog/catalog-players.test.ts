import { describe, expect, it, vi } from 'vitest';

import { countPlayers, playerCountsSql } from './catalog-players.js';

describe('игроки товара', () => {
  it('планка рейтинга — то же правило границ, что у списка игроков (ADR-054)', () => {
    // «400+» — от 399.50: на экране это уже 400.
    const sql = playerCountsSql(['product-1'], { playerRatingFrom: 400, playerRatingTo: 499 });

    expect(sql.values).toEqual([399.5, 499.5, ['product-1']]);
    expect(sql.sql).toContain('p."rating" >=');
    expect(sql.sql).toContain('p."rating" <');
  });

  it('игрок считается один раз — накладка с обеих сторон не удваивает счёт', () => {
    expect(playerCountsSql(null, {}).sql).toContain('count(DISTINCT p."id")');
  });

  it('без планки и без списка — по всем товарам с игроками', () => {
    const sql = playerCountsSql(null, {});

    expect(sql.values).toEqual([]);
    expect(sql.sql).not.toContain('ANY');
  });

  it('пустая страница — без запроса', async () => {
    const prisma = { $queryRaw: vi.fn() };

    expect(await countPlayers(prisma as never, [])).toEqual(new Map());
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
