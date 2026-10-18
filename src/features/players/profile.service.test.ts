import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import { favoriteClub, periodStart, PlayerProfileService } from './profile.service.js';

const ME = '00000000-0000-4000-8000-000000000001';
const STRONG = '00000000-0000-4000-8000-000000000002';
const WEAK = '00000000-0000-4000-8000-000000000003';
const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';
const CLUB = { id: '00000000-0000-4000-8000-0000000000c1', name: 'Спин' };

const decimal = (value: string) => new Prisma.Decimal(value);

function opponent(id: string, lastName: string) {
  return {
    id,
    userId: null,
    lastName,
    firstName: 'Тест',
    middleName: null,
    birthYear: 2000,
    gender: 'MALE',
    city: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Астана', nameKk: null },
    photoUrl: null,
    clubId: null,
    rating: decimal('500'),
    ratedMatches: 30,
    isProvisional: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

const tournament = (id: string, startsAt: string) => ({
  id,
  name: `Турнир ${id.slice(-2)}`,
  startsAt: new Date(startsAt),
  club: CLUB,
});

/** Встреча глазами игрока ME: он всегда сторона A. */
function match(
  id: string,
  opponentId: string,
  setsFor: number,
  setsAgainst: number,
  event: { delta: string; opponentRating: string | null } | null,
  at = tournament(T1, '2026-09-01T10:00:00.000Z'),
) {
  return {
    id,
    tournamentId: at.id,
    playerAId: ME,
    playerBId: opponentId,
    setsA: setsFor,
    setsB: setsAgainst,
    finishedAt: new Date('2026-09-01T12:00:00.000Z'),
    tournament: at,
    ratingEvents:
      event === null
        ? []
        : [
            {
              delta: decimal(event.delta),
              opponentRating: event.opponentRating === null ? null : decimal(event.opponentRating),
            },
          ],
  };
}

function makePrisma() {
  return {
    player: {
      findUnique: vi.fn().mockResolvedValue({ id: ME, rating: decimal('420.50') }),
      count: vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(120),
      findMany: vi.fn().mockResolvedValue([opponent(STRONG, 'Сильный'), opponent(WEAK, 'Слабый')]),
    },
    ratingEvent: {
      aggregate: vi.fn().mockResolvedValue({ _max: { ratingAfter: decimal('455.10') } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    match: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    tournament: {
      findFirst: vi.fn().mockResolvedValue(tournament(T2, '2025-03-01T10:00:00.000Z')),
      findMany: vi.fn().mockResolvedValue([]),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let tournaments: { ensurePlaces: ReturnType<typeof vi.fn> };
let service: PlayerProfileService;

beforeEach(() => {
  prisma = makePrisma();
  tournaments = { ensurePlaces: vi.fn().mockResolvedValue(undefined) };
  service = new PlayerProfileService(
    prisma as unknown as PrismaService,
    tournaments as unknown as TournamentsService,
  );
});

describe('общая статистика', () => {
  it('место — как в списке рейтинга, максимум — из журнала', async () => {
    const summary = await service.summary(ME, { period: 'ALL' });

    expect(summary.rank).toBe(8);
    expect(summary.rankedPlayers).toBe(120);
    expect(summary.maxRating).toBe('455.1');
    expect(summary.firstTournament?.id).toBe(T2);
  });

  it('максимум не ниже нынешнего рейтинга, даже без журнала', async () => {
    prisma.ratingEvent.aggregate.mockResolvedValue({ _max: { ratingAfter: null } });

    expect((await service.summary(ME, { period: 'ALL' })).maxRating).toBe('420.5');
  });

  it('игры, победы и поражения, турниры — по сыгранным встречам', async () => {
    prisma.match.findMany.mockResolvedValue([
      match('m1', STRONG, 3, 1, { delta: '8.00', opponentRating: '610' }),
      match('m2', WEAK, 1, 3, { delta: '-4.00', opponentRating: '300' }),
      match('m3', WEAK, 3, 0, null, tournament(T2, '2026-10-01T10:00:00.000Z')),
    ]);

    const summary = await service.summary(ME, { period: 'ALL' });

    expect(summary).toMatchObject({ wins: 2, losses: 1, tournaments: 2 });
    expect(summary.favoriteClub).toEqual({ ...CLUB, tournaments: 2 });
  });

  it('лучшие победы — по рейтингу соперника на момент встречи, вне зачёта не входят', async () => {
    prisma.match.findMany.mockResolvedValue([
      match('weak', WEAK, 3, 0, { delta: '2.00', opponentRating: '300' }),
      match('strong', STRONG, 3, 2, { delta: '9.50', opponentRating: '610' }),
      match('unrated', STRONG, 3, 0, null),
      match('lost', STRONG, 0, 3, { delta: '-1.00', opponentRating: '700' }),
    ]);

    const { bestWins } = await service.summary(ME, { period: 'ALL' });

    expect(bestWins.map((win) => win.matchId)).toEqual(['strong', 'weak']);
    expect(bestWins[0]).toMatchObject({
      opponentRating: '610',
      setsFor: 3,
      setsAgainst: 2,
      delta: '9.5',
    });
  });

  it('период ограничивает встречи по дате турнира', async () => {
    await service.summary(ME, { period: 'YEAR' });

    expect(prisma.match.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tournament: { startsAt: { gte: expect.any(Date) as Date } } },
    });
  });

  it('награды — места 1–3, места старых турниров досчитываются', async () => {
    prisma.registration.findMany
      .mockResolvedValueOnce([{ tournamentId: T1 }, { tournamentId: T2 }])
      .mockResolvedValueOnce([
        { place: 1, tournament: tournament(T1, '2026-09-01T10:00:00.000Z') },
      ]);

    const { awards } = await service.summary(ME, { period: 'ALL' });

    expect(tournaments.ensurePlaces).toHaveBeenCalledWith([T1, T2]);
    expect(awards).toEqual([
      {
        tournament: { id: T1, name: 'Турнир a1', startsAt: '2026-09-01T10:00:00.000Z' },
        place: 1,
      },
    ]);
  });
});

describe('результаты по турнирам', () => {
  beforeEach(() => {
    prisma.match.groupBy
      .mockResolvedValueOnce([{ tournamentId: T1 }])
      .mockResolvedValueOnce([{ stageId: 'ko', _max: { bracketRound: 3 } }]);
    prisma.tournament.findMany.mockResolvedValue([
      { ...tournament(T1, '2026-09-01T10:00:00.000Z'), status: 'RATED' },
    ]);
    prisma.registration.findMany.mockResolvedValue([
      { tournamentId: T1, place: 5, placeTo: 8, ratingAtStart: decimal('400.00') },
    ]);
    prisma.registration.groupBy.mockResolvedValue([{ tournamentId: T1, _count: { _all: 16 } }]);
  });

  const bracketMatch = (
    id: string,
    round: number,
    source: unknown = { kind: 'WINNER', matchId: 'x' },
  ) => ({
    id,
    tournamentId: T1,
    stageId: 'ko',
    playerAId: ME,
    playerBId: STRONG,
    setsA: 3,
    setsB: 1,
    resultType: 'NORMAL',
    finishedAt: new Date('2026-09-01T12:00:00.000Z'),
    bracketRound: round,
    sourceA: source,
    sourceB: source,
    stage: { name: 'Плей-офф', type: 'KNOCKOUT' },
    group: null,
    ratingEvents: [{ delta: decimal('5.25') }],
  });

  it('место диапазоном, участники, рейтинг до и после, сумма изменений', async () => {
    prisma.ratingEvent.findMany.mockResolvedValue([
      {
        tournamentId: T1,
        delta: decimal('5.25'),
        ratingAfter: decimal('405.25'),
        createdAt: new Date(1),
      },
      {
        tournamentId: T1,
        delta: decimal('-2.00'),
        ratingAfter: decimal('403.25'),
        createdAt: new Date(2),
      },
    ]);

    const page = await service.tournamentsOf(ME, { page: 1, limit: 10 });

    expect(tournaments.ensurePlaces).toHaveBeenCalledWith([T1]);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      place: 5,
      placeTo: 8,
      participants: 16,
      ratingBefore: '400',
      delta: '3.25',
      ratingAfter: '403.25',
    });
  });

  it('без журнала изменение пустое, а не ноль', async () => {
    const page = await service.tournamentsOf(ME, { page: 1, limit: 10 });

    expect(page.items[0]).toMatchObject({ delta: null, ratingAfter: null });
  });

  it('круг сетки — от финала, встреча за места — отдельно', async () => {
    prisma.match.findMany.mockResolvedValue([
      bracketMatch('quarter', 1),
      bracketMatch('final', 3),
      bracketMatch('third', 3, { kind: 'LOSER', matchId: 'semi' }),
    ]);

    const [item] = (await service.tournamentsOf(ME, { page: 1, limit: 10 })).items;

    expect(item?.matches.map((row) => [row.matchId, row.roundFromFinal, row.placement])).toEqual([
      ['quarter', 2, false],
      ['final', 0, false],
      ['third', null, true],
    ]);
    expect(item?.matches[0]?.opponent?.lastName).toBe('Сильный');
  });

  it('у групповой встречи круга нет: её bracketRound — номер тура', async () => {
    prisma.match.findMany.mockResolvedValue([
      { ...bracketMatch('group', 2), stage: { name: 'Групповой этап', type: 'GROUPS' } },
    ]);

    const [item] = (await service.tournamentsOf(ME, { page: 1, limit: 10 })).items;

    expect(item?.matches[0]).toMatchObject({ roundFromFinal: null, placement: false });
  });
});

describe('вспомогательное', () => {
  it('начало периода', () => {
    const now = new Date('2026-10-18T00:00:00.000Z');

    expect(periodStart('ALL', now)).toBeNull();
    expect(periodStart('QUARTER', now)?.toISOString()).toBe('2026-07-18T00:00:00.000Z');
    expect(periodStart('YEAR', now)?.toISOString()).toBe('2025-10-18T00:00:00.000Z');
  });

  it('частый клуб при равенстве — по названию, без прыжков', () => {
    const a = { id: 'a', name: 'Альфа' };
    const b = { id: 'b', name: 'Бета' };

    expect(
      favoriteClub([
        { id: '1', club: b },
        { id: '2', club: a },
      ]),
    ).toEqual({ ...a, tournaments: 1 });
    expect(favoriteClub([])).toBeNull();
  });
});
