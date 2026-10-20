import { listCoachesSchema } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CoachCatalogService, coachesWhere } from './coach-catalog.service.js';

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

const spin = { id: 'club-1', name: 'Спин', hiddenAt: null };
const hidden = { id: 'club-2', name: 'Скрытый', hiddenAt: new Date() };

describe('фильтры тренеров', () => {
  it('поиск словами по ФИО игрока, только опубликованные', () => {
    const where = coachesWhere(listCoachesSchema.parse({ search: 'Сергей Ким' }));

    expect(where).toMatchObject({ status: 'APPROVED', hiddenAt: null });
    expect(JSON.stringify(where.player)).toContain('Сергей');
    expect(JSON.stringify(where.player)).toContain('Ким');
  });

  it('город и язык — страницы тренера', () => {
    expect(coachesWhere(listCoachesSchema.parse({ cityId: CITY, language: 'KK' }))).toMatchObject({
      cityId: { in: [CITY] },
      languages: { has: 'KK' },
    });
  });
});

describe('список тренеров', () => {
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
            trainings: [
              // Онлайн без цены и выезд за 8 000 — видны.
              { author: 'COACH', clubId: null, link: 'NONE', priceKzt: null, club: null },
              { author: 'COACH', clubId: null, link: 'NONE', priceKzt: 8_000, club: null },
              // Клуб ещё не ответил — не видна и в цену «от» не идёт.
              { author: 'COACH', clubId: 'club-1', link: 'PENDING', priceKzt: 3_000, club: spin },
              // Подтверждённые в «Спине» — своя и клубная.
              {
                author: 'COACH',
                clubId: 'club-1',
                link: 'CONFIRMED',
                priceKzt: 20_000,
                club: spin,
              },
              { author: 'CLUB', clubId: 'club-1', link: 'CONFIRMED', priceKzt: 15_000, club: spin },
              // Клуб скрыт — не видна.
              {
                author: 'CLUB',
                clubId: 'club-2',
                link: 'CONFIRMED',
                priceKzt: 1_000,
                club: hidden,
              },
            ],
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

  it('число и цена «от» — по видимым тренировкам, клубы — подтверждённые без повторов', async () => {
    const page = await service.list(listCoachesSchema.parse({}));

    expect(page.items[0]).toMatchObject({
      minPriceKzt: 8_000,
      trainingsCount: 4,
      clubs: [{ id: 'club-1', name: 'Спин' }],
      studentsCount: 24,
      player: { rating: '512.00' },
    });
    expect(prisma.coach.findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ profileReviewedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
  });
});
