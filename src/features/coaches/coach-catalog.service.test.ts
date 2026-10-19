import { listCoachesSchema, listTrainingsSchema } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CoachCatalogService, coachesWhere, trainingsWhere } from './coach-catalog.service.js';

const CITY = '66666666-6666-4666-8666-666666666666';
const city = { id: CITY, name: 'Алматы', nameKk: null };

const player = {
  id: 'player-1',
  lastName: 'Ким',
  firstName: 'Сергей',
  middleName: null,
  photoUrl: '/api/v1/files/players/p.jpg',
  rating: { toString: () => '512.00' },
  isProvisional: false,
  city,
};

const trainings = (query: Record<string, string>) =>
  trainingsWhere(listTrainingsSchema.parse(query));

describe('фильтры тренировок', () => {
  it('только тренировки опубликованных страниц', () => {
    expect(trainings({}).coach).toEqual({ status: 'APPROVED', hiddenAt: null });
  });

  it('вид и место — любой из списка; город и язык — страницы тренера', () => {
    const where = trainings({
      kind: 'GROUP,KIDS_GROUP',
      place: 'CLUB',
      cityId: CITY,
      language: 'KK',
    });

    expect(where).toMatchObject({
      kind: { in: ['GROUP', 'KIDS_GROUP'] },
      place: { in: ['CLUB'] },
      coach: { status: 'APPROVED', cityId: { in: [CITY] }, languages: { has: 'KK' } },
    });
  });

  it('возраст ребёнка: детская или подростковая, берут с этого возраста или возраст не указан', () => {
    expect(trainings({ age: '9' }).AND).toEqual([
      {
        audiences: { hasSome: ['KIDS', 'TEENS'] },
        OR: [{ kidsFromAge: null }, { kidsFromAge: { lte: 9 } }],
      },
    ]);
  });

  it('аудитория и возраст складываются, а не затирают друг друга', () => {
    expect(trainings({ audience: 'TEENS,AMATEURS', age: '12' }).AND).toEqual([
      { audiences: { hasSome: ['TEENS', 'AMATEURS'] } },
      expect.objectContaining({ audiences: { hasSome: ['KIDS', 'TEENS'] } }),
    ]);
  });

  it('«цена до» включительно; без цены под фильтр не попадает', () => {
    expect(trainings({ priceTo: '15000' }).priceKzt).toEqual({ not: null, lte: 15_000 });
    expect(trainings({})).not.toHaveProperty('priceKzt');
  });

  it('без фильтров лишних условий нет', () => {
    expect(trainings({})).toEqual({ coach: { status: 'APPROVED', hiddenAt: null } });
  });
});

describe('фильтры тренеров', () => {
  it('поиск словами по ФИО игрока, только опубликованные', () => {
    const where = coachesWhere(listCoachesSchema.parse({ search: 'Сергей Ким' }));

    expect(where).toMatchObject({ status: 'APPROVED', hiddenAt: null });
    expect(where.player).toEqual({
      AND: [
        expect.objectContaining({
          OR: expect.arrayContaining([
            { firstName: { contains: 'Сергей', mode: 'insensitive' } },
          ]) as unknown,
        }),
        expect.objectContaining({
          OR: expect.arrayContaining([
            { lastName: { contains: 'Ким', mode: 'insensitive' } },
          ]) as unknown,
        }),
      ],
    });
  });
});

describe('списки', () => {
  function makePrisma() {
    return {
      coach: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'coach-1',
            slug: 'kim-sergey',
            playerId: 'player-1',
            player,
            headline: 'Детский тренер',
            photoUrl: null,
            city,
            formats: ['CLUB'],
            languages: ['RU'],
            sportsRank: 'KMS',
            coachCategory: null,
            coachingSince: 2015,
            profileReviewedAt: new Date('2026-10-20T00:00:00.000Z'),
            services: [{ priceKzt: null }, { priceKzt: 20_000 }, { priceKzt: 8_000 }],
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      coachService: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'service-1',
            kind: 'KIDS_GROUP',
            audiences: ['KIDS'],
            kidsFromAge: 6,
            place: 'CLUB',
            title: 'Детская группа',
            schedule: 'пн, ср 18:00',
            priceKzt: 20_000,
            unit: 'MONTH',
            note: null,
            coach: {
              id: 'coach-1',
              slug: 'kim-sergey',
              playerId: 'player-1',
              player,
              photoUrl: null,
              city,
              languages: ['RU'],
            },
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      player: {
        groupBy: vi.fn().mockResolvedValue([{ coachPlayerId: 'player-1', _count: { _all: 24 } }]),
      },
    };
  }

  let prisma: ReturnType<typeof makePrisma>;
  let service: CoachCatalogService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new CoachCatalogService(prisma as unknown as PrismaService);
  });

  it('тренер: цена «от» — минимум среди тренировок с ценой, ученики — по анкетам', async () => {
    const page = await service.list(listCoachesSchema.parse({}));

    expect(page.items[0]).toMatchObject({
      minPriceKzt: 8_000,
      servicesCount: 3,
      studentsCount: 24,
      player: { rating: '512.00' },
    });
    expect(prisma.coach.findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ profileReviewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
  });

  it('тренировка — со своим тренером; порядок — свежесть, тренер, его порядок', async () => {
    const page = await service.trainings(listTrainingsSchema.parse({}));

    expect(page.items[0]).toMatchObject({
      title: 'Детская группа',
      kidsFromAge: 6,
      coach: { slug: 'kim-sergey', studentsCount: 24 },
    });
    expect(prisma.coachService.findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [
        { coach: { profileReviewedAt: { sort: 'desc', nulls: 'last' } } },
        { coachId: 'asc' },
        { sortOrder: 'asc' },
      ],
    });
  });
});
