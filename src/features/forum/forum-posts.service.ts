import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type CreateForumPostInput,
  type CreateForumReportInput,
  type ForumImage,
  type ForumLikeView,
  type ForumPostItem,
  type ForumPostLocation,
  type ForumPostView,
  type ListForumPlayerPostsQuery,
  type ListForumPostsQuery,
  type Page,
  type UpdateForumPostInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ForumAccessService, type Writer } from './forum-access.service.js';
import {
  postFields,
  postItemFields,
  toPostItem,
  toPostView,
  type PostRecord,
  type Viewer,
} from './forum-views.js';

/** Тема глазами того, кто в неё пишет или читает. */
export interface TopicState {
  readonly id: string;
  readonly title: string;
  readonly authorId: string | null;
  readonly subjectType: string | null;
  readonly lockedAt: Date | null;
  readonly hiddenAt: Date | null;
}

const topicStateFields = {
  id: true,
  title: true,
  authorId: true,
  subjectType: true,
  lockedAt: true,
  hiddenAt: true,
} satisfies Prisma.ForumTopicSelect;

/** Новое сообщение до записи: текст, цитата уже проверена. */
export interface NewPost {
  readonly body: string;
  readonly images: readonly ForumImage[];
  readonly quote: {
    readonly postId: string;
    readonly text: string;
    readonly authorId: string | null;
  } | null;
}

/**
 * Сообщения форума — ADR-064. Номер выдаётся увеличением счётчика темы в
 * транзакции ответа: строка темы блокируется, два ответа одновременно не
 * получат один номер. Уведомления пишутся той же транзакцией.
 */
@Injectable()
export class ForumPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ForumAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- чтение

  async list(
    topicId: string,
    viewer: Viewer,
    query: ListForumPostsQuery,
  ): Promise<Page<ForumPostView>> {
    await this.visibleTopic(topicId, viewer);

    const [rows, total] = await Promise.all([
      this.prisma.forumPost.findMany({
        where: { topicId },
        select: postFields,
        orderBy: { number: 'asc' },
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.forumPost.count({ where: { topicId } }),
    ]);

    return pageOf(await this.views(rows, viewer), total, query);
  }

  /** Последние сообщения темы по порядку — блок на странице предмета. */
  async last(topicId: string, viewer: Viewer, take: number): Promise<ForumPostView[]> {
    const rows = await this.prisma.forumPost.findMany({
      where: { topicId },
      select: postFields,
      orderBy: { number: 'desc' },
      take,
    });

    return this.views(rows.reverse(), viewer);
  }

  async views(rows: readonly PostRecord[], viewer: Viewer): Promise<ForumPostView[]> {
    const liked =
      viewer.userId === undefined || rows.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.prisma.forumLike.findMany({
                where: { userId: viewer.userId, postId: { in: rows.map((row) => row.id) } },
                select: { postId: true },
              })
            ).map((like) => like.postId),
          );

    return rows.map((row) => toPostView(row, viewer, liked.has(row.id)));
  }

  /** Сообщения игрока для профиля: без удалённых, скрытых и скрытых тем. */
  async byPlayer(query: ListForumPlayerPostsQuery): Promise<Page<ForumPostItem>> {
    const where = {
      author: { player: { id: query.authorPlayerId } },
      deletedAt: null,
      hiddenAt: null,
      topic: { hiddenAt: null },
    } satisfies Prisma.ForumPostWhereInput;
    const [rows, total] = await Promise.all([
      this.prisma.forumPost.findMany({
        where,
        select: postItemFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.forumPost.count({ where }),
    ]);

    return pageOf(rows.map(toPostItem), total, query);
  }

  async locate(postId: string, viewer: Viewer): Promise<ForumPostLocation> {
    const post = await this.prisma.forumPost.findUnique({
      where: { id: postId },
      select: { topicId: true, number: true },
    });

    if (post === null) throw postNotFound(postId);

    await this.visibleTopic(post.topicId, viewer);

    return { topicId: post.topicId, number: post.number };
  }

  /**
   * Тема, которую этот человек вправе видеть. Скрытая — только автору и
   * администратору; остальным её нет.
   */
  async visibleTopic(topicId: string, viewer: Viewer): Promise<TopicState> {
    const topic = await this.prisma.forumTopic.findUnique({
      where: { id: topicId },
      select: topicStateFields,
    });

    if (topic === null || !canSeeTopic(topic, viewer)) throw topicNotFound(topicId);

    return topic;
  }

  // ---------------------------------------------------------------- запись

  async reply(
    topicId: string,
    userId: string,
    input: CreateForumPostInput,
    now = new Date(),
  ): Promise<ForumPostView> {
    const writer = await this.access.writer(userId, now);
    const topic = await this.visibleTopic(topicId, writer);

    assertOpen(topic, writer);
    await this.access.assertLimit(writer, 'POSTS', now);

    const post = await this.prepare(topicId, input);
    const id = await this.prisma.$transaction(async (tx) =>
      this.insert(tx, topic, writer, post, now),
    );

    return this.one(id, writer);
  }

  /** Проверка цитаты: сообщение этой же темы, не удалено и не скрыто. */
  async prepare(topicId: string | null, input: CreateForumPostInput): Promise<NewPost> {
    if (input.quote === undefined) {
      return { body: input.body, images: input.images ?? [], quote: null };
    }

    const quoted = await this.prisma.forumPost.findUnique({
      where: { id: input.quote.postId },
      select: { topicId: true, authorId: true, deletedAt: true, hiddenAt: true },
    });

    if (quoted?.topicId !== topicId || quoted.deletedAt !== null || quoted.hiddenAt !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Quoted post is not available', {
        field: 'quote',
      });
    }

    return {
      body: input.body,
      images: input.images ?? [],
      quote: { postId: input.quote.postId, text: input.quote.text, authorId: quoted.authorId },
    };
  }

  /**
   * Сообщение в тему внутри транзакции: номер, подписка автора,
   * уведомления — автору цитаты и подписчикам.
   */
  async insert(
    tx: Prisma.TransactionClient,
    topic: Pick<TopicState, 'id' | 'title'>,
    writer: Writer,
    post: NewPost,
    now: Date,
  ): Promise<string> {
    const { postsCount: number } = await tx.forumTopic.update({
      where: { id: topic.id },
      data: { postsCount: { increment: 1 }, lastPostAt: now, lastPostAuthorId: writer.userId },
      select: { postsCount: true },
    });
    const created = await tx.forumPost.create({
      data: {
        topicId: topic.id,
        authorId: writer.userId,
        number,
        body: post.body,
        images: post.images.map((image) => ({ ...image })),
        quotePostId: post.quote?.postId ?? null,
        quoteText: post.quote?.text ?? null,
        createdAt: now,
      },
      select: { id: true },
    });

    await tx.forumSubscription.createMany({
      data: [{ topicId: topic.id, userId: writer.userId }],
      skipDuplicates: true,
    });

    const snapshot = {
      topicId: topic.id,
      topicTitle: topic.title,
      postId: created.id,
      number,
      authorName: writer.name,
    };
    const quotedAuthor = post.quote?.authorId ?? null;
    const replyTo = quotedAuthor !== null && quotedAuthor !== writer.userId ? quotedAuthor : null;

    if (replyTo !== null) {
      await this.notifications.create(tx, [replyTo], 'FORUM_REPLY', snapshot);
    }

    const subscribers = await tx.forumSubscription.findMany({
      where: {
        topicId: topic.id,
        userId: { notIn: replyTo === null ? [writer.userId] : [writer.userId, replyTo] },
      },
      select: { userId: true },
    });

    await this.notifications.bumpForumTopic(
      tx,
      subscribers.map((row) => row.userId),
      snapshot,
      now,
    );

    return created.id;
  }

  async one(postId: string, viewer: Viewer): Promise<ForumPostView> {
    const row = await this.prisma.forumPost.findUnique({
      where: { id: postId },
      select: postFields,
    });

    if (row === null) throw postNotFound(postId);

    const [view] = await this.views([row], viewer);

    if (view === undefined) throw postNotFound(postId);

    return view;
  }

  /** Автор правит текст и фото. Скрытое модератором и удалённое не правится. */
  async update(
    postId: string,
    userId: string,
    input: UpdateForumPostInput,
    now = new Date(),
  ): Promise<ForumPostView> {
    const writer = await this.access.writer(userId, now);
    const post = await this.own(postId, writer);

    if (post.deletedAt !== null || post.hiddenAt !== null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Post cannot be edited', { postId });
    }

    assertOpen(post.topic, writer);

    await this.prisma.forumPost.update({
      where: { id: postId },
      data: {
        body: input.body,
        ...(input.images === undefined
          ? {}
          : { images: input.images.map((image) => ({ ...image })) }),
        editedAt: now,
      },
    });

    return this.one(postId, writer);
  }

  /**
   * Удаление своего. Единственное сообщение темы уходит вместе с темой;
   * иначе остаётся заглушка «удалено автором» на своём номере, текст и фото
   * стираются.
   */
  async remove(postId: string, userId: string, now = new Date()): Promise<void> {
    const viewer = await this.access.viewer(userId);
    const post = await this.own(postId, viewer);

    if (post.deletedAt !== null) return;

    await this.prisma.$transaction(async (tx) => {
      const others = await tx.forumPost.count({
        where: { topicId: post.topicId, id: { not: postId } },
      });

      if (others === 0) {
        await tx.forumTopic.delete({ where: { id: post.topicId } });

        return;
      }

      await tx.forumPost.update({
        where: { id: postId },
        data: { deletedAt: now, body: '', images: [], quoteText: null, quotePostId: null },
      });
    });
  }

  // ---------------------------------------------------------------- «нравится», жалобы

  async like(postId: string, userId: string, liked: boolean): Promise<ForumLikeView> {
    const writer = await this.access.writer(userId);
    const post = await this.prisma.forumPost.findUnique({
      where: { id: postId },
      select: {
        authorId: true,
        deletedAt: true,
        hiddenAt: true,
        topic: { select: topicStateFields },
      },
    });

    if (post === null || !canSeeTopic(post.topic, writer)) throw postNotFound(postId);

    if (post.authorId === userId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot like own post', { postId });
    }

    if (liked && (post.deletedAt !== null || post.hiddenAt !== null)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Post is not available', { postId });
    }

    const likes = await this.prisma.$transaction(async (tx) => {
      const changed = liked
        ? (await tx.forumLike.createMany({ data: [{ postId, userId }], skipDuplicates: true }))
            .count
        : (await tx.forumLike.deleteMany({ where: { postId, userId } })).count;
      const row = await tx.forumPost.update({
        where: { id: postId },
        data: changed === 0 ? {} : { likesCount: { increment: liked ? 1 : -1 } },
        select: { likesCount: true },
      });

      return row.likesCount;
    });

    return { likes, liked };
  }

  /** Жалоба. Повторная от того же человека ничего не меняет. */
  async report(
    postId: string,
    userId: string,
    input: CreateForumReportInput,
    now = new Date(),
  ): Promise<void> {
    const viewer = await this.access.viewer(userId);
    const post = await this.prisma.forumPost.findUnique({
      where: { id: postId },
      select: { authorId: true, deletedAt: true, topic: { select: topicStateFields } },
    });

    if (post === null || !canSeeTopic(post.topic, viewer) || post.deletedAt !== null) {
      throw postNotFound(postId);
    }

    if (post.authorId === userId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot report own post', { postId });
    }

    const existing = await this.prisma.forumReport.findUnique({
      where: { postId_reporterId: { postId, reporterId: userId } },
      select: { id: true },
    });

    if (existing !== null) return;

    await this.access.assertLimit({ userId, isAdmin: viewer.isAdmin, name: '' }, 'REPORTS', now);
    await this.prisma.forumReport.createMany({
      data: [
        {
          postId,
          reporterId: userId,
          reason: input.reason,
          comment: input.comment ?? null,
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async own(postId: string, viewer: Viewer) {
    const post = await this.prisma.forumPost.findUnique({
      where: { id: postId },
      select: {
        id: true,
        topicId: true,
        authorId: true,
        deletedAt: true,
        hiddenAt: true,
        topic: { select: topicStateFields },
      },
    });

    if (post === null || !canSeeTopic(post.topic, viewer)) throw postNotFound(postId);

    if (post.authorId !== viewer.userId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the author can change a post', { postId });
    }

    return post;
  }
}

export function canSeeTopic(
  topic: Pick<TopicState, 'authorId' | 'hiddenAt'>,
  viewer: Viewer,
): boolean {
  return topic.hiddenAt === null || viewer.isAdmin || topic.authorId === viewer.userId;
}

/** В закрытую и скрытую тему пишет только администратор. */
export function assertOpen(
  topic: Pick<TopicState, 'id' | 'lockedAt' | 'hiddenAt'>,
  writer: Writer | Viewer,
): void {
  if (writer.isAdmin) return;

  if (topic.lockedAt !== null || topic.hiddenAt !== null) {
    throw new AppError(ERROR_CODES.FORUM_TOPIC_LOCKED, 'Topic is locked', { topicId: topic.id });
  }
}

export function topicNotFound(topicId: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Forum topic not found', { id: topicId });
}

function postNotFound(postId: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Forum post not found', { id: postId });
}
