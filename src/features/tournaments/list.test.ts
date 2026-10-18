import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { ScreenEventsService } from '../screen/screen-events.service.js';
import { TournamentsService } from './tournaments.service.js';

function makeService() {
  const tournament = {
    findMany: vi.fn<(args: { where: { AND: unknown[] } }) => Promise<unknown[]>>(),
    count: vi.fn<(args: { where: unknown }) => Promise<number>>(),
  };
  tournament.findMany.mockResolvedValue([]);
  tournament.count.mockResolvedValue(0);
  const service = new TournamentsService(
    { tournament } as unknown as PrismaService,
    {} as unknown as ScreenEventsService,
  );

  return { service, tournament };
}

/** Календарь — фильтр по статусу (ADR-051). */
describe('список турниров по статусу', () => {
  it('несколько статусов — любой из них: «Завершён» включает обсчитанные', async () => {
    const { service, tournament } = makeService();

    await service.list({ page: 1, limit: 20, status: ['FINISHED', 'RATED'] });

    const where = tournament.findMany.mock.calls[0]?.[0].where;
    expect(where?.AND).toContainEqual({ status: { in: ['FINISHED', 'RATED'] } });
    // Счётчик считает по тому же условию — иначе «Найдено» разойдётся со страницей.
    expect(tournament.count.mock.calls[0]?.[0]).toEqual({ where });
  });

  it('без фильтра условия по статусу нет, кроме скрытия чужих черновиков', async () => {
    const { service, tournament } = makeService();

    await service.list({ page: 1, limit: 20 });

    const where = tournament.findMany.mock.calls[0]?.[0].where;
    expect(where?.AND).toHaveLength(1);
  });
});
