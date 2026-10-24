import { FORUM_POSTS_PER_HOUR } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ForumAccessService } from './forum-access.service.js';
import { ForumPostsService } from './forum-posts.service.js';
import { ForumSubjectsService } from './forum-subjects.service.js';

const WRITER = '11111111-1111-4111-8111-111111111111';
const QUOTED_AUTHOR = '22222222-2222-4222-8222-222222222222';
const SUBSCRIBER = '33333333-3333-4333-8333-333333333333';
const TOPIC = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';
const QUOTED = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-24T10:00:00.000Z');

const openTopic = {
  id: TOPIC,
  title: 'Накладки на 2027',
  authorId: QUOTED_AUTHOR,
  subjectType: null,
  subjectId: null,
  lockedAt: null,
  hiddenAt: null,
};

const writerUser = {
  isAdmin: false,
  player: { lastName: 'Иванов', firstName: 'Иван' },
  forumMute: null,
};

function makePrisma() {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(writerUser) },
    forumTopic: {
      findUnique: vi.fn().mockResolvedValue(openTopic),
      update: vi.fn().mockResolvedValue({ postsCount: 7 }),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn(),
    },
    forumPost: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: POST }),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    forumSubscription: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([{ userId: SUBSCRIBER }]),
    },
    forumLike: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    forumReport: { findUnique: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    notification: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => Promise<unknown>) =>
    work(prisma),
  );

  return prisma;
}

describe('ForumPostsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ForumPostsService;

  beforeEach(() => {
    prisma = makePrisma();
    const db = prisma as unknown as PrismaService;
    service = new ForumPostsService(
      db,
      new ForumAccessService(db),
      new NotificationsService(db),
      new ForumSubjectsService(db),
    );
  });

  describe('insert', () => {
    it('номер — следующий после счётчика темы, автор подписывается', async () => {
      const writer = { userId: WRITER, isAdmin: false, name: 'Иванов Иван' };

      await service.insert(
        prisma as never,
        openTopic,
        writer,
        { body: 'Привет', images: [], quote: null },
        NOW,
      );

      expect(prisma.forumTopic.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { postsCount: { increment: 1 }, lastPostAt: NOW, lastPostAuthorId: WRITER },
        }),
      );
      const [created] = prisma.forumPost.create.mock.calls[0] as [{ data: { number: number } }];

      expect(created.data.number).toBe(7);
      expect(prisma.forumSubscription.createMany).toHaveBeenCalledWith({
        data: [{ topicId: TOPIC, userId: WRITER }],
        skipDuplicates: true,
      });
    });

    it('цитата — уведомление автору цитаты, подписчикам — о новом без него', async () => {
      const writer = { userId: WRITER, isAdmin: false, name: 'Иванов Иван' };

      await service.insert(
        prisma as never,
        openTopic,
        writer,
        {
          body: 'Согласен',
          images: [],
          quote: { postId: QUOTED, text: 'фрагмент', authorId: QUOTED_AUTHOR },
        },
        NOW,
      );

      const created = prisma.notification.createMany.mock.calls.map(
        ([arg]) => (arg as { data: { userId: string; type: string }[] }).data,
      );

      expect(created).toEqual([
        [expect.objectContaining({ userId: QUOTED_AUTHOR, type: 'FORUM_REPLY' })],
        [expect.objectContaining({ userId: SUBSCRIBER, type: 'FORUM_TOPIC_UPDATE' })],
      ]);
      expect(prisma.forumSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { topicId: TOPIC, userId: { notIn: [WRITER, QUOTED_AUTHOR] } },
        }),
      );
    });
  });

  describe('reply', () => {
    it('в закрытую тему — отказ FORUM_TOPIC_LOCKED', async () => {
      prisma.forumTopic.findUnique.mockResolvedValue({ ...openTopic, lockedAt: NOW });

      await expect(service.reply(TOPIC, WRITER, { body: 'x' }, NOW)).rejects.toMatchObject({
        code: 'FORUM_TOPIC_LOCKED',
      });
    });

    it('без профиля игрока — FORUM_PROFILE_REQUIRED', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...writerUser, player: null });

      await expect(service.reply(TOPIC, WRITER, { body: 'x' }, NOW)).rejects.toMatchObject({
        code: 'FORUM_PROFILE_REQUIRED',
      });
    });

    it('под действующим запретом — FORUM_MUTED с датой', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...writerUser,
        forumMute: { until: new Date('2026-11-01T00:00:00.000Z'), reason: 'флуд' },
      });

      await expect(service.reply(TOPIC, WRITER, { body: 'x' }, NOW)).rejects.toMatchObject({
        code: 'FORUM_MUTED',
      });
    });

    it('истёкший запрет не мешает', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...writerUser,
        forumMute: { until: new Date('2026-10-01T00:00:00.000Z'), reason: 'флуд' },
      });
      prisma.forumPost.findUnique.mockResolvedValue(null);

      await expect(service.reply(TOPIC, WRITER, { body: 'x' }, NOW)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(prisma.forumPost.create).toHaveBeenCalled();
    });

    it('лимит сообщений в час — FORUM_LIMIT', async () => {
      prisma.forumPost.count.mockResolvedValue(FORUM_POSTS_PER_HOUR);

      await expect(service.reply(TOPIC, WRITER, { body: 'x' }, NOW)).rejects.toMatchObject({
        code: 'FORUM_LIMIT',
      });
    });

    it('цитата из другой темы — ошибка поля', async () => {
      prisma.forumPost.findUnique.mockResolvedValue({
        topicId: 'другая',
        authorId: QUOTED_AUTHOR,
        deletedAt: null,
        hiddenAt: null,
      });

      await expect(
        service.reply(TOPIC, WRITER, { body: 'x', quote: { postId: QUOTED, text: 'a' } }, NOW),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('скрытая тема для постороннего не существует', async () => {
      prisma.forumTopic.findUnique.mockResolvedValue({ ...openTopic, hiddenAt: NOW });

      await expect(service.reply(TOPIC, WRITER, { body: 'x' }, NOW)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('remove', () => {
    const own = {
      id: POST,
      topicId: TOPIC,
      authorId: WRITER,
      deletedAt: null,
      hiddenAt: null,
      topic: openTopic,
    };

    it('единственное сообщение уносит тему', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(own);
      prisma.forumPost.count.mockResolvedValue(0);

      await service.remove(POST, WRITER, NOW);

      expect(prisma.forumTopic.delete).toHaveBeenCalledWith({ where: { id: TOPIC } });
      expect(prisma.forumPost.update).not.toHaveBeenCalled();
    });

    it('иначе — заглушка: текст, фото и цитата стёрты, номер остаётся', async () => {
      prisma.forumPost.findUnique.mockResolvedValue(own);
      prisma.forumPost.count.mockResolvedValue(4);

      await service.remove(POST, WRITER, NOW);

      expect(prisma.forumPost.update).toHaveBeenCalledWith({
        where: { id: POST },
        data: { deletedAt: NOW, body: '', images: [], quoteText: null, quotePostId: null },
      });
    });

    it('чужое удалить нельзя', async () => {
      prisma.forumPost.findUnique.mockResolvedValue({ ...own, authorId: SUBSCRIBER });

      await expect(service.remove(POST, WRITER, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('like', () => {
    it('своё отмечать нельзя', async () => {
      prisma.forumPost.findUnique.mockResolvedValue({
        authorId: WRITER,
        deletedAt: null,
        hiddenAt: null,
        topic: openTopic,
      });

      await expect(service.like(POST, WRITER, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('повторное «нравится» счётчик не меняет', async () => {
      prisma.forumPost.findUnique.mockResolvedValue({
        authorId: SUBSCRIBER,
        deletedAt: null,
        hiddenAt: null,
        topic: openTopic,
      });
      prisma.forumLike.createMany.mockResolvedValue({ count: 0 });
      prisma.forumPost.update.mockResolvedValue({ likesCount: 3 });

      await expect(service.like(POST, WRITER, true)).resolves.toEqual({ likes: 3, liked: true });
      expect(prisma.forumPost.update).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
    });
  });
});
