import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import { HomeStatsService, periodSince } from './home-stats.service.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');

const decimal = (value: string) => ({ toString: () => value });

function makeService(prisma: Record<string, unknown>) {
  const tournaments = { ensurePlaces: vi.fn().mockResolvedValue(undefined) };

  return {
    service: new HomeStatsService(
      prisma as unknown as PrismaService,
      tournaments as unknown as TournamentsService,
    ),
    tournaments,
  };
}

const players = [
  { id: 'p-weak', lastName: 'Ким', firstName: 'Артём', photoUrl: null, rating: decimal('300.00') },
  {
    id: 'p-strong',
    lastName: 'Беков',
    firstName: 'Нурсултан',
    photoUrl: null,
    rating: decimal('420.00'),
  },
];

describe('periodSince', () => {
  it('окно скользящее: неделя — ровно семь суток назад', () => {
    expect(periodSince('WEEK', NOW).toISOString()).toBe('2026-10-17T12:00:00.000Z');
    expect(periodSince('YEAR', NOW).toISOString()).toBe('2025-10-24T12:00:00.000Z');
  });
});

describe('HomeStatsService', () => {
  it('призёры: досчитывает места и отдаёт планку строкой, открытый — null', async () => {
    const row = {
      id: 't-1',
      name: 'Кубок',
      startsAt: NOW,
      level: 'CLUB',
      ratingCapMax: null,
      ratingCapMin: null,
      club: { id: 'c-1', name: 'Ракетка' },
      _count: { registrations: 12 },
      registrations: [
        { place: 1, placeTo: null, player: { id: 'p-1', lastName: 'Ким', firstName: 'Артём' } },
        { place: 3, placeTo: 4, player: { id: 'p-2', lastName: 'Беков', firstName: 'Нурсултан' } },
      ],
    };
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: 't-1' }])
      .mockResolvedValueOnce([row, { ...row, id: 't-2', ratingCapMax: decimal('250.00') }]);
    const { service, tournaments } = makeService({ tournament: { findMany } });

    const result = await service.podiums();

    expect(tournaments.ensurePlaces).toHaveBeenCalledWith(['t-1']);
    expect(result.items[0]).toMatchObject({
      tournamentId: 't-1',
      ratingCapMax: null,
      participants: 12,
      places: [
        { place: 1, placeTo: null, playerId: 'p-1', name: 'Ким Артём' },
        { place: 3, placeTo: 4, playerId: 'p-2', name: 'Беков Нурсултан' },
      ],
    });
    expect(result.items[1]?.ratingCapMax).toBe('250.00');
  });

  it('лидеры: игрок, которого нет в базе, выпадает из таблицы', async () => {
    const $queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        { playerId: 'p-strong', count: 4 },
        { playerId: 'p-gone', count: 3 },
      ])
      .mockResolvedValueOnce([{ playerId: 'p-weak', count: 9 }]);
    const { service } = makeService({
      $queryRaw,
      player: { findMany: vi.fn().mockResolvedValue(players) },
    });

    const result = await service.leaders('MONTH', NOW);

    expect(result.period).toBe('MONTH');
    expect(result.tournaments).toEqual([
      {
        player: { id: 'p-strong', name: 'Беков Нурсултан', photoUrl: null, rating: '420.00' },
        count: 4,
      },
    ]);
    expect(result.wins.map((row) => [row.player.id, row.count])).toEqual([['p-weak', 9]]);
  });

  it('лучшие победы: счёт со стороны победителя и дельта проигравшего из журнала', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([
      {
        matchId: 'm-1',
        winnerId: 'p-weak',
        winnerRating: '300.00',
        loserRating: '420.00',
        winnerDelta: '14.50',
      },
    ]);
    const match = {
      id: 'm-1',
      // Победитель — сторона B: счёт должен развернуться.
      playerAId: 'p-strong',
      playerBId: 'p-weak',
      setsA: 1,
      setsB: 3,
      finishedAt: NOW,
      tournament: { id: 't-1', name: 'Кубок', startsAt: NOW, club: { id: 'c-1', name: 'Ракетка' } },
      ratingEvents: [
        { playerId: 'p-weak', delta: decimal('14.50') },
        { playerId: 'p-strong', delta: decimal('-14.50') },
      ],
    };
    const { service } = makeService({
      $queryRaw,
      match: { findMany: vi.fn().mockResolvedValue([match]) },
      player: { findMany: vi.fn().mockResolvedValue(players) },
    });

    const result = await service.upsets('WEEK', NOW);

    expect(result.items).toEqual([
      {
        matchId: 'm-1',
        tournament: { id: 't-1', name: 'Кубок', startsAt: NOW.toISOString() },
        club: { id: 'c-1', name: 'Ракетка' },
        playedAt: NOW.toISOString(),
        winner: { id: 'p-weak', name: 'Ким Артём' },
        winnerRating: '300.00',
        winnerDelta: '14.50',
        loser: { id: 'p-strong', name: 'Беков Нурсултан' },
        loserRating: '420.00',
        loserDelta: '-14.50',
        setsWinner: 3,
        setsLoser: 1,
      },
    ]);
  });

  it('лучших побед нет — без лишних запросов', async () => {
    const match = { findMany: vi.fn() };
    const { service } = makeService({ $queryRaw: vi.fn().mockResolvedValue([]), match });

    expect(await service.upsets('YEAR', NOW)).toEqual({ period: 'YEAR', items: [] });
    expect(match.findMany).not.toHaveBeenCalled();
  });
});
