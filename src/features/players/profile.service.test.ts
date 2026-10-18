import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import {
  durationMinutes,
  favoriteClub,
  periodStart,
  PlayerProfileService,
} from './profile.service.js';

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
    startedAt: new Date('2026-09-01T11:41:00.000Z'),
    finishedAt: new Date('2026-09-01T12:00:00.000Z'),
    tournament: at,
    ratingEvents:
      event === null
        ? []
        : [
            {
              delta: decimal(event.delta),
              ratingBefore: decimal('418.00'),
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
      findFirst: vi.fn().mockResolvedValue({
        ratingAfter: decimal('455.10'),
        createdAt: new Date('2026-09-02T08:00:00.000Z'),
        tournament: { startsAt: new Date('2026-09-01T10:00:00.000Z') },
      }),
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

  it('дата максимума — старт турнира, как у точки графика, и первое его достижение', async () => {
    const summary = await service.summary(ME, { period: 'ALL' });

    expect(summary.maxRatingAt).toBe('2026-09-01T10:00:00.000Z');
    expect(prisma.ratingEvent.findFirst.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ ratingAfter: 'desc' }, { createdAt: 'asc' }],
    });
  });

  it('у корректировки вне турнира дата максимума — момент записи', async () => {
    prisma.ratingEvent.findFirst.mockResolvedValue({
      ratingAfter: decimal('455.10'),
      createdAt: new Date('2026-09-02T08:00:00.000Z'),
      tournament: null,
    });

    expect((await service.summary(ME, { period: 'ALL' })).maxRatingAt).toBe(
      '2026-09-02T08:00:00.000Z',
    );
  });

  it('максимум не ниже нынешнего рейтинга, даже без журнала', async () => {
    prisma.ratingEvent.findFirst.mockResolvedValue(null);

    const summary = await service.summary(ME, { period: 'ALL' });

    expect(summary.maxRating).toBe('420.5');
    expect(summary.maxRatingAt).toBeNull();
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
        club: CLUB,
        place: 1,
      },
    ]);
  });
});

describe('лучшие победы', () => {
  it('по рейтингу соперника на момент встречи, вне зачёта и поражения не входят', async () => {
    prisma.match.findMany.mockResolvedValue([
      match('weak', WEAK, 3, 0, { delta: '2.00', opponentRating: '300' }),
      match('strong', STRONG, 3, 2, { delta: '9.50', opponentRating: '610' }),
      match('unrated', STRONG, 3, 0, null),
      match('lost', STRONG, 0, 3, { delta: '-1.00', opponentRating: '700' }),
    ]);

    const wins = await service.bestWins(ME, { period: 'ALL' });

    expect(wins.period).toBe('ALL');
    expect(wins.items.map((win) => win.matchId)).toEqual(['strong', 'weak']);
    expect(wins.items[0]).toMatchObject({
      opponentRating: '610',
      setsFor: 3,
      setsAgainst: 2,
      delta: '9.5',
    });
  });

  it('свой рейтинг — до встречи из журнала, время и длительность — из встречи', async () => {
    prisma.match.findMany.mockResolvedValue([
      match('strong', STRONG, 3, 2, { delta: '9.50', opponentRating: '610' }),
    ]);

    const [win] = (await service.bestWins(ME, { period: 'ALL' })).items;

    expect(win).toMatchObject({
      ratingBefore: '418',
      startedAt: '2026-09-01T11:41:00.000Z',
      playedAt: '2026-09-01T12:00:00.000Z',
      durationMinutes: 19,
    });
  });

  it('пять сильнейших, равные по силе — свежая выше', async () => {
    const at = (iso: string) => ({
      ...match(iso, STRONG, 3, 0, { delta: '1.00', opponentRating: '500' }),
      finishedAt: new Date(iso),
    });
    prisma.match.findMany.mockResolvedValue([
      at('2026-01-01T00:00:00.000Z'),
      at('2026-03-01T00:00:00.000Z'),
      at('2026-02-01T00:00:00.000Z'),
      at('2026-05-01T00:00:00.000Z'),
      at('2026-04-01T00:00:00.000Z'),
      at('2026-06-01T00:00:00.000Z'),
    ]);

    const { items } = await service.bestWins(ME, { period: 'ALL' });

    expect(items.map((win) => win.matchId.slice(5, 7))).toEqual(['06', '05', '04', '03', '02']);
  });

  it('период — свой, по дате турнира', async () => {
    await service.bestWins(ME, { period: 'QUARTER' });

    expect(prisma.match.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { tournament: { startsAt: { gte: expect.any(Date) as Date } } },
    });
  });
});

/** Журнал турнира T1: 400 → 405.25 → 403.25. */
const JOURNAL = [
  {
    tournamentId: T1,
    ratingBefore: decimal('400.00'),
    delta: decimal('5.25'),
    ratingAfter: decimal('405.25'),
  },
  {
    tournamentId: T1,
    ratingBefore: decimal('405.25'),
    delta: decimal('-2.00'),
    ratingAfter: decimal('403.25'),
  },
];

describe('результаты по турнирам', () => {
  beforeEach(() => {
    prisma.match.groupBy
      .mockResolvedValueOnce([{ tournamentId: T1 }])
      .mockResolvedValueOnce([{ stageId: 'ko', _max: { bracketRound: 3 } }]);
    prisma.tournament.findMany.mockResolvedValue([
      { ...tournament(T1, '2026-09-01T10:00:00.000Z'), status: 'RATED', level: 'REGIONAL' },
    ]);
    // Первый запрос — своя заявка, второй — рейтинги соперников на старте.
    prisma.registration.findMany
      .mockResolvedValueOnce([
        { tournamentId: T1, place: 5, placeTo: 8, ratingAtStart: decimal('400.00') },
      ])
      .mockResolvedValueOnce([
        { tournamentId: T1, playerId: STRONG, ratingAtStart: decimal('512.40') },
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
    startedAt: new Date('2026-09-01T11:35:30.000Z'),
    finishedAt: new Date('2026-09-01T12:00:00.000Z'),
    bracketRound: round,
    sourceA: source,
    sourceB: source,
    stage: { name: 'Плей-офф', type: 'KNOCKOUT' },
    group: null,
    ratingEvents: [
      {
        delta: decimal('5.25'),
        ratingBefore: decimal('400.00'),
        opponentRating: decimal('505.00'),
      },
    ],
  });

  it('место диапазоном, участники, рейтинг до и после, сумма изменений', async () => {
    prisma.ratingEvent.findMany.mockResolvedValue(JOURNAL);

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

  it('рейтинг после — конец цепочки, а не последняя запись по времени', async () => {
    // Журнал турнира пишется одной пачкой с одинаковым createdAt: база
    // вправе отдать записи в любом порядке.
    prisma.ratingEvent.findMany.mockResolvedValue([...JOURNAL].reverse());

    const page = await service.tournamentsOf(ME, { page: 1, limit: 10 });

    expect(page.items[0]).toMatchObject({ delta: '3.25', ratingAfter: '403.25' });
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

  it('уровень турнира, время, длительность и оба рейтинга на момент встречи', async () => {
    prisma.match.findMany.mockResolvedValue([bracketMatch('final', 3)]);

    const [item] = (await service.tournamentsOf(ME, { page: 1, limit: 10 })).items;

    expect(item?.tournament.level).toBe('REGIONAL');
    expect(item?.matches[0]).toMatchObject({
      startedAt: '2026-09-01T11:35:30.000Z',
      durationMinutes: 25,
      ratingBefore: '400',
      opponentRating: '505',
    });
  });

  it('пока турнир не обсчитан, рейтинг соперника — его рейтинг на старте', async () => {
    prisma.match.findMany.mockResolvedValue([{ ...bracketMatch('final', 3), ratingEvents: [] }]);

    const [item] = (await service.tournamentsOf(ME, { page: 1, limit: 10 })).items;

    expect(item?.matches[0]).toMatchObject({
      opponentRating: '512.4',
      ratingBefore: null,
      delta: null,
    });
    expect(prisma.registration.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { tournamentId: { in: [T1] }, playerId: { in: [STRONG] } },
    });
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

  it('длительность — минуты от вызова к столу до счёта', () => {
    const at = (time: string) => new Date(`2026-09-01T${time}.000Z`);

    expect(durationMinutes(at('10:00:00'), at('10:23:40'))).toBe(24);
    expect(durationMinutes(at('10:00:00'), at('10:00:00'))).toBe(0);
    // Без вызова к столу или без счёта — неизвестно, а не ноль.
    expect(durationMinutes(null, at('10:23:40'))).toBeNull();
    expect(durationMinutes(at('10:00:00'), null)).toBeNull();
    // Счёт, внесённый офлайн задним числом, лёг раньше вызова.
    expect(durationMinutes(at('10:30:00'), at('10:00:00'))).toBeNull();
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
