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
  ANONYMOUS,
  type TopicRecord,
  type Viewer,
} from './forum-views.js';

/** Повтор просмотра того же человека раньше — не считается. */
const VIEW_REPEAT_MS = 30 * 60 * 1000;
/** Сколько последних просмотров помнит процесс. */
const VIEW_MEMORY = 50_000;

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

  /** Последние просмотры: `читатель:тема` → когда. */
  private readonly views = new Map<string, number>();

  // ---------------------------------------------------------------- разделы

  /** Разделы по порядку со счётчиками и последней активностью. Архивные — администратору. */
  async sections(withArchived = false): Promise<ForumSectionView[]> {
    const sections = await this.prisma.forumSection.findMany({
      where: withArchived ? {} : { archivedAt: null },
      orderBy: [{ position: 'asc' }, { title: 'asc' }],
    });
    const visible = { hiddenAt: null, archivedAt: null } satisfies Prisma.ForumTopicWhereInput;
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
        subjectTypes: section.subjectTypes,
        manualTopics: section.manualTopics,
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

  async list(
    query: ListForumTopicsQuery,
    viewer: Viewer = ANONYMOUS,
  ): Promise<Page<ForumTopicItem>> {
    const where: Prisma.ForumTopicWhereInput = {
      hiddenAt: null,
      // Архив автора в списках не показывается (ADR-075).
      archivedAt: null,
      section: {
        archivedAt: null,
        ...(query.section === undefined ? {} : { slug: query.section }),
      },
      // Поиск — по заголовку и по тексту сообщений (ADR-067 §9).
      ...(query.q === undefined
        ? {}
        : {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              {
                posts: {
                  some: {
                    body: { contains: query.q, mode: 'insensitive' },
                    deletedAt: null,
                    hiddenAt: null,
                  },
                },
              },
            ],
          }),
      ...(query.subjectType === undefined ? {} : { subjectType: query.subjectType }),
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

    return pageOf(await this.items(rows, viewer), total, query);
  }

  async get(topicId: string, viewer: Viewer, now = new Date()): Promise<ForumTopicView> {
    const row = await this.prisma.forumTopic.findUnique({
      where: { id: topicId },
      select: topicFields,
    });

    if (row === null || !canSeeTopic(row, viewer)) throw topicNotFound(topicId);

    if (viewer.userId !== undefined) {
      // Открыл тему — уведомления о ней прочитаны, и «новых» в ней больше нет.
      await Promise.all([
        this.notifications.settleForumTopic(viewer.userId, topicId, now),
        this.prisma.forumTopicRead.upsert({
          where: { userId_topicId: { userId: viewer.userId, topicId } },
          create: { userId: viewer.userId, topicId, lastNumber: row.postsCount, readAt: now },
          update: { lastNumber: row.postsCount, readAt: now },
        }),
      ]);
    }

    return this.view(row, viewer, now);
  }

  /**
   * Просмотр темы (ADR-067 §1). Повтор того же человека — или того же
   * адреса у гостя — за `VIEW_REPEAT_MS` не считается. Память процесса:
   * при нескольких экземплярах API счёт приблизительный, как и задумано.
   */
  async countView(topicId: string, viewerKey: string, now = Date.now()): Promise<boolean> {
    const key = `${viewerKey}:${topicId}`;
    const seen = this.views.get(key);

    if (seen !== undefined && now - seen < VIEW_REPEAT_MS) return false;

    if (this.views.size > VIEW_MEMORY) {
      for (const [stale, at] of this.views) {
        if (now - at >= VIEW_REPEAT_MS) this.views.delete(stale);
      }
      if (this.views.size > VIEW_MEMORY) this.views.clear();
    }

    this.views.set(key, now);
    await this.prisma.forumTopic.updateMany({
      where: { id: topicId },
      data: { viewsCount: { increment: 1 } },
    });

    return true;
  }

  async create(
    userId: string,
    input: CreateForumTopicInput,
    now = new Date(),
  ): Promise<ForumTopicView> {
    const writer = await this.access.writer(userId, now);
    const section = await this.prisma.forumSection.findUnique({
      where: { id: input.sectionId },
      select: { id: true, archivedAt: true, manualTopics: true },
    });

    // В «Новостях клубов и тренеров» тема — сама новость: руками не заводится.
    if (section?.archivedAt !== null || (!section.manualTopics && !writer.isAdmin)) {
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
        select: { id: true, title: true, subjectType: true, subjectId: true },
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

  /**
   * Архив — ADR-075. Автор убирает свою запись с глаз: со стены, из ленты и
   * из списков форума; по ссылке она открывается, вернуть — тем же путём.
   * Только своя и только без предмета: тему турнира или новости клуба в
   * архив не убрать.
   */
  async archive(
    topicId: string,
    userId: string,
    archived: boolean,
    now = new Date(),
  ): Promise<void> {
    const writer = await this.access.writer(userId, now);
    const topic = await this.posts.visibleTopic(topicId, writer);

    if (topic.authorId !== userId || topic.subjectType !== null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the author can archive a topic', { topicId });
    }

    await this.prisma.forumTopic.update({
      where: { id: topicId },
      data: { archivedAt: archived ? now : null },
    });
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
      this.prisma.forumSection.findFirst({
        where: { subjectTypes: { has: type } },
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
      this.posts.last(row, viewer, FORUM_SUBJECT_LAST_POSTS),
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

    // Тему новости заводит сама публикация записи (ForumNewsService), не первый ответ.
    if (type === 'CLUB_POST' || type === 'COACH_POST') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum subject not found', { type, id: subjectId });
    }

    const section = await this.prisma.forumSection.findFirst({
      where: { subjectTypes: { has: type } },
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
          select: { id: true, title: true, subjectType: true, subjectId: true },
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

  async items(rows: readonly TopicRecord[], viewer: Viewer = ANONYMOUS): Promise<ForumTopicItem[]> {
    const [subjects, reads] = await Promise.all([
      this.subjects.describe(rows),
      viewer.userId === undefined || rows.length === 0
        ? null
        : this.prisma.forumTopicRead.findMany({
            where: { userId: viewer.userId, topicId: { in: rows.map((row) => row.id) } },
            select: { topicId: true, lastNumber: true },
          }),
    ]);
    const marks =
      reads === null ? null : new Map(reads.map((read) => [read.topicId, read.lastNumber]));

    return rows.map((row) => toTopicItem(row, subjects, marks));
  }

  private async view(row: TopicRecord, viewer: Viewer, now: Date): Promise<ForumTopicView> {
    const [[item], subscription, me, firstPost] = await Promise.all([
      this.items([row], viewer),
      viewer.userId === undefined
        ? null
        : this.prisma.forumSubscription.findUnique({
            where: { topicId_userId: { topicId: row.id, userId: viewer.userId } },
            select: { userId: true },
          }),
      viewer.userId === undefined ? null : this.access.me(viewer.userId, now),
      this.posts.first(row, viewer),
    ]);

    if (item === undefined) throw topicNotFound(row.id);

    const open = viewer.isAdmin || (row.lockedAt === null && row.hiddenAt === null);

    return {
      ...item,
      firstPost,
      subscribed: subscription !== null,
      canReply: me?.canPost === true && open,
      canRename:
        me?.canPost === true &&
        open &&
        (viewer.isAdmin || (row.authorId === viewer.userId && row.subjectType === null)),
    };
  }
}
