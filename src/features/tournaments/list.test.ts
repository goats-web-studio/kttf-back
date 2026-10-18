import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { ScreenEventsService } from '../screen/screen-events.service.js';
import { TournamentsService } from './tournaments.service.js';

const UPCOMING = '00000000-0000-4000-8000-0000000000a1';
const PLAYED = '00000000-0000-4000-8000-0000000000a2';

/** Строка турнира, как её отдаёт выборка списка: всё, что нужно мапперу. */
function row(id: string, matches: number) {
  return {
    id,
    clubId: '00000000-0000-4000-8000-0000000000c1',
    name: `Турнир ${id.slice(-2)}`,
    startsAt: new Date('2026-10-19T14:20:00.000Z'),
    registrationEndsAt: null,
    status: 'REG_OPEN',
    entryFee: 0,
    maxParticipants: 32,
    ratingCapMax: null,
    ratingCapMin: null,
    reviewOutOfRating: false,
    birthYearFrom: null,
    birthYearTo: null,
    genderLimit: null,
    level: 'CLUB',
    tableCount: 8,
    formatConfig: { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 3 },
    seedingConfig: null,
    description: null,
    prizeInfo: null,
    publicToken: 'token',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    startedAt: null,
    finishedAt: null,
    ratedAt: null,
    _count: { registrations: 3, matches },
  };
}

const decimal = (value: string) => new Prisma.Decimal(value);

function makeService(rows: unknown[] = [], entries: unknown[] = []) {
  const tournament = {
    findMany:
      vi.fn<(args: { where: { AND: unknown[] }; orderBy: unknown }) => Promise<unknown[]>>(),
    count: vi.fn<(args: { where: unknown }) => Promise<number>>(),
  };
  const registration = { findMany: vi.fn<(args: unknown) => Promise<unknown[]>>() };
  tournament.findMany.mockResolvedValue(rows);
  tournament.count.mockResolvedValue(rows.length);
  registration.findMany.mockResolvedValue(entries);
  const service = new TournamentsService(
    { tournament, registration } as unknown as PrismaService,
    {} as unknown as ScreenEventsService,
  );

  return { service, tournament, registration };
}

/** Календарь — фильтр по статусу (ADR-051). */
describe('список турниров по статусу', () => {
  it('несколько статусов — любой из них: «Завершён» включает обсчитанные', async () => {
    const { service, tournament } = makeService();

    await service.list({ page: 1, limit: 20, order: 'asc', status: ['FINISHED', 'RATED'] });

    const where = tournament.findMany.mock.calls[0]?.[0].where;
    expect(where?.AND).toContainEqual({ status: { in: ['FINISHED', 'RATED'] } });
    // Счётчик считает по тому же условию — иначе «Найдено» разойдётся со страницей.
    expect(tournament.count.mock.calls[0]?.[0]).toEqual({ where });
  });

  it('без фильтра условия по статусу нет, кроме скрытия чужих черновиков', async () => {
    const { service, tournament } = makeService();

    await service.list({ page: 1, limit: 20, order: 'asc' });

    const where = tournament.findMany.mock.calls[0]?.[0].where;
    expect(where?.AND).toHaveLength(1);
  });
});

/** Календарь и список как у RTTF — ADR-052. */
describe('список турниров: порядок, средний рейтинг, игры', () => {
  it('прошедшие — от свежих: порядок задаёт запрос, при равной дате — по id', async () => {
    const { service, tournament } = makeService();

    await service.list({ page: 2, limit: 20, order: 'desc' });

    expect(tournament.findMany.mock.calls[0]?.[0].orderBy).toEqual([
      { startsAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('средний рейтинг: у начатого — на старте, у будущего — нынешний; до целого', async () => {
    const { service, registration } = makeService(
      [row(UPCOMING, 0), row(PLAYED, 12)],
      [
        // Будущий: снимка нет, берётся нынешний рейтинг.
        { tournamentId: UPCOMING, ratingAtStart: null, player: { rating: decimal('300.40') } },
        { tournamentId: UPCOMING, ratingAtStart: null, player: { rating: decimal('251.10') } },
        // Начатый: снимок важнее нынешнего рейтинга.
        {
          tournamentId: PLAYED,
          ratingAtStart: decimal('400.00'),
          player: { rating: decimal('1') },
        },
        {
          tournamentId: PLAYED,
          ratingAtStart: decimal('289.00'),
          player: { rating: decimal('1') },
        },
      ],
    );

    const page = await service.list({ page: 1, limit: 20, order: 'asc' });

    expect(page.items.map((item) => [item.averageRating, item.matchesPlayed])).toEqual([
      [276, 0],
      [345, 12],
    ]);
    // Одним запросом на страницу и только по занимающим место заявкам.
    expect(registration.findMany).toHaveBeenCalledTimes(1);
    expect(registration.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tournamentId: { in: [UPCOMING, PLAYED] } },
    });
  });

  it('без участников среднего нет — null, а не ноль', async () => {
    const { service } = makeService([row(UPCOMING, 0)], []);

    const [item] = (await service.list({ page: 1, limit: 20, order: 'asc' })).items;

    expect(item?.averageRating).toBeNull();
  });

  it('пустая страница не ходит за заявками', async () => {
    const { service, registration } = makeService();

    await service.list({ page: 1, limit: 20, order: 'asc' });

    expect(registration.findMany).not.toHaveBeenCalled();
  });
});
