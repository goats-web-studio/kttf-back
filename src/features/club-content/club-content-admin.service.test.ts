import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { ForumNewsService } from '../forum/forum-news.service.js';
import { ClubContentAdminService } from './club-content-admin.service.js';
import { YoutubeCovers } from './youtube-covers.js';

const club = { id: 'club-1', name: 'Ракетка' };

function makePrisma() {
  return {
    clubPost: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'p1',
          title: 'Акция',
          body: 'а'.repeat(300),
          imageUrl: null,
          publishedAt: new Date('2026-10-20T10:00:00Z'),
          hiddenAt: null,
          hiddenReason: null,
          club,
        },
      ]),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    clubMedia: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          caption: null,
          imageUrl: '/api/v1/files/clubs/x.webp',
          youtubeId: null,
          createdAt: new Date('2026-10-20T12:00:00Z'),
          hiddenAt: new Date(),
          hiddenReason: 'Чужая реклама',
          club,
        },
      ]),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: ClubContentAdminService;

beforeEach(() => {
  prisma = makePrisma();
  service = new ClubContentAdminService(
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
    });
    expect(page.items[1]?.excerpt).toHaveLength(241);
  });

  it('скрыть — с датой и причиной, вернуть — без них', async () => {
    await service.hidePost('p1', { hidden: true, reason: 'Реклама' });
    await service.hideMedia('m1', { hidden: false });

    expect(prisma.clubPost.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { hiddenAt: expect.any(Date) as Date, hiddenReason: 'Реклама' },
    });
    expect(prisma.clubMedia.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { hiddenAt: null, hiddenReason: null },
    });
  });

  it('несуществующее — NOT_FOUND', async () => {
    prisma.clubPost.updateMany.mockResolvedValue({ count: 0 });
    prisma.clubMedia.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.hidePost('x', { hidden: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.hideMedia('x', { hidden: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('обложка YouTube', () => {
  const covers = new YoutubeCovers();
  const ok = (body: string) => ({
    ok: true,
    arrayBuffer: () => Promise.resolve(Buffer.from(body)),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('крупная, если есть; иначе мелкая с полосами', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok('max')));
    await expect(covers.fetch('dQw4w9WgXcQ')).resolves.toMatchObject({ letterboxed: false });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(ok('hq')),
    );
    await expect(covers.fetch('dQw4w9WgXcQ')).resolves.toMatchObject({ letterboxed: true });
  });

  it('нет ни одной или сеть упала — ролика нет', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(covers.fetch('dQw4w9WgXcQ')).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND' });
  });
});
