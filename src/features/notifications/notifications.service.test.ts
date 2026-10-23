import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

const NOW = new Date('2026-10-22T10:00:00.000Z');
/** `NOTIFICATIONS_KEEP_DAYS` = 90 дней назад. */
const KEEP_FROM = new Date('2026-07-24T10:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const INBOX_ID = '33333333-3333-4333-8333-333333333333';

const answered = {
  id: ID,
  type: 'TRIAL_REQUEST_ANSWERED',
  data: {
    trialRequestId: REQUEST_ID,
    trainingTitle: 'Группа',
    status: 'ACCEPTED',
    targetName: 'Ким Сергей',
  },
  readAt: null,
  createdAt: new Date('2026-10-22T09:00:00.000Z'),
};

function makePrisma() {
  return {
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([answered]),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: NotificationsService;

beforeEach(() => {
  prisma = makePrisma();
  service = new NotificationsService(prisma as unknown as PrismaService);
});

const query = { page: 1, limit: 20 };

describe('запись', () => {
  const data = {
    trialRequestId: REQUEST_ID,
    trainingTitle: 'Группа',
    requesterName: 'Иванов Пётр',
    inbox: { kind: 'CLUB' as const, id: INBOX_ID, name: 'Спин' },
  };
  const tx = (): Pick<Prisma.TransactionClient, 'notification'> =>
    prisma as unknown as Pick<Prisma.TransactionClient, 'notification'>;

  it('по строке на адресата, повторы адресатов схлопываются', async () => {
    await service.create(tx(), ['user-1', 'user-2', 'user-1'], 'TRIAL_REQUEST_NEW', data);

    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'user-1', type: 'TRIAL_REQUEST_NEW', data },
        { userId: 'user-2', type: 'TRIAL_REQUEST_NEW', data },
      ],
    });
  });

  it('без адресатов в базу не ходит', async () => {
    await service.create(tx(), [], 'TRIAL_REQUEST_NEW', data);

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe('список', () => {
  it('только свои и не старше срока хранения, новые первыми', async () => {
    const page = await service.list('user-1', query, NOW);

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', createdAt: { gte: KEEP_FROM } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      }),
    );
    expect(page).toEqual({
      items: [
        {
          ...answered,
          readAt: null,
          createdAt: '2026-10-22T09:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
  });

  it('строка, не прошедшая контракт, пропускается с предупреждением', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma.notification.findMany.mockResolvedValue([
      { ...answered, id: '44444444-4444-4444-8444-444444444444', data: { trialRequestId: 'x' } },
      answered,
    ]);

    const page = await service.list('user-1', query, NOW);

    expect(page.items.map((item) => item.id)).toEqual([ID]);
    expect(warned).toHaveBeenCalledOnce();
    warned.mockRestore();
  });

  it('старые удаляются попутно — не чаще раза в час', async () => {
    await service.list('user-1', query, NOW);
    await service.list('user-1', query, new Date(NOW.getTime() + 30 * 60_000));
    await service.list('user-1', query, new Date(NOW.getTime() + 61 * 60_000));

    expect(prisma.notification.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.notification.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: { createdAt: { lt: KEEP_FROM } },
    });
  });

  it('сбой чистки список не роняет', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma.notification.deleteMany.mockRejectedValue(new Error('база занята'));

    await expect(service.list('user-1', query, NOW)).resolves.toMatchObject({ total: 1 });
    warned.mockRestore();
  });
});

describe('непрочитанные и отметка', () => {
  it('число непрочитанных — своих и не старше срока', async () => {
    prisma.notification.count.mockResolvedValue(4);

    await expect(service.unread('user-1', NOW)).resolves.toEqual({ unread: 4 });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null, createdAt: { gte: KEEP_FROM } },
    });
  });

  it('перечисленные — только среди своих', async () => {
    await service.read('user-1', { ids: [ID] }, NOW);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null, id: { in: [ID] } },
      data: { readAt: NOW },
    });
  });

  it('без списка — все свои', async () => {
    await service.read('user-1', {}, NOW);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', readAt: null },
      data: { readAt: NOW },
    });
  });
});

describe('NotificationsService — форум', () => {
  const TOPIC = '44444444-4444-4444-8444-444444444444';
  const POST = '55555555-5555-4555-8555-555555555555';
  const snapshot = {
    topicId: TOPIC,
    topicTitle: 'Накладки',
    postId: POST,
    number: 5,
    authorName: 'Ким Сергей',
  };

  it('непрочитанное о теме растёт счётчиком, остальным — новое', async () => {
    const tx = {
      notification: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: ID, userId: 'user-1', data: { ...snapshot, number: 2, count: 3 } },
          ]),
        update: vi.fn(),
        createMany: vi.fn(),
      },
    };

    await service.bumpForumTopic(tx as never, ['user-1', 'user-2', 'user-2'], snapshot, NOW);

    expect(tx.notification.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: {
        // Ссылка остаётся на первом непрочитанном (№ 2), автор — последний.
        data: { ...snapshot, number: 2, count: 4 },
        createdAt: NOW,
      },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-2', type: 'FORUM_TOPIC_UPDATE', data: { ...snapshot, count: 1 } }],
    });
  });

  it('открыл тему — ответы и новые в ней прочитаны', async () => {
    await service.settleForumTopic('user-1', TOPIC, NOW);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        type: { in: ['FORUM_REPLY', 'FORUM_TOPIC_UPDATE'] },
        readAt: null,
        data: { path: ['topicId'], equals: TOPIC },
      },
      data: { readAt: NOW },
    });
  });
});
