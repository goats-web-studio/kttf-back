import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REPEAT_WINDOW_MS } from '../../common/repeat-filter.js';
import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ClubStatsService, clubDate } from './club-stats.service.js';

function makePrisma() {
  return {
    club: { findUnique: vi.fn().mockResolvedValue({ id: 'club-1', plan: 'FREE' }) },
    clubStatDaily: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: ClubStatsService;

const NOW = new Date('2026-10-20T10:00:00.000Z');
const view = { kind: 'VIEW', source: 'ORGANIC' } as const;

beforeEach(() => {
  prisma = makePrisma();
  service = new ClubStatsService(
    prisma as unknown as PrismaService,
    { JWT_SECRET: 'secret'.repeat(8) } as Env,
  );
});

describe('день клуба', () => {
  it('по UTC+5: 20:00 UTC — это уже завтра', () => {
    expect(clubDate(new Date('2026-10-20T18:59:00Z')).toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    );
    expect(clubDate(new Date('2026-10-20T19:00:00Z')).toISOString()).toBe(
      '2026-10-21T00:00:00.000Z',
    );
  });
});

describe('учёт события', () => {
  it('прибавляет единицу в колонку вида за день и источник', async () => {
    await service.record('club-1', { kind: 'WHATSAPP', source: 'CAMPAIGN' }, '1.2.3.4', NOW);

    expect(prisma.clubStatDaily.upsert).toHaveBeenCalledWith({
      where: {
        clubId_date_source: {
          clubId: 'club-1',
          date: new Date('2026-10-20T00:00:00.000Z'),
          source: 'CAMPAIGN',
        },
      },
      create: {
        clubId: 'club-1',
        date: new Date('2026-10-20T00:00:00.000Z'),
        source: 'CAMPAIGN',
        whatsappClicks: 1,
      },
      update: { whatsappClicks: { increment: 1 } },
    });
  });

  it('повтор с того же адреса в течение получаса не считается', async () => {
    await service.record('club-1', view, '1.2.3.4', NOW);
    await service.record('club-1', view, '1.2.3.4', new Date(NOW.getTime() + 60_000));

    expect(prisma.clubStatDaily.upsert).toHaveBeenCalledOnce();
  });

  it('после получаса, с другого адреса или другой вид — считается', async () => {
    await service.record('club-1', view, '1.2.3.4', NOW);
    await service.record('club-1', view, '1.2.3.4', new Date(NOW.getTime() + REPEAT_WINDOW_MS));
    await service.record('club-1', view, '5.6.7.8', NOW);
    await service.record('club-1', { kind: 'PHONE', source: 'ORGANIC' }, '1.2.3.4', NOW);

    expect(prisma.clubStatDaily.upsert).toHaveBeenCalledTimes(4);
  });

  it('чужой клуб молча не считается', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    await service.record('club-9', view, '1.2.3.4', NOW);

    expect(prisma.clubStatDaily.upsert).not.toHaveBeenCalled();
  });
});

describe('статистика', () => {
  it('окно в днях включительно, колонки — короткими именами', async () => {
    prisma.clubStatDaily.findMany.mockResolvedValue([
      {
        clubId: 'club-1',
        date: new Date('2026-10-19T00:00:00.000Z'),
        source: 'ORGANIC',
        views: 5,
        phoneClicks: 1,
        whatsappClicks: 2,
        telegramClicks: 0,
        instagramClicks: 0,
        websiteClicks: 0,
        routeClicks: 1,
      },
    ]);

    const stats = await service.stats('club-1', 7, NOW);

    expect(stats).toMatchObject({ from: '2026-10-14', to: '2026-10-20' });
    expect(stats.rows).toEqual([
      {
        date: '2026-10-19',
        source: 'ORGANIC',
        views: 5,
        phone: 1,
        whatsapp: 2,
        telegram: 0,
        instagram: 0,
        website: 0,
        route: 1,
      },
    ]);
  });

  it('несуществующий клуб — NOT_FOUND', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    await expect(service.stats('club-9', 7, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('пока тарифы выключены, год доступен и бесплатному клубу', async () => {
    await expect(service.stats('club-1', 365, NOW)).resolves.toMatchObject({ to: '2026-10-20' });
  });
});
