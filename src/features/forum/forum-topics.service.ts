import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  FORUM_SUBJECT_LAST_POSTS,
  type CreateForumPostInput,
  type CreateForumTopicInput,
  type ForumPostView,
  type ForumSectionView,
  type ForumSubjectThread,
  type ForumSubjectType,
  type ForumTopicItem,
  type ForumTopicView,
  type ListForumTopicsQuery,
  type Page,
  type RenameForumTopicInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ForumAccessService } from './forum-access.service.js';
import {
  assertOpen,
  canSeeTopic,
  ForumPostsService,
  topicNotFound,
} from './forum-posts.service.js';
import { ForumSubjectsService } from './forum-subjects.service.js';
import {
  authorName,
  nameFields,
  toTopicItem,
  topicFields,
  type TopicRecord,
  type Viewer,
} from './forum-views.js';

/**
 * Разделы и темы форума — ADR-064. Темы с предметом (F2) живут в разделе
 * своего типа и создаются первым сообщением со страницы предмета.
 */
@Injectable()
export class ForumTopicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ForumAccessService,
    private readonly posts: ForumPostsService,
    private readonly subjects: ForumSubjectsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- разделы

  /** Разделы по порядку со счётчиками и последней активностью. Архивные — администратору. */
  async sections(withArchived = false): Promise<ForumSectionView[]> {
    const sections = await this.prisma.forumSection.findMany({
      where: withArchived ? {} : { archivedAt: null },
      orderBy: [{ position: 'asc' }, { title: 'asc' }],
    });
    const visible = { hiddenAt: null } satisfies Prisma.ForumTopicWhereInput;
    const [counts, lasts] = await Promise.all([
      this.prisma.forumTopic.groupBy({
        by: ['sectionId'],
        where: visible,
        _count: { _all: true },
        _sum: { postsCount: true },
      }),
      Promise.all(
        sections.map((section) =>
          this.prisma.forumTopic.findFirst({
            where: { ...visible, sectionId: section.id },
            orderBy: { lastPostAt: 'desc' },
            select: {
              id: true,
              title: true,
              lastPostAt: true,
              lastPostAuthor: { select: nameFields },
            },
          }),
        ),
      ),
    ]);
    const bySection = new Map(counts.map((row) => [row.sectionId, row]));

    return sections.map((section, index) => {
      const count = bySection.get(section.id);
      const last = lasts[index] ?? null;

      return {
        id: section.id,
        slug: section.slug,
        title: section.title,
        description: section.description,
        position: section.position,
        subjectType: section.subjectType,
        archived: section.archivedAt !== null,
        topicsCount: count?._count._all ?? 0,
        postsCount: count?._sum.postsCount ?? 0,
        last:
          last === null
            ? null
            : {
                topicId: last.id,
                topicTitle: last.title,
                at: last.lastPostAt.toISOString(),
                authorName: authorName(last.lastPostAuthor),
              },
      };
    });
  }

  // ---------------------------------------------------------------- темы

  async list(query: ListForumTopicsQuery): Promise<Page<ForumTopicItem>> {
    const where: Prisma.ForumTopicWhereInput = {
      hiddenAt: null,
      section: {
        archivedAt: null,
        ...(query.section === undefined ? {} : { slug: query.section }),
      },
      ...(query.q === undefined ? {} : { title: { contains: query.q, mode: 'insensitive' } }),
      ...(query.authorPlayerId === undefined
        ? {}
        : { author: { player: { id: query.authorPlayerId } } }),
    };
    // Закреплённые сверху — только в разделе: в поиске и у игрока они обычные.
    const orderBy: Prisma.ForumTopicOrderByWithRelationInput[] =
      query.sort === 'NEW'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [
            ...(query.section === undefined
              ? []
              : [{ pinnedAt: { sort: 'desc', nulls: 'last' } } as const]),
            { lastPostAt: 'desc' },
            { id: 'desc' },
          ];
    const [rows, total] = await Promise.all([
      this.prisma.forumTopic.findMany({
        where,
        select: topicFields,
        orderBy,
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.forumTopic.count({ where }),
    ]);

    return pageOf(await this.items(rows), total, query);
  }

  async get(topicId: string, viewer: Viewer, now = new Date()): Promise<ForumTopicView> {
    const row = await this.prisma.forumTopic.findUnique({
      where: { id: topicId },
      select: topicFields,
    });

    if (row === null || !canSeeTopic(row, viewer)) throw topicNotFound(topicId);

    if (viewer.userId !== undefined) {
      // Открыл тему — уведомления о ней прочитаны.
      await this.notifications.settleForumTopic(viewer.userId, topicId, now);
    }

    return this.view(row, viewer, now);
  }

  async create(
    userId: string,
    input: CreateForumTopicInput,
    now = new Date(),
  ): Promise<ForumTopicView> {
    const writer = await this.access.writer(userId, now);
    const section = await this.prisma.forumSection.findUnique({
      where: { id: input.sectionId },
      select: { id: true, archivedAt: true },
    });

    if (section?.archivedAt !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Section is not available', {
        field: 'sectionId',
      });
    }

    await this.access.assertLimit(writer, 'TOPICS', now);
    await this.access.assertLimit(writer, 'POSTS', now);

    const topicId = await this.prisma.$transaction(async (tx) => {
      const topic = await tx.forumTopic.create({
        data: {
          sectionId: section.id,
          authorId: userId,
          title: input.title,
          createdAt: now,
          lastPostAt: now,
        },
        select: { id: true, title: true },
      });

      await this.posts.insert(
        tx,
        topic,
        writer,
        { body: input.body, images: input.images ?? [], quote: null },
        now,
      );

      return topic.id;
    });

    return this.get(topicId, writer, now);
  }

  /** Заголовок правит автор темы и администратор. */
  async rename(
    topicId: string,
    userId: string,
    input: RenameForumTopicInput,
    now = new Date(),
  ): Promise<ForumTopicView> {
    const writer = await this.access.writer(userId, now);
    const topic = await this.posts.visibleTopic(topicId, writer);

    // Заголовок темы предмета — название предмета: его меняет только администратор.
    if (!writer.isAdmin && (topic.authorId !== userId || topic.subjectType !== null)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the author can rename a topic', { topicId });
    }

    assertOpen(topic, writer);

    await this.prisma.forumTopic.update({ where: { id: topicId }, data: { title: input.title } });

    return this.get(topicId, writer, now);
  }

  async subscribe(topicId: string, userId: string, subscribed: boolean): Promise<void> {
    const viewer = await this.access.viewer(userId);

    await this.posts.visibleTopic(topicId, viewer);

    if (subscribed) {
      await this.prisma.forumSubscription.createMany({
        data: [{ topicId, userId }],
        skipDuplicates: true,
      });
    } else {
      await this.prisma.forumSubscription.deleteMany({ where: { topicId, userId } });
    }
  }

  // ---------------------------------------------------------------- тема предмета (F2)

  /** Блок «Обсуждение» на странице предмета: тема, если есть, и последние сообщения. */
  async subjectThread(
    type: ForumSubjectType,
    subjectId: string,
    viewer: Viewer,
    now = new Date(),
  ): Promise<ForumSubjectThread> {
    const subject = await this.subjects.findPublic(type, subjectId);

    if (subject === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum subject not found', { type, id: subjectId });
    }

    const [section, row] = await Promise.all([
      this.prisma.forumSection.findUnique({
        where: { subjectType: type },
        select: { id: true, slug: true, title: true },
      }),
      this.prisma.forumTopic.findUnique({
        where: { subjectType_subjectId: { subjectType: type, subjectId } },
        select: topicFields,
      }),
    ]);

    if (row === null || !canSeeTopic(row, viewer)) {
      return { section, topic: null, posts: [] };
    }

    const [topic, posts] = await Promise.all([
      this.view(row, viewer, now),
      this.posts.last(row.id, viewer, FORUM_SUBJECT_LAST_POSTS),
    ]);

    return { section, topic, posts };
  }

  /**
   * Сообщение со страницы предмета. Темы ещё нет — заводится в разделе
   * этого типа с названием предмета; две первые реплики одновременно
   * сходятся на одной теме через уникальную пару предмета.
   */
  async postToSubject(
    type: ForumSubjectType,
    subjectId: string,
    userId: string,
    input: CreateForumPostInput,
    now = new Date(),
  ): Promise<ForumPostView> {
    const writer = await this.access.writer(userId, now);
    const subject = await this.subjects.findPublic(type, subjectId);

    if (subject === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum subject not found', { type, id: subjectId });
    }

    const existing = await this.prisma.forumTopic.findUnique({
      where: { subjectType_subjectId: { subjectType: type, subjectId } },
      select: { id: true },
    });

    if (existing !== null) return this.posts.reply(existing.id, userId, input, now);

    const section = await this.prisma.forumSection.findUnique({
      where: { subjectType: type },
      select: { id: true, archivedAt: true },
    });

    if (section?.archivedAt !== null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No forum section for this subject', { type });
    }

    // Цитировать в ещё не существующей теме нечего.
    if (input.quote !== undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Quoted post is not available', {
        field: 'quote',
      });
    }

    await this.access.assertLimit(writer, 'POSTS', now);

    try {
      const postId = await this.prisma.$transaction(async (tx) => {
        const topic = await tx.forumTopic.create({
          data: {
            sectionId: section.id,
            authorId: userId,
            title: subject.name.slice(0, 150),
            subjectType: type,
            subjectId,
            createdAt: now,
            lastPostAt: now,
          },
          select: { id: true, title: true },
        });

        return this.posts.insert(
          tx,
          topic,
          writer,
          { body: input.body, images: input.images ?? [], quote: null },
          now,
        );
      });

      return await this.posts.one(postId, writer);
    } catch (error) {
      // Тему только что завёл кто-то другой — отвечаем в неё.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.forumTopic.findUnique({
          where: { subjectType_subjectId: { subjectType: type, subjectId } },
          select: { id: true },
        });

        if (raced !== null) return this.posts.reply(raced.id, userId, input, now);
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------- отображение

  async items(rows: readonly TopicRecord[]): Promise<ForumTopicItem[]> {
    const subjects = await this.subjects.describe(rows);

    return rows.map((row) => toTopicItem(row, subjects));
  }

  private async view(row: TopicRecord, viewer: Viewer, now: Date): Promise<ForumTopicView> {
    const [[item], subscription, me] = await Promise.all([
      this.items([row]),
      viewer.userId === undefined
        ? null
        : this.prisma.forumSubscription.findUnique({
            where: { topicId_userId: { topicId: row.id, userId: viewer.userId } },
            select: { userId: true },
          }),
      viewer.userId === undefined ? null : this.access.me(viewer.userId, now),
    ]);

    if (item === undefined) throw topicNotFound(row.id);

    const open = viewer.isAdmin || (row.lockedAt === null && row.hiddenAt === null);

    return {
      ...item,
      subscribed: subscription !== null,
      canReply: me?.canPost === true && open,
      canRename:
        me?.canPost === true &&
        open &&
        (viewer.isAdmin || (row.authorId === viewer.userId && row.subjectType === null)),
    };
  }
}
