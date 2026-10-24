import type { ForumDiscussionLink } from '@kttf/shared/types';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Чья запись: клуба или тренера. */
export type NewsKind = 'CLUB' | 'COACH';

const SUBJECT = { CLUB: 'CLUB_POST', COACH: 'COACH_POST' } as const;

/** Раздел «Новости клубов и тренеров» — его заводит миграция `forum_news`. */
const NEWS_SECTION = 'news';

/** Запись глазами форума: что переносится в тему. */
interface NewsRecord {
  readonly title: string;
  readonly body: string;
  readonly authorId: string | null;
  readonly publishedAt: Date;
  readonly editedAt: Date | null;
  readonly hiddenAt: Date | null;
  readonly hiddenReason: string | null;
  /** Клуб скрыт или страница тренера не опубликована — новости на форуме нет. */
  readonly ownerPublic: boolean;
}

/**
 * Новости и акции клубов и тренеров на форуме — ADR-067 §2. Запись на
 * странице — тема в «Новостях клубов и тренеров»: первое сообщение — её
 * текст, под ним обсуждают. Тема повторяет запись: правка правит тему,
 * удаление удаляет её вместе с обсуждением, скрытие администратором — скрывает
 * с той же причиной.
 *
 * `sync` вызывается после каждой правки записи и сам решает, что сделать:
 * так его нельзя вызвать «не тем» методом. Сбой форума запись не отменяет —
 * он пишется в журнал, а следующая правка записи догонит тему.
 */
@Injectable()
export class ForumNewsService {
  private readonly logger = new Logger(ForumNewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(kind: NewsKind, postId: string, now = new Date()): Promise<void> {
    try {
      await this.apply(kind, postId, now);
    } catch (error) {
      this.logger.warn(`Новость ${kind} ${postId} не перенесена на форум`, error);
    }
  }

  /** «Обсудить (N)» у записей на странице: тема и число ответов. */
  async discussions(
    kind: NewsKind,
    postIds: readonly string[],
  ): Promise<Map<string, ForumDiscussionLink>> {
    if (postIds.length === 0) return new Map();

    const topics = await this.prisma.forumTopic.findMany({
      where: { subjectType: SUBJECT[kind], subjectId: { in: [...postIds] }, hiddenAt: null },
      select: { id: true, subjectId: true, postsCount: true },
    });

    return new Map(
      topics.flatMap((topic) =>
        topic.subjectId === null
          ? []
          : [[topic.subjectId, { topicId: topic.id, replies: Math.max(0, topic.postsCount - 1) }]],
      ),
    );
  }

  private async apply(kind: NewsKind, postId: string, now: Date): Promise<void> {
    const subjectType = SUBJECT[kind];
    const [post, topic] = await Promise.all([
      this.record(kind, postId),
      this.prisma.forumTopic.findUnique({
        where: { subjectType_subjectId: { subjectType, subjectId: postId } },
        select: { id: true, hiddenAt: true },
      }),
    ]);

    // Записи нет — нет и темы: обсуждение уходит вместе с новостью.
    if (post === null) {
      if (topic !== null) await this.prisma.forumTopic.delete({ where: { id: topic.id } });

      return;
    }

    if (topic === null) {
      // Скрытую запись и запись непубличного владельца на форум не выносим.
      if (post.hiddenAt !== null || !post.ownerPublic) return;

      await this.create(subjectType, postId, post);

      return;
    }

    await this.prisma.$transaction([
      this.prisma.forumTopic.update({
        where: { id: topic.id },
        data: {
          title: post.title.slice(0, 150),
          hiddenAt: post.hiddenAt === null ? null : (topic.hiddenAt ?? now),
          hiddenReason: post.hiddenAt === null ? null : post.hiddenReason,
        },
      }),
      this.prisma.forumPost.updateMany({
        where: { topicId: topic.id, number: 1 },
        data: { body: post.body, editedAt: post.editedAt },
      }),
    ]);
  }

  private async create(
    subjectType: (typeof SUBJECT)[NewsKind],
    postId: string,
    post: NewsRecord,
  ): Promise<void> {
    const section = await this.prisma.forumSection.findUnique({
      where: { slug: NEWS_SECTION },
      select: { id: true },
    });

    if (section === null) return;

    await this.prisma.forumTopic.create({
      data: {
        sectionId: section.id,
        authorId: post.authorId,
        title: post.title.slice(0, 150),
        subjectType,
        subjectId: postId,
        postsCount: 1,
        lastPostAt: post.publishedAt,
        lastPostAuthorId: post.authorId,
        createdAt: post.publishedAt,
        posts: {
          create: {
            authorId: post.authorId,
            number: 1,
            body: post.body,
            createdAt: post.publishedAt,
          },
        },
        // Автор записи следит за обсуждением, как автор любой темы.
        ...(post.authorId === null ? {} : { subscriptions: { create: { userId: post.authorId } } }),
      },
    });
  }

  private async record(kind: NewsKind, postId: string): Promise<NewsRecord | null> {
    const fields = {
      title: true,
      body: true,
      authorId: true,
      publishedAt: true,
      editedAt: true,
      hiddenAt: true,
      hiddenReason: true,
    } as const;

    if (kind === 'CLUB') {
      const row = await this.prisma.clubPost.findUnique({
        where: { id: postId },
        select: { ...fields, club: { select: { hiddenAt: true } } },
      });

      return row === null ? null : { ...row, ownerPublic: row.club.hiddenAt === null };
    }

    const row = await this.prisma.coachPost.findUnique({
      where: { id: postId },
      select: { ...fields, coach: { select: { status: true, hiddenAt: true } } },
    });

    return row === null
      ? null
      : { ...row, ownerPublic: row.coach.status === 'APPROVED' && row.coach.hiddenAt === null };
  }
}
