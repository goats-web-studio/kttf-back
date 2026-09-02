import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';

import { ScreenService } from './screen.service.js';

/**
 * Состояние второго экрана — ТЗ 6.5.
 *
 * Проверяется, что уходит на стену: экран открывается по ссылке без всякого
 * входа, и состав ответа здесь — вопрос не удобства, а того, кто это увидит.
 */

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000000';
const STAGE_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'FDgV6mQ1xKq8yZ2pW7nR4tL0sB3cH5jE';

function tournament(overrides = {}) {
  return {
    id: TOURNAMENT_ID,
    clubId: '44444444-4444-4444-8444-444444444444',
    name: 'Кубок клуба',
    startsAt: new Date('2026-09-02T10:00:00.000Z'),
    registrationEndsAt: null,
    status: 'RUNNING',
    entryFee: 0,
    maxParticipants: null,
    ratingCapMax: null,
    ratingCapMin: null,
    birthYearFrom: null,
    birthYearTo: null,
    genderLimit: null,
    level: 'CLUB',
    tableCount: 4,
    formatConfig: { type: 'ROUND_ROBIN', rounds: 1, setsToWin: 2 },
    seedingConfig: null,
    description: null,
    prizeInfo: null,
    publicToken: TOKEN,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    startedAt: new Date('2026-09-02T10:00:00.000Z'),
    finishedAt: null,
    ratedAt: null,
    _count: { registrations: 2 },
    ...overrides,
  };
}

function registration(playerId: string, lastName: string, status = 'PLAYING') {
  return {
    id: `reg-${playerId}`,
    tournamentId: TOURNAMENT_ID,
    status,
    isRated: true,
    seed: null,
    ratingAtStart: new Prisma.Decimal('250.00'),
    matchesAtStart: 0,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    player: {
      id: playerId,
      userId: null,
      lastName,
      firstName: 'Имя',
      middleName: null,
      birthYear: 1995,
      gender: 'MALE',
      city: 'Алматы',
      photoUrl: null,
      clubId: null,
      rating: new Prisma.Decimal('294.80'),
      ratedMatches: 3,
      isProvisional: true,
      createdAt: new Date('2026-09-01T08:00:00.000Z'),
    },
  };
}

const stage = {
  id: STAGE_ID,
  order: 0,
  type: 'ROUND_ROBIN',
  name: 'Круговая',
  config: { setsToWin: 2 },
  groups: [{ id: GROUP_ID, label: 'Круговая', order: 0, tieDecisions: [] }],
  matches: [
    {
      id: 'match-1',
      stageId: STAGE_ID,
      groupId: GROUP_ID,
      playerAId: 'player-a',
      playerBId: 'player-b',
      sourceA: null,
      sourceB: null,
      status: 'FINISHED',
      tableNumber: 2,
      setsA: 2,
      setsB: 0,
      setScores: null,
      resultType: 'NORMAL',
      bracketRound: 1,
      bracketSlot: 1,
      startedAt: new Date('2026-09-02T10:05:00.000Z'),
      finishedAt: new Date('2026-09-02T10:25:00.000Z'),
    },
  ],
};

function makePrisma(overrides: { tournament?: unknown } = {}) {
  return {
    tournament: {
      findUnique: vi
        .fn()
        .mockResolvedValue('tournament' in overrides ? overrides.tournament : tournament()),
    },
    stage: { findMany: vi.fn().mockResolvedValue([stage]) },
    registration: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          registration('player-a', 'Ахметов'),
          registration('player-b', 'Сериков'),
        ]),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: ScreenService;

beforeEach(() => {
  prisma = makePrisma();
  service = new ScreenService(prisma as unknown as PrismaService);
});

describe('состояние по публичному токену', () => {
  it('турнир ищется по токену, а не по идентификатору', async () => {
    await service.byToken(TOKEN);

    expect(prisma.tournament.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicToken: TOKEN } }),
    );
  });

  it('отдаёт состав, таблицы и этапы', async () => {
    const view = await service.byToken(TOKEN);

    expect(view.players.map((player) => player.lastName)).toEqual(['Ахметов', 'Сериков']);
    expect(view.standings.groups).toHaveLength(1);
    expect(view.standings.groups[0]?.rows.map((row) => row.participant)).toEqual([
      'player-a',
      'player-b',
    ]);
    expect(view.stages[0]?.matches[0]?.tableNumber).toBe(2);
  });

  it('журнала рейтинга в ответе нет', async () => {
    // Ссылка на экран висит на стене: кто сколько очков потерял — не то,
    // что зритель в зале обязан видеть.
    expect(await service.byToken(TOKEN)).not.toHaveProperty('ratings');
  });

  it('рейтинг игрока уходит строкой, а не числом', async () => {
    // Decimal(8,2) через число с плавающей точкой теряет сотые — ADR-014.
    expect((await service.byToken(TOKEN)).players[0]?.rating).toBe('294.8');
  });

  it('неизвестный токен — отказ NOT_FOUND', async () => {
    prisma.tournament.findUnique.mockResolvedValue(null);

    await expect(service.byToken(TOKEN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('черновик по токену не отдаётся', async () => {
    // Токен существует с создания турнира, но до жеребьёвки показывать нечего.
    prisma.tournament.findUnique.mockResolvedValue(tournament({ status: 'DRAFT' }));

    await expect(service.byToken(TOKEN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('идентификатор турнира для потока', () => {
  it('возвращается по токену', async () => {
    prisma.tournament.findUnique.mockResolvedValue({ id: TOURNAMENT_ID, status: 'RUNNING' });

    expect(await service.tournamentIdOf(TOKEN)).toBe(TOURNAMENT_ID);
  });

  it('на черновик поток не открывается', async () => {
    prisma.tournament.findUnique.mockResolvedValue({ id: TOURNAMENT_ID, status: 'DRAFT' });

    await expect(service.tournamentIdOf(TOKEN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
