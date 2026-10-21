import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import { StudentsService, bestGrowth, signedDelta } from './students.service.js';

const COACH_ID = '11111111-1111-4111-8111-111111111111';
const COACH_PLAYER = 'coach-player';
const NOW = new Date('2026-10-21T10:00:00.000Z');
const city = { id: 'city-1', name: 'Алматы', nameKk: null };

function student(id: string, birthYear: number, rating: string) {
  return {
    id,
    lastName: `Фамилия-${id}`,
    firstName: 'Имя',
    photoUrl: null,
    rating: new Prisma.Decimal(rating),
    birthYear,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    city,
  };
}

const adult = student('adult', 2000, '520.00');
const teen = student('teen', 2012, '610.50');
// В 2026 году ему 13: публично не называется.
const child = student('child', 2013, '700.00');

function makePrisma() {
  return {
    coach: {
      findUnique: vi.fn().mockResolvedValue({
        playerId: COACH_PLAYER,
        userId: 'user-coach',
        status: 'APPROVED',
        hiddenAt: null,
      }),
    },
    player: {
      findMany: vi.fn().mockResolvedValue([adult, teen, child]),
      findUnique: vi.fn().mockResolvedValue({ id: 'me', coachPlayerId: null }),
      count: vi.fn().mockResolvedValue(3),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    coachTenure: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    tournament: { findMany: vi.fn().mockResolvedValue([{ id: 't-1' }]) },
    registration: { findMany: vi.fn().mockResolvedValue([]) },
    ratingEvent: { groupBy: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) },
    $transaction: vi.fn(),
  };
}

let prisma: ReturnType<typeof makePrisma>;
let tournaments: { ensurePlaces: ReturnType<typeof vi.fn> };
let service: StudentsService;

beforeEach(() => {
  prisma = makePrisma();
  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));
  tournaments = { ensurePlaces: vi.fn().mockResolvedValue(undefined) };
  service = new StudentsService(
    prisma as unknown as PrismaService,
    tournaments as unknown as TournamentsService,
  );
});

describe('ученики на странице тренера', () => {
  it('младшие 14 — только числом, топ — с 14 лет по рейтингу', async () => {
    const view = await service.view(COACH_ID, undefined, NOW);

    expect(view).toMatchObject({ current: 3, younger: 1 });
    expect(view.top.map((ref) => ref.id)).toEqual(['teen', 'adult']);
    expect(view.top[0]?.rating).toBe('610.5');
    expect(JSON.stringify(view)).not.toContain('child');
  });

  it('бывшие — разные игроки с закрытым периодом, кто сейчас не ученик', async () => {
    prisma.coachTenure.findMany.mockResolvedValue([{ playerId: 'old-1' }, { playerId: 'old-2' }]);

    const view = await service.view(COACH_ID, undefined, NOW);

    expect(view.former).toBe(2);
    expect(prisma.coachTenure.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        coachPlayerId: COACH_PLAYER,
        to: { not: null },
        playerId: { notIn: ['adult', 'teen', 'child'] },
      },
      distinct: ['playerId'],
    });
  });

  it('медали: всего — включая младших, последние — только с 14 лет', async () => {
    const tournament = {
      id: 't-1',
      name: 'Кубок',
      startsAt: new Date('2026-10-10T00:00:00.000Z'),
      finishedAt: new Date('2026-10-10T12:00:00.000Z'),
    };
    prisma.registration.findMany.mockResolvedValue([
      { playerId: 'child', place: 1, tournament },
      { playerId: 'adult', place: 2, tournament },
    ]);

    const view = await service.view(COACH_ID, undefined, NOW);

    expect(view.medals.total).toBe(2);
    expect(view.medals.recent).toEqual([
      {
        player: expect.objectContaining({ id: 'adult' }) as unknown,
        place: 2,
        tournament: { id: 't-1', name: 'Кубок', startsAt: '2026-10-10T00:00:00.000Z' },
      },
    ]);
    // Турниры до ADR-048 мест не записали — досчитываются.
    expect(tournaments.ensurePlaces).toHaveBeenCalledWith(['t-1']);
  });

  it('рост — только у названных, в Decimal, только прирост', async () => {
    prisma.ratingEvent.groupBy.mockResolvedValue([
      { playerId: 'adult', _sum: { delta: new Prisma.Decimal('12.1') } },
      { playerId: 'teen', _sum: { delta: new Prisma.Decimal('-3.00') } },
    ]);

    const view = await service.view(COACH_ID, undefined, NOW);

    expect(view.growth).toEqual([
      { player: expect.objectContaining({ id: 'adult' }) as unknown, delta: '+12.10' },
    ]);
    expect(prisma.ratingEvent.groupBy.mock.calls[0]?.[0]).toMatchObject({
      where: { playerId: { in: ['adult', 'teen'] } },
    });
  });

  it('неопубликованная страница — постороннему NOT_FOUND, владельцу — видна', async () => {
    prisma.coach.findUnique.mockResolvedValue({
      playerId: COACH_PLAYER,
      userId: 'user-coach',
      status: 'PENDING',
      hiddenAt: null,
    });

    await expect(service.view(COACH_ID, undefined, NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.view(COACH_ID, 'user-coach', NOW)).resolves.toMatchObject({
      current: 3,
    });
  });
});

describe('расчёты в Decimal', () => {
  it('сумма дельт не теряет сотых: 0.1 + 0.2 — ровно 0.30', () => {
    const sum = new Prisma.Decimal('0.1').plus(new Prisma.Decimal('0.2'));

    expect(signedDelta(sum)).toBe('+0.30');
  });

  it('лучшие по росту — по убыванию, не больше трёх, ноль и минус отсеиваются', () => {
    const rows = [
      { playerId: 'a', delta: new Prisma.Decimal('5') },
      { playerId: 'b', delta: new Prisma.Decimal('40.25') },
      { playerId: 'c', delta: new Prisma.Decimal('0') },
      { playerId: 'd', delta: null },
      { playerId: 'e', delta: new Prisma.Decimal('12') },
      { playerId: 'f', delta: new Prisma.Decimal('7') },
    ];

    expect(bestGrowth(rows).map((row) => row.playerId)).toEqual(['b', 'e', 'f']);
  });
});

describe('кабинет тренера', () => {
  it('все текущие; «с какого дня» — открытый период, иначе заведение профиля', async () => {
    prisma.player.findMany.mockResolvedValue([adult, teen]);
    prisma.player.count.mockResolvedValue(2);
    prisma.coachTenure.findMany.mockResolvedValue([
      { playerId: 'adult', from: new Date('2026-09-01T00:00:00.000Z') },
    ]);

    const page = await service.manage(COACH_ID, { page: 1, limit: 20 });

    expect(page.total).toBe(2);
    expect(page.items.map((row) => [row.player.id, row.since, row.birthYear])).toEqual([
      ['adult', '2026-09-01T00:00:00.000Z', 2000],
      ['teen', '2026-01-01T00:00:00.000Z', 2012],
    ]);
  });

  it('тренер убирает ссылку на себя — история закрывается', async () => {
    await service.remove(COACH_ID, 'adult');

    expect(prisma.player.updateMany).toHaveBeenCalledWith({
      where: { id: 'adult', coachPlayerId: COACH_PLAYER },
      data: { coachPlayerId: null },
    });
    expect(prisma.coachTenure.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { playerId: 'adult', coachPlayerId: COACH_PLAYER, to: null },
    });
  });

  it('не его ученик — NOT_FOUND, история не трогается', async () => {
    prisma.player.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.remove(COACH_ID, 'stranger')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.coachTenure.updateMany).not.toHaveBeenCalled();
  });
});

describe('«Я ученик»', () => {
  it('ставит тренера, стирает вписанного строкой и открывает период', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'me', coachPlayerId: 'old-coach' });

    await service.join(COACH_ID, 'user-me');

    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: 'me' },
      data: { coachPlayerId: COACH_PLAYER, coachName: null },
    });
    expect(prisma.coachTenure.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { playerId: 'me', coachPlayerId: 'old-coach', to: null },
    });
    expect(prisma.coachTenure.create.mock.calls[0]?.[0]).toMatchObject({
      data: { playerId: 'me', coachPlayerId: COACH_PLAYER },
    });
  });

  it('уже ученик — ничего не пишется', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'me', coachPlayerId: COACH_PLAYER });

    await service.join(COACH_ID, 'user-me');

    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(prisma.coachTenure.create).not.toHaveBeenCalled();
  });

  it('сам себе — VALIDATION_FAILED; без профиля — FORBIDDEN; неопубликованная — NOT_FOUND', async () => {
    prisma.player.findUnique.mockResolvedValueOnce({ id: COACH_PLAYER, coachPlayerId: null });
    await expect(service.join(COACH_ID, 'user-coach')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    prisma.player.findUnique.mockResolvedValueOnce(null);
    await expect(service.join(COACH_ID, 'user-none')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    prisma.coach.findUnique.mockResolvedValueOnce({
      playerId: COACH_PLAYER,
      userId: 'user-coach',
      status: 'DRAFT',
      hiddenAt: null,
    });
    await expect(service.join(COACH_ID, 'user-me')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('уйти можно только от своего текущего тренера', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'me', coachPlayerId: COACH_PLAYER });

    await service.leave(COACH_ID, 'user-me');

    expect(prisma.coachTenure.updateMany).toHaveBeenCalledOnce();

    prisma.player.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.leave(COACH_ID, 'user-me')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
