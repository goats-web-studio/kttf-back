import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  clubLimits,
  type ClubPostView,
  type CreateClubPostInput,
  type ListClubPostsQuery,
  type Page,
  type UpdateClubPostInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ForumNewsService } from '../forum/forum-news.service.js';
import { clubDate } from '../clubs/club-stats.service.js';
import { dateOf, postFields, toPostView, type PostRecord } from './content-views.js';

/**
 * Новости и акции клуба — ADR-055, `docs/09` 3.2.
 *
 * Публикуются сразу, без очереди: клубы проверены при заведении (ADR-049),
 * а администратор скрывает лишнее после (постмодерация). Скрытую запись
 * клуб видит в кабинете с причиной, публично её нет.
 */
@Injectable()
export class ClubPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly news: ForumNewsService,
  ) {}

  /**
   * Запись на форуме — тема-новость (ADR-067 §2): после каждой правки тема
   * догоняет запись, а в ответ уходит ссылка «Обсудить (N)».
   */
  private async synced(post: PostRecord): Promise<ClubPostView> {
    await this.news.sync('CLUB', post.id);

    return toPostView(post, (await this.news.discussions('CLUB', [post.id])).get(post.id) ?? null);
  }

  private async withDiscussions(rows: readonly PostRecord[]): Promise<ClubPostView[]> {
    const links = await this.news.discussions(
      'CLUB',
      rows.map((row) => row.id),
    );

    return rows.map((row) => toPostView(row, links.get(row.id) ?? null));
  }

  /**
   * Публичная лента клуба: закреплённая сверху, дальше свежие. Акция после
   * своего последнего дня уходит в архив сама — по `archive` её видно.
   */
  async list(
    clubId: string,
    query: ListClubPostsQuery,
    now = new Date(),
  ): Promise<Page<ClubPostView>> {
    const where: Prisma.ClubPostWhereInput = {
      clubId,
      hiddenAt: null,
      ...(query.archive === true
        ? {}
        : { OR: [{ kind: 'NEWS' }, { validUntil: null }, { validUntil: { gte: clubDate(now) } }] }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.clubPost.findMany({
        where,
        select: postFields,
        orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.clubPost.count({ where }),
    ]);

    return pageOf(await this.withDiscussions(rows), total, query);
  }

  /** Все записи клуба, со скрытыми и прошедшими, — кабинет. */
  async listForStaff(clubId: string, query: ListClubPostsQuery): Promise<Page<ClubPostView>> {
    const where = { clubId };
    const [rows, total] = await Promise.all([
      this.prisma.clubPost.findMany({
        where,
        select: postFields,
        orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { publishedAt: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.clubPost.count({ where }),
    ]);

    return pageOf(await this.withDiscussions(rows), total, query);
  }

  async create(
    clubId: string,
    input: CreateClubPostInput,
    authorId: string,
    now = new Date(),
  ): Promise<ClubPostView> {
    const limits = clubLimits(await this.planOf(clubId));

    if (limits.postsPerMonth !== null) {
      const today = clubDate(now);
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      // Начало месяца по UTC+5 — минус пять часов от полуночи UTC.
      const since = new Date(monthStart.getTime() - 5 * 60 * 60 * 1000);
      const count = await this.prisma.clubPost.count({
        where: { clubId, publishedAt: { gte: since } },
      });

      if (count >= limits.postsPerMonth) {
        throw new AppError(ERROR_CODES.CLUB_PLAN_LIMIT, 'Posts per month limit reached', {
          limit: 'postsPerMonth',
          max: limits.postsPerMonth,
        });
      }
    }

    const post = await this.prisma.clubPost.create({
      data: {
        clubId,
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
   * Правка и закреп. Закреплённая запись у клуба одна: новая снимает закреп
   * со старой одной транзакцией. Новость срока не несёт — смена вида на
   * новость его стирает.
   */
  async update(
    clubId: string,
    postId: string,
    input: UpdateClubPostInput,
    now = new Date(),
  ): Promise<ClubPostView> {
    const current = await this.prisma.clubPost.findFirst({
      where: { id: postId, clubId },
      select: { kind: true },
    });

    if (current === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found', { id: postId });
    }

    if (input.pinned === true) {
      const limits = clubLimits(await this.planOf(clubId));

      if (limits.pinnedPosts === 0) {
        throw new AppError(ERROR_CODES.CLUB_PLAN_LIMIT, 'Pinning is not in the plan', {
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
    const data: Prisma.ClubPostUpdateInput = {
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

    const update = this.prisma.clubPost.update({ where: { id: postId }, data, select: postFields });

    if (input.pinned !== true) return this.synced(await update);

    const [, post] = await this.prisma.$transaction([
      this.prisma.clubPost.updateMany({
        where: { clubId, id: { not: postId }, pinnedAt: { not: null } },
        data: { pinnedAt: null },
      }),
      update,
    ]);

    return this.synced(post);
  }

  async remove(clubId: string, postId: string): Promise<void> {
    const { count } = await this.prisma.clubPost.deleteMany({ where: { id: postId, clubId } });

    if (count === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found', { id: postId });
    }

    // Обсуждение уходит вместе с записью.
    await this.news.sync('CLUB', postId);
  }

  private async planOf(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { plan: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });
    }

    return club.plan;
  }
}
