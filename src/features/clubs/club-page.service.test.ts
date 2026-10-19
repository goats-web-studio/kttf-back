import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import { ClubPageService } from './club-page.service.js';

const clubRow = {
  id: 'club-1',
  name: 'Ракетка',
  shortName: null,
  city: { id: 'city-1', name: 'Алматы', nameKk: null },
  address: null,
  lat: null,
  lng: null,
  tableCount: 6,
  phone: null,
  whatsapp: null,
  instagram: null,
  logoUrl: null,
  description: null,
  coverUrl: null,
  website: null,
  telegram: null,
  twoGisUrl: null,
  amenities: [],
  tableBrand: null,
  floorType: null,
  ceilingHeightCm: null,
  hoursNote: null,
  primaryContact: null,
  profileReviewedAt: new Date('2026-10-20T10:00:00.000Z'),
  hiddenAt: null,
  hours: [],
  prices: [],
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
};

function makePrisma() {
  const prisma = {
    club: {
      findUnique: vi.fn().mockResolvedValue({ id: 'club-1' }),
      update: vi.fn().mockResolvedValue(clubRow),
    },
    clubHours: {
      deleteMany: vi.fn().mockReturnValue('delete-hours'),
      createMany: vi.fn().mockReturnValue('create-hours'),
    },
    clubPrice: {
      deleteMany: vi.fn().mockReturnValue('delete-prices'),
      createMany: vi.fn().mockReturnValue('create-prices'),
    },
    match: { findMany: vi.fn().mockResolvedValue([]) },
    tournament: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn((operations: unknown[]) => Promise.resolve(operations.map(() => clubRow))),
  };

  return prisma;
}

let prisma: ReturnType<typeof makePrisma>;
let tournaments: { ensurePlaces: ReturnType<typeof vi.fn> };
let service: ClubPageService;

beforeEach(() => {
  prisma = makePrisma();
  tournaments = { ensurePlaces: vi.fn().mockResolvedValue(undefined) };
  service = new ClubPageService(
    prisma as unknown as PrismaService,
    tournaments as unknown as TournamentsService,
  );
});

describe('часы и прайс', () => {
  it('неделя заменяется целиком одной транзакцией, страница становится свежей', async () => {
    const club = await service.setHours('club-1', {
      hours: [{ weekday: 1, opensMin: 480, closesMin: 1380 }],
    });

    expect(prisma.$transaction).toHaveBeenCalledWith([
      'delete-hours',
      'create-hours',
      expect.anything(),
    ]);
    expect(prisma.clubHours.createMany).toHaveBeenCalledWith({
      data: [{ clubId: 'club-1', weekday: 1, opensMin: 480, closesMin: 1380 }],
    });
    expect(prisma.club.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { profileReviewedAt: expect.any(Date) as Date } }),
    );
    expect(club.profileReviewedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('порядок строк прайса — порядок в теле, пустое примечание — null', async () => {
    await service.setPrices('club-1', {
      prices: [
        { kind: 'TABLE_RENT', title: 'Стол', priceKzt: 3000, unit: 'HOUR' },
        { kind: 'MEMBERSHIP', title: 'Абонемент', priceKzt: 25000, unit: 'MONTH', note: '8 раз' },
      ],
    });

    expect(prisma.clubPrice.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ title: 'Стол', note: null, sortOrder: 0 }),
        expect.objectContaining({ title: 'Абонемент', note: '8 раз', sortOrder: 1 }),
      ],
    });
  });

  it('несуществующий клуб — NOT_FOUND до записи', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    await expect(service.setPrices('club-9', { prices: [] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('свежесть и скрытие', () => {
  it('«Всё актуально» ставит отметку без правок', async () => {
    await service.markReviewed('club-1');

    expect(prisma.club.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { profileReviewedAt: expect.any(Date) as Date } }),
    );
  });

  it('скрыть — дата, вернуть — null', async () => {
    await service.setHidden('club-1', true);
    await service.setHidden('club-1', false);

    expect(prisma.club.update.mock.calls[0]?.[0]).toMatchObject({
      data: { hiddenAt: expect.any(Date) as Date },
    });
    expect(prisma.club.update.mock.calls[1]?.[0]).toMatchObject({ data: { hiddenAt: null } });
  });
});

describe('живые данные', () => {
  const NOW = new Date('2026-10-20T10:00:00.000Z');

  it('встречи и разные игроки за 30 дней', async () => {
    prisma.match.findMany.mockResolvedValue([
      { playerAId: 'p1', playerBId: 'p2' },
      { playerAId: 'p1', playerBId: 'p3' },
      { playerAId: 'p2', playerBId: null },
    ]);
    prisma.tournament.count.mockResolvedValue(12);

    const summary = await service.summary('club-1', NOW);

    expect(summary).toMatchObject({
      matchesRecent: 3,
      activePlayersRecent: 3,
      tournamentsHeld: 12,
    });
    expect(prisma.match.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { finishedAt: { gte: new Date('2026-09-20T10:00:00.000Z') }, status: 'FINISHED' },
    });
  });

  it('призёры последних турниров: места досчитываются, пустые места пропускаются', async () => {
    prisma.tournament.findMany.mockResolvedValueOnce([{ id: 't1' }]).mockResolvedValueOnce([
      {
        id: 't1',
        name: 'Кубок',
        startsAt: new Date('2026-10-18T09:00:00.000Z'),
        _count: { registrations: 16 },
        registrations: [
          { place: 1, placeTo: null, player: { id: 'p1', lastName: 'Ким', firstName: 'Артём' } },
          { place: 3, placeTo: 4, player: { id: 'p3', lastName: 'Ли', firstName: 'Ян' } },
          { place: null, placeTo: null, player: { id: 'p9', lastName: 'X', firstName: 'Y' } },
        ],
      },
    ]);

    const summary = await service.summary('club-1', NOW);

    expect(tournaments.ensurePlaces).toHaveBeenCalledWith(['t1']);
    expect(summary.podiums).toEqual([
      {
        tournamentId: 't1',
        name: 'Кубок',
        startsAt: '2026-10-18T09:00:00.000Z',
        participants: 16,
        places: [
          { place: 1, placeTo: null, playerId: 'p1', name: 'Ким Артём' },
          { place: 3, placeTo: 4, playerId: 'p3', name: 'Ли Ян' },
        ],
      },
    ]);
  });
});
