import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CoachStatsService } from './coach-stats.service.js';

function makePrisma() {
  return {
    coach: {
      findUnique: vi.fn().mockResolvedValue({ status: 'APPROVED', hiddenAt: null, plan: 'FREE' }),
    },
    coachStatDaily: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: CoachStatsService;

const NOW = new Date('2026-10-20T10:00:00.000Z');
const view = { kind: 'VIEW', source: 'ORGANIC' } as const;

beforeEach(() => {
  prisma = makePrisma();
  service = new CoachStatsService(
    prisma as unknown as PrismaService,
    { JWT_SECRET: 'secret'.repeat(8) } as Env,
  );
});

describe('учёт события', () => {
  it('прибавляет единицу в колонку вида за день по UTC+5 и источник', async () => {
    await service.record(
      'coach-1',
      { kind: 'TELEGRAM', source: 'CAMPAIGN' },
      '1.2.3.4',
      new Date('2026-10-20T19:30:00.000Z'),
    );

    expect(prisma.coachStatDaily.upsert).toHaveBeenCalledWith({
      where: {
        coachId_date_source: {
          coachId: 'coach-1',
          date: new Date('2026-10-21T00:00:00.000Z'),
          source: 'CAMPAIGN',
        },
      },
      create: {
        coachId: 'coach-1',
        date: new Date('2026-10-21T00:00:00.000Z'),
        source: 'CAMPAIGN',
        telegramClicks: 1,
      },
      update: { telegramClicks: { increment: 1 } },
    });
  });

  it('«Записаться» в группу клуба — своей колонкой, повтор не считается', async () => {
    const event = { kind: 'CLUB_GROUP', source: 'ORGANIC' } as const;

    await service.record('coach-1', event, '1.2.3.4', NOW);
    await service.record('coach-1', event, '1.2.3.4', new Date(NOW.getTime() + 60_000));

    expect(prisma.coachStatDaily.upsert).toHaveBeenCalledOnce();
    expect(prisma.coachStatDaily.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { clubGroupClicks: 1 },
      update: { clubGroupClicks: { increment: 1 } },
    });
  });

  it('у неопубликованной страницы «Записаться» в группу не считается', async () => {
    prisma.coach.findUnique.mockResolvedValueOnce({ status: 'PENDING', hiddenAt: null });

    await service.record('coach-1', { kind: 'CLUB_GROUP', source: 'ORGANIC' }, '1.2.3.4', NOW);

    expect(prisma.coachStatDaily.upsert).not.toHaveBeenCalled();
  });

  it('адрес в базу не попадает', async () => {
    await service.record('coach-1', view, '10.0.0.77', NOW);

    expect(JSON.stringify(prisma.coachStatDaily.upsert.mock.calls)).not.toContain('10.0.0.77');
  });

  it('повтор с того же адреса в течение получаса не считается', async () => {
    await service.record('coach-1', view, '1.2.3.4', NOW);
    await service.record('coach-1', view, '1.2.3.4', new Date(NOW.getTime() + 60_000));

    expect(prisma.coachStatDaily.upsert).toHaveBeenCalledOnce();
  });

  it('черновик, заявка, скрытая и чужая страница молча не считаются', async () => {
    const pages = [
      { status: 'DRAFT', hiddenAt: null },
      { status: 'PENDING', hiddenAt: null },
      { status: 'APPROVED', hiddenAt: new Date() },
      null,
    ];

    for (const [index, page] of pages.entries()) {
      prisma.coach.findUnique.mockResolvedValueOnce(page);
      await service.record(`coach-${String(index)}`, view, '1.2.3.4', NOW);
    }

    expect(prisma.coachStatDaily.upsert).not.toHaveBeenCalled();
  });
});

describe('статистика', () => {
  it('окно в днях включительно, колонки — короткими именами', async () => {
    prisma.coachStatDaily.findMany.mockResolvedValue([
      {
        coachId: 'coach-1',
        date: new Date('2026-10-19T00:00:00.000Z'),
        source: 'ORGANIC',
        views: 7,
        phoneClicks: 1,
        whatsappClicks: 2,
        telegramClicks: 0,
        instagramClicks: 3,
        clubGroupClicks: 2,
      },
    ]);

    const stats = await service.stats('coach-1', 7, NOW);

    expect(stats).toEqual({
      from: '2026-10-14',
      to: '2026-10-20',
      rows: [
        {
          date: '2026-10-19',
          source: 'ORGANIC',
          views: 7,
          phone: 1,
          whatsapp: 2,
          telegram: 0,
          instagram: 3,
          clubGroup: 2,
        },
      ],
    });
  });

  it('несуществующая страница — NOT_FOUND', async () => {
    prisma.coach.findUnique.mockResolvedValue(null);

    await expect(service.stats('coach-9', 7, NOW)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('пока тарифы выключены, год доступен и бесплатной странице', async () => {
    await expect(service.stats('coach-1', 365, NOW)).resolves.toMatchObject({ to: '2026-10-20' });
  });
});
