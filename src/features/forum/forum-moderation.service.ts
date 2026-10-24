import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type ForumMuteInput,
  type ForumMuteView,
  type ForumReportView,
  type ForumSectionInput,
  type ForumSectionView,
  type ForumSubjectType,
  type ForumWarningInput,
  type HideForumPostInput,
  type ListForumReportsQuery,
  type ModerateForumTopicInput,
  type Page,
  type PageQuery,
  type UpdateForumSectionInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ForumTopicsService } from './forum-topics.service.js';
import { authorFields, authorName, nameFields, toAuthor } from './forum-views.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const reportFields = {
  id: true,
  reason: true,
  comment: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
  reporter: { select: nameFields },
  post: {
    select: {
      id: true,
      number: true,
      body: true,
      hiddenAt: true,
      hiddenReason: true,
      deletedAt: true,
      topic: { select: { id: true, title: true } },
      author: { select: authorFields },
    },
  },
} satisfies Prisma.ForumReportSelect;

/**
 * Модерация форума — ADR-064 §5. Только администратор. Скрытие не удаляет:
 * сообщение остаётся заглушкой с причиной, автор получает уведомление.
 * Каждое действие — строкой в журнале (`AuditLog`).
 */
@Injectable()
export class ForumModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly topics: ForumTopicsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- жалобы

  async reports(query: ListForumReportsQuery): Promise<Page<ForumReportView>> {
    const where = { status: query.status } satisfies Prisma.ForumReportWhereInput;
    const [rows, total] = await Promise.all([
      this.prisma.forumReport.findMany({
        where,
        select: reportFields,
        // Открытые — старые первыми, как очередь; разобранные — свежие первыми.
        orderBy: { createdAt: query.status === 'OPEN' ? 'asc' : 'desc' },
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.forumReport.count({ where }),
    ]);

    return pageOf(
      rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        comment: row.comment,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        reporterName: authorName(row.reporter) ?? '',
        post: {
          id: row.post.id,
          number: row.post.number,
          topic: row.post.topic,
          author: toAuthor(row.post.author),
          body: row.post.body,
          hidden: row.post.hiddenAt !== null,
          hiddenReason: row.post.hiddenReason,
          deleted: row.post.deletedAt !== null,
        },
      })),
      total,
      query,
    );
  }

  /** Отклонить жалобу: сообщение в порядке. */
  async rejectReport(reportId: string, adminId: string, now = new Date()): Promise<void> {
    const updated = await this.prisma.forumReport.updateMany({
      where: { id: reportId, status: 'OPEN' },
      data: { status: 'REJECTED', resolvedAt: now, resolvedById: adminId },
    });

    if (updated.count === 0) {
      const exists = await this.prisma.forumReport.findUnique({
        where: { id: reportId },
        select: { id: true },
      });

      if (exists === null) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum report not found', { id: reportId });
      }
    }
  }

  // ---------------------------------------------------------------- сообщения и темы

  /**
   * Скрыть или вернуть сообщение. Скрытие принимает открытые жалобы на него
   * и уведомляет автора с причиной.
   */
  async hidePost(
    postId: string,
    adminId: string,
    input: HideForumPostInput,
    now = new Date(),
  ): Promise<void> {
    const post = await this.prisma.forumPost.findUnique({
      where: { id: postId },
      select: {
        id: true,
        number: true,
        authorId: true,
        hiddenAt: true,
        hiddenReason: true,
        topic: { select: { id: true, title: true } },
      },
    });

    if (post === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum post not found', { id: postId });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.forumPost.update({
        where: { id: postId },
        data: input.hidden
          ? { hiddenAt: post.hiddenAt ?? now, hiddenReason: input.reason ?? null }
          : { hiddenAt: null, hiddenReason: null },
      });

      if (input.hidden) {
        await tx.forumReport.updateMany({
          where: { postId, status: 'OPEN' },
          data: { status: 'ACCEPTED', resolvedAt: now, resolvedById: adminId },
        });

        if (post.authorId !== null && post.authorId !== adminId) {
          await this.notifications.create(tx, [post.authorId], 'FORUM_POST_HIDDEN', {
            topicId: post.topic.id,
            topicTitle: post.topic.title,
            postId: post.id,
            number: post.number,
            reason: input.reason ?? '',
          });
        }
      }

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: input.hidden ? 'forum.post.hide' : 'forum.post.unhide',
          entityType: 'ForumPost',
          entityId: postId,
          before: { hidden: post.hiddenAt !== null, reason: post.hiddenReason },
          after: { hidden: input.hidden, reason: input.reason ?? null },
        },
      });
    });
  }

  async moderateTopic(
    topicId: string,
    adminId: string,
    input: ModerateForumTopicInput,
    now = new Date(),
  ): Promise<void> {
    const topic = await this.prisma.forumTopic.findUnique({
      where: { id: topicId },
      select: {
        id: true,
        title: true,
        authorId: true,
        sectionId: true,
        pinnedAt: true,
        lockedAt: true,
        hiddenAt: true,
        hiddenReason: true,
      },
    });

    if (topic === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum topic not found', { id: topicId });
    }

    if (input.sectionId !== undefined) {
      const section = await this.prisma.forumSection.findUnique({
        where: { id: input.sectionId },
        select: { id: true },
      });

      if (section === null) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Section not found', {
          field: 'sectionId',
        });
      }
    }

    const hiding = input.hidden === true && topic.hiddenAt === null;

    await this.prisma.$transaction(async (tx) => {
      await tx.forumTopic.update({
        where: { id: topicId },
        data: {
          ...(input.pinned === undefined
            ? {}
            : { pinnedAt: input.pinned ? (topic.pinnedAt ?? now) : null }),
          ...(input.locked === undefined
            ? {}
            : { lockedAt: input.locked ? (topic.lockedAt ?? now) : null }),
          ...(input.sectionId === undefined ? {} : { sectionId: input.sectionId }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.hidden === undefined
            ? {}
            : input.hidden
              ? { hiddenAt: topic.hiddenAt ?? now, hiddenReason: input.reason ?? null }
              : { hiddenAt: null, hiddenReason: null }),
        },
      });

      if (hiding && topic.authorId !== null && topic.authorId !== adminId) {
        await this.notifications.create(tx, [topic.authorId], 'FORUM_POST_HIDDEN', {
          topicId: topic.id,
          topicTitle: input.title ?? topic.title,
          postId: null,
          number: null,
          reason: input.reason ?? '',
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'forum.topic.moderate',
          entityType: 'ForumTopic',
          entityId: topicId,
          before: {
            pinned: topic.pinnedAt !== null,
            locked: topic.lockedAt !== null,
            sectionId: topic.sectionId,
            title: topic.title,
            hidden: topic.hiddenAt !== null,
          },
          after: { ...input },
        },
      });
    });
  }

  // ---------------------------------------------------------------- запреты

  async mutes(query: PageQuery, now = new Date()): Promise<Page<ForumMuteView>> {
    const where = { until: { gt: now } } satisfies Prisma.ForumMuteWhereInput;
    const [rows, total] = await Promise.all([
      this.prisma.forumMute.findMany({
        where,
        select: { until: true, reason: true, createdAt: true, user: { select: authorFields } },
        orderBy: { until: 'asc' },
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.forumMute.count({ where }),
    ]);

    return pageOf(
      rows.flatMap((row) => {
        const user = toAuthor(row.user);

        return user === null
          ? []
          : [
              {
                user,
                until: row.until.toISOString(),
                reason: row.reason,
                createdAt: row.createdAt.toISOString(),
              },
            ];
      }),
      total,
      query,
    );
  }

  async mute(
    userId: string,
    adminId: string,
    input: ForumMuteInput,
    now = new Date(),
  ): Promise<void> {
    if (userId === adminId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot mute yourself');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

    if (user === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found', { id: userId });
    }

    const until = new Date(now.getTime() + input.days * DAY_MS);

    await this.prisma.$transaction([
      this.prisma.forumMute.upsert({
        where: { userId },
        create: { userId, until, reason: input.reason, createdById: adminId, createdAt: now },
        update: { until, reason: input.reason, createdById: adminId, createdAt: now },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: adminId,
          action: 'forum.user.mute',
          entityType: 'User',
          entityId: userId,
          after: { until: until.toISOString(), reason: input.reason },
        },
      }),
    ]);
  }

  async unmute(userId: string, adminId: string): Promise<void> {
    const removed = await this.prisma.forumMute.deleteMany({ where: { userId } });

    if (removed.count > 0) {
      await this.prisma.auditLog.create({
        data: {
          actorId: adminId,
          action: 'forum.user.unmute',
          entityType: 'User',
          entityId: userId,
        },
      });
    }
  }

  // ---------------------------------------------------------------- разделы

  async sections(): Promise<ForumSectionView[]> {
    return this.topics.sections(true);
  }

  async createSection(input: ForumSectionInput): Promise<ForumSectionView> {
    await this.assertTypesFree(input.subjectTypes ?? [], null);

    const created = await this.uniqueSection(() =>
      this.prisma.forumSection.create({
        data: {
          slug: input.slug,
          title: input.title,
          description: input.description ?? null,
          position: input.position ?? 0,
          subjectTypes: [...new Set(input.subjectTypes ?? [])],
          manualTopics: input.manualTopics ?? true,
        },
        select: { id: true },
      }),
    );

    return this.section(created.id);
  }

  async updateSection(
    sectionId: string,
    input: UpdateForumSectionInput,
    now = new Date(),
  ): Promise<ForumSectionView> {
    const { archived, subjectTypes, ...fields } = input;

    if (subjectTypes !== undefined) await this.assertTypesFree(subjectTypes, sectionId);

    await this.uniqueSection(async () => {
      const updated = await this.prisma.forumSection.updateMany({
        where: { id: sectionId },
        data: {
          ...defined(fields),
          ...(subjectTypes === undefined ? {} : { subjectTypes: [...new Set(subjectTypes)] }),
          ...(archived === undefined ? {} : { archivedAt: archived ? now : null }),
        },
      });

      if (updated.count === 0) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum section not found', { id: sectionId });
      }
    });

    return this.section(sectionId);
  }

  /** Тип предмета — в одном разделе: иначе непонятно, куда заводить тему (ADR-067). */
  private async assertTypesFree(
    types: readonly ForumSubjectType[],
    exceptSectionId: string | null,
  ): Promise<void> {
    if (types.length === 0) return;

    const taken = await this.prisma.forumSection.findFirst({
      where: {
        subjectTypes: { hasSome: [...types] },
        ...(exceptSectionId === null ? {} : { id: { not: exceptSectionId } }),
      },
      select: { slug: true },
    });

    if (taken !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Subject type is used by another section', {
        field: 'subjectTypes',
        section: taken.slug,
      });
    }
  }

  // ---------------------------------------------------------------- предупреждения

  /**
   * Предупреждение без скрытия (ADR-067 §8): пункт правил и, если есть,
   * сообщение — уведомлением нарушителю и строкой в журнале.
   */
  async warn(adminId: string, input: ForumWarningInput): Promise<void> {
    if (input.userId === adminId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot warn yourself');
    }

    const [user, post] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
      input.postId === undefined
        ? null
        : this.prisma.forumPost.findUnique({
            where: { id: input.postId },
            select: { id: true, number: true, topic: { select: { id: true, title: true } } },
          }),
    ]);

    if (user === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found', { id: input.userId });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.notifications.create(tx, [input.userId], 'FORUM_WARNING', {
        rule: input.rule,
        comment: input.comment ?? null,
        topicId: post?.topic.id ?? null,
        topicTitle: post?.topic.title ?? null,
        postId: post?.id ?? null,
        number: post?.number ?? null,
      });
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'forum.user.warn',
          entityType: 'User',
          entityId: input.userId,
          after: { rule: input.rule, comment: input.comment ?? null, postId: post?.id ?? null },
        },
      });
    });
  }

  private async section(sectionId: string): Promise<ForumSectionView> {
    const all = await this.topics.sections(true);
    const found = all.find((section) => section.id === sectionId);

    if (found === undefined) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Forum section not found', { id: sectionId });
    }

    return found;
  }

  /** Занятый адрес или тип предмета — отказ по полю, а не 500. */
  private async uniqueSection<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Section already exists', {
          field: 'slug',
        });
      }

      throw error;
    }
  }
}
