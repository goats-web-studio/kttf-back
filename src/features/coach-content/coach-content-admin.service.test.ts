import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { ForumNewsService } from '../forum/forum-news.service.js';
import { CoachContentAdminService } from './coach-content-admin.service.js';

const coach = {
  id: 'coach-1',
  slug: 'kim-sergey',
  player: { lastName: 'Ким', firstName: 'Сергей' },
};

function makePrisma() {
  return {
    coachPost: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'p1',
          title: 'Акция',
          body: 'а'.repeat(300),
          imageUrl: null,
          publishedAt: new Date('2026-10-20T10:00:00Z'),
          hiddenAt: null,
          hiddenReason: null,
          coach,
        },
      ]),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    coachMedia: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          caption: null,
          imageUrl: '/api/v1/files/coaches/x.webp',
          youtubeId: null,
          createdAt: new Date('2026-10-20T12:00:00Z'),
          hiddenAt: new Date(),
          hiddenReason: 'Чужая реклама',
          coach,
        },
      ]),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: CoachContentAdminService;

beforeEach(() => {
  prisma = makePrisma();
  service = new CoachContentAdminService(
    prisma as unknown as PrismaService,
    {
      sync: vi.fn().mockResolvedValue(undefined),
      discussions: vi.fn().mockResolvedValue(new Map()),
    } as unknown as ForumNewsService,
  );
});

describe('лента модерации', () => {
  it('записи и медиа одной лентой, свежие сверху, текст обрезан', async () => {
    const page = await service.feed({ page: 1, limit: 20 });

    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(['m1', 'p1']);
    expect(page.items[0]).toMatchObject({
      kind: 'MEDIA',
      hidden: true,
      hiddenReason: 'Чужая реклама',
      coach: { id: 'coach-1', slug: 'kim-sergey', name: 'Ким Сергей' },
    });
    expect(page.items[1]?.excerpt).toHaveLength(241);
  });

  it('скрыть — с датой и причиной, вернуть — без них', async () => {
    await service.hidePost('p1', { hidden: true, reason: 'Реклама' });
    await service.hideMedia('m1', { hidden: false });

    expect(prisma.coachPost.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { hiddenAt: expect.any(Date) as Date, hiddenReason: 'Реклама' },
    });
    expect(prisma.coachMedia.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { hiddenAt: null, hiddenReason: null },
    });
  });

  it('несуществующее — NOT_FOUND', async () => {
    prisma.coachPost.updateMany.mockResolvedValue({ count: 0 });
    prisma.coachMedia.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.hidePost('x', { hidden: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.hideMedia('x', { hidden: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
