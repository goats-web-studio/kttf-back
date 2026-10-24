import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  coachLimits,
  type CoachPostView,
  type CreateCoachPostInput,
  type ListCoachPostsQuery,
  type Page,
  type UpdateCoachPostInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ForumNewsService } from '../forum/forum-news.service.js';
import { dateOf } from '../club-content/content-views.js';
import { clubDate } from '../clubs/club-stats.service.js';
import { assertCoachVisible, coachPage } from './coach-page.js';
import { postFields, toPostView, type PostRecord } from './content-views.js';

/**
 * Новости и акции тренера — T2.2 (ADR-059), механика клуба один в один
 * (`ClubPostsService`, ADR-055).
 *
 * Публикуются сразу: страница тренера уже прошла проверку администратора,
 * а лишнее он скрывает после (постмодерация). Скрытую запись тренер видит
 * в кабинете с причиной, публично её нет.
 */
@Injectable()
export class CoachPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly news: ForumNewsService,
  ) {}

  /**
   * Запись на форуме — тема-новость (ADR-067 §2): после каждой правки тема
   * догоняет запись, а в ответ уходит ссылка «Обсудить (N)».
   */
  private async synced(post: PostRecord): Promise<CoachPostView> {
    await this.news.sync('COACH', post.id);

    return toPostView(post, (await this.news.discussions('COACH', [post.id])).get(post.id) ?? null);
  }

  private async withDiscussions(rows: readonly PostRecord[]): Promise<CoachPostView[]> {
    const links = await this.news.discussions(
      'COACH',
      rows.map((row) => row.id),
    );

    return rows.map((row) => toPostView(row, links.get(row.id) ?? null));
  }

  /**
   * Публичная лента: закреплённая сверху, дальше свежие. Акция после своего
   * последнего дня уходит в архив сама — по `archive` её видно.
   */
  async list(
    coachId: string,
    query: ListCoachPostsQuery,
    viewerId: string | undefined,
    now = new Date(),
  ): Promise<Page<CoachPostView>> {
    await assertCoachVisible(this.prisma, coachId, viewerId);

    const where: Prisma.CoachPostWhereInput = {
      coachId,
      hiddenAt: null,
      ...(query.archive === true
        ? {}
        : { OR: [{ kind: 'NEWS' }, { validUntil: null }, { validUntil: { gte: clubDate(now) } }] }),
    };

    return this.page(where, query);
  }

  /** Все записи тренера, со скрытыми и прошедшими, — кабинет. */
  async listForOwner(coachId: string, query: ListCoachPostsQuery): Promise<Page<CoachPostView>> {
    return this.page({ coachId }, query);
  }

  async create(
    coachId: string,
    input: CreateCoachPostInput,
    authorId: string,
    now = new Date(),
  ): Promise<CoachPostView> {
    const limits = coachLimits((await coachPage(this.prisma, coachId)).plan);

    if (limits.postsPerMonth !== null) {
      const today = clubDate(now);
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      // Начало месяца по UTC+5 — минус пять часов от полуночи UTC.
      const since = new Date(monthStart.getTime() - 5 * 60 * 60 * 1000);
      const count = await this.prisma.coachPost.count({
        where: { coachId, publishedAt: { gte: since } },
      });

      if (count >= limits.postsPerMonth) {
        throw new AppError(ERROR_CODES.COACH_PLAN_LIMIT, 'Posts per month limit reached', {
          limit: 'postsPerMonth',
          max: limits.postsPerMonth,
        });
      }
    }

    const post = await this.prisma.coachPost.create({
      data: {
        coachId,
        authorId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        imageUrl: input.imageUrl ?? null,
        validUntil:
          input.kind === 'PROMO' && input.validUntil !== undefined && input.validUntil !== null
            ? dateOf(input.validUntil)
            : null,
      },
      select: postFields,
    });

    return this.synced(post);
  }

  /**
   * Правка и закреп. Закреплённая запись у тренера одна: новая снимает
   * закреп со старой одной транзакцией. Новость срока не несёт — смена вида
   * на новость его стирает.
   */
  async update(
    coachId: string,
    postId: string,
    input: UpdateCoachPostInput,
    now = new Date(),
  ): Promise<CoachPostView> {
    const current = await this.prisma.coachPost.findFirst({
      where: { id: postId, coachId },
      select: { kind: true },
    });

    if (current === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found', { id: postId });
    }

    if (input.pinned === true) {
      const limits = coachLimits((await coachPage(this.prisma, coachId)).plan);

      if (limits.pinnedPosts === 0) {
        throw new AppError(ERROR_CODES.COACH_PLAN_LIMIT, 'Pinning is not in the plan', {
          limit: 'pinnedPosts',
          max: 0,
        });
      }
    }

    const kind = input.kind ?? current.kind;
    // Закреп — не правка текста: «изменено» ставится только за содержание.
    const content = (['kind', 'title', 'body', 'imageUrl', 'validUntil'] as const).some(
      (field) => input[field] !== undefined,
    );
    const data: Prisma.CoachPostUpdateInput = {
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl }),
      ...(kind === 'NEWS'
        ? { validUntil: null }
        : input.validUntil === undefined
          ? {}
          : { validUntil: input.validUntil === null ? null : dateOf(input.validUntil) }),
      ...(input.pinned === undefined ? {} : { pinnedAt: input.pinned ? now : null }),
      ...(content ? { editedAt: now } : {}),
    };

    const update = this.prisma.coachPost.update({
      where: { id: postId },
      data,
      select: postFields,
    });

    if (input.pinned !== true) return this.synced(await update);

    const [, post] = await this.prisma.$transaction([
      this.prisma.coachPost.updateMany({
        where: { coachId, id: { not: postId }, pinnedAt: { not: null } },
        data: { pinnedAt: null },
      }),
      update,
    ]);

    return this.synced(post);
  }

  async remove(coachId: string, postId: string): Promise<void> {
    const { count } = await this.prisma.coachPost.deleteMany({ where: { id: postId, coachId } });

    if (count === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found', { id: postId });
    }

    // Обсуждение уходит вместе с записью.
    await this.news.sync('COACH', postId);
  }

  private async page(
    where: Prisma.CoachPostWhereInput,
    query: ListCoachPostsQuery,
  ): Promise<Page<CoachPostView>> {
    const [rows, total] = await Promise.all([
      this.prisma.coachPost.findMany({
        where,
        select: postFields,
        orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.coachPost.count({ where }),
    ]);

    return pageOf(await this.withDiscussions(rows), total, query);
  }
}
