import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CatalogService } from './catalog.service.js';

function row(id: string) {
  return {
    id,
    slug: id,
    category: 'BLADE' as const,
    name: id,
    status: 'PUBLISHED' as const,
    hiddenAt: null,
    brand: { id: 'brand-1', name: 'Tibhar', slug: 'tibhar' },
    images: [],
  };
}

function makePrisma() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    product: {
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(5),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: CatalogService;

beforeEach(() => {
  prisma = makePrisma();
  service = new CatalogService(
    prisma as unknown as PrismaService,
    { JWT_SECRET: 'secret'.repeat(8) } as Env,
  );
});

const base = { page: 1, limit: 20, sort: 'popular' as const };

describe('число игроков в списке', () => {
  it('считается одной группировкой на страницу, с планкой рейтинга', async () => {
    prisma.product.findMany.mockResolvedValue([row('a'), row('b')]);
    prisma.$queryRaw.mockResolvedValue([{ productId: 'a', players: 7 }]);

    const page = await service.listProducts({ ...base, playerRatingFrom: 400 }, {});

    expect(page.items.map((item) => [item.id, item.playerCount])).toEqual([
      ['a', 7],
      ['b', 0],
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect((prisma.$queryRaw.mock.calls[0]?.[0] as { values: unknown[] }).values).toEqual([
      399.5,
      ['a', 'b'],
    ]);
  });
});

describe('«Выбор игроков»', () => {
  it('сначала товары с игроками по их числу, затем остальные по популярности', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { productId: 'a', players: 2 },
      { productId: 'b', players: 9 },
      { productId: 'hidden', players: 50 },
    ]);
    prisma.product.findMany
      // Товары с игроками, прошедшие условие списка: скрытого среди них нет.
      .mockResolvedValueOnce([
        { id: 'a', popularity: 1, name: 'A' },
        { id: 'b', popularity: 0, name: 'B' },
      ])
      // Остальные — обычной выборкой.
      .mockResolvedValueOnce([{ id: 'c' }])
      .mockResolvedValueOnce([row('c'), row('a'), row('b')]);

    const page = await service.listProducts({ ...base, sort: 'players', limit: 3 }, {});

    expect(page.items.map((item) => [item.id, item.playerCount])).toEqual([
      ['b', 9],
      ['a', 2],
      ['c', 0],
    ]);
    expect(page.total).toBe(5);
    expect(prisma.product.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { AND: [expect.anything(), { id: { notIn: ['a', 'b', 'hidden'] } }] },
      skip: 0,
      take: 1,
    });
  });

  it('страница за товарами с игроками — смещение среди остальных', async () => {
    prisma.$queryRaw.mockResolvedValue([{ productId: 'a', players: 2 }]);
    prisma.product.findMany
      .mockResolvedValueOnce([{ id: 'a', popularity: 1, name: 'A' }])
      .mockResolvedValueOnce([{ id: 'd' }, { id: 'e' }])
      .mockResolvedValueOnce([row('d'), row('e')]);

    await service.listProducts({ ...base, sort: 'players', page: 2, limit: 2 }, {});

    // Вторая страница по два: первый из «остальных» ушёл на первую страницу.
    expect(prisma.product.findMany.mock.calls[1]?.[0]).toMatchObject({ skip: 1, take: 2 });
  });
});
