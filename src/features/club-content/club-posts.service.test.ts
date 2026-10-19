import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ClubPostsService } from './club-posts.service.js';

const NOW = new Date('2026-10-20T10:00:00.000Z');

const row = {
  id: 'post-1',
  clubId: 'club-1',
  kind: 'PROMO' as const,
  title: 'Скидка',
  body: 'Минус 20% на абонемент',
  imageUrl: null,
  validUntil: new Date('2026-10-31T00:00:00.000Z'),
  pinnedAt: null,
  publishedAt: NOW,
  editedAt: null,
  hiddenAt: null,
  hiddenReason: null,
};

function makePrisma() {
  const prisma = {
    club: { findUnique: vi.fn().mockResolvedValue({ plan: 'FREE' }) },
    clubPost: {
      findMany: vi.fn().mockResolvedValue([row]),
      findFirst: vi.fn().mockResolvedValue({ kind: 'PROMO' }),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockReturnValue(Promise.resolve(row)),
      updateMany: vi.fn().mockReturnValue('unpin'),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn((operations: unknown[]) => Promise.resolve(operations.map(() => row))),
  };

  return prisma;
}

let prisma: ReturnType<typeof makePrisma>;
let service: ClubPostsService;

beforeEach(() => {
  prisma = makePrisma();
  service = new ClubPostsService(prisma as unknown as PrismaService);
});

describe('лента клуба', () => {
  it('без архива — новости и непрошедшие акции, без скрытых; закреп сверху', async () => {
    const page = await service.list('club-1', { page: 1, limit: 20 }, NOW);

    const query = prisma.clubPost.findMany.mock.calls[0]?.[0] as {
      where: object;
      orderBy: unknown;
    };
    expect(query.where).toEqual({
      clubId: 'club-1',
      hiddenAt: null,
      OR: [
        { kind: 'NEWS' },
        { validUntil: null },
        { validUntil: { gte: new Date('2026-10-20T00:00:00.000Z') } },
      ],
    });
    expect(query.orderBy).toEqual([
      { pinnedAt: { sort: 'desc', nulls: 'last' } },
      { publishedAt: 'desc' },
    ]);
    expect(page.items[0]).toMatchObject({ validUntil: '2026-10-31', pinned: false, hidden: false });
  });

  it('с архивом — и прошедшие акции', async () => {
    await service.list('club-1', { page: 1, limit: 20, archive: true }, NOW);

    expect((prisma.clubPost.findMany.mock.calls[0]?.[0] as { where: object }).where).toEqual({
      clubId: 'club-1',
      hiddenAt: null,
    });
  });

  it('кабинет видит и скрытые', async () => {
    await service.listForStaff('club-1', { page: 1, limit: 20 });

    expect((prisma.clubPost.findMany.mock.calls[0]?.[0] as { where: object }).where).toEqual({
      clubId: 'club-1',
    });
  });
});

describe('новая запись', () => {
  it('срок только у акции, автор пишется', async () => {
    await service.create(
      'club-1',
      { kind: 'PROMO', title: 'Скидка', body: 'Текст', validUntil: '2026-10-31' },
      'user-1',
      NOW,
    );

    expect(prisma.clubPost.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        authorId: 'user-1',
        validUntil: new Date('2026-10-31T00:00:00.000Z'),
        imageUrl: null,
      },
    });
  });

  it('у новости срока нет', async () => {
    await service.create('club-1', { kind: 'NEWS', title: 'Т', body: 'Текст' }, 'user-1', NOW);

    expect(prisma.clubPost.create.mock.calls[0]?.[0]).toMatchObject({ data: { validUntil: null } });
  });

  it('пока тарифы выключены, записей в месяц сколько угодно', async () => {
    prisma.clubPost.count.mockResolvedValue(1000);

    await service.create('club-1', { kind: 'NEWS', title: 'Т', body: 'Текст' }, 'user-1', NOW);

    expect(prisma.clubPost.create).toHaveBeenCalled();
  });

  it('несуществующий клуб — NOT_FOUND', async () => {
    prisma.club.findUnique.mockResolvedValue(null);

    await expect(
      service.create('club-9', { kind: 'NEWS', title: 'Т', body: 'Текст' }, 'user-1', NOW),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('правка записи', () => {
  it('закреп снимает закреп с другой записи одной транзакцией', async () => {
    const post = await service.update('club-1', 'post-1', { pinned: true }, NOW);

    expect(prisma.clubPost.updateMany).toHaveBeenCalledWith({
      where: { clubId: 'club-1', id: { not: 'post-1' }, pinnedAt: { not: null } },
      data: { pinnedAt: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.clubPost.update.mock.calls[0]?.[0]).toMatchObject({
      data: { pinnedAt: NOW },
    });
    // Закреп — не правка текста.
    expect(prisma.clubPost.update.mock.calls[0]?.[0]).not.toHaveProperty('data.editedAt');
    expect(post.id).toBe('post-1');
  });

  it('правка текста ставит «изменено», снятие закрепа — без транзакции', async () => {
    await service.update('club-1', 'post-1', { title: 'Новое', pinned: false }, NOW);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.clubPost.update.mock.calls[0]?.[0]).toMatchObject({
      data: { title: 'Новое', pinnedAt: null, editedAt: NOW },
    });
  });

  it('акция, ставшая новостью, теряет срок; срок акции стирается null', async () => {
    await service.update('club-1', 'post-1', { kind: 'NEWS' }, NOW);
    await service.update('club-1', 'post-1', { validUntil: null }, NOW);
    await service.update('club-1', 'post-1', { validUntil: '2026-11-30' }, NOW);

    const data = prisma.clubPost.update.mock.calls.map(
      (call) => (call[0] as { data: { validUntil?: unknown } }).data.validUntil,
    );
    expect(data).toEqual([null, null, new Date('2026-11-30T00:00:00.000Z')]);
  });

  it('чужая или несуществующая запись — NOT_FOUND', async () => {
    prisma.clubPost.findFirst.mockResolvedValue(null);

    await expect(service.update('club-1', 'post-9', { title: 'X' }, NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('удаление чужой записи — NOT_FOUND', async () => {
    prisma.clubPost.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.remove('club-1', 'post-9')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.clubPost.deleteMany).toHaveBeenCalledWith({
      where: { id: 'post-9', clubId: 'club-1' },
    });
  });
});
