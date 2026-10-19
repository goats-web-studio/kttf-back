import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { ClubContentItem, HideClubContentInput, Page, PageQuery } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf } from '../../common/pagination.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Сколько знаков текста записи видно в ленте модерации. */
const EXCERPT = 240;

/**
 * Модерация контента клубов — ADR-055, решение 8: постмодерация.
 *
 * Лента свежего всех клубов, записи и медиа вместе, новые сверху. Скрытое
 * остаётся в ленте с отметкой: администратор видит, что уже разобрано, и
 * может вернуть скрытое по ошибке.
 */
@Injectable()
export class ClubContentAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async feed(query: PageQuery): Promise<Page<ClubContentItem>> {
    // Две таблицы одной лентой: с каждой берётся столько, сколько может
    // понадобиться до конца страницы, затем они сливаются по дате. Записей
    // клубов немного — десятки в день, а не тысячи.
    const take = query.page * query.limit;
    const club = { select: { id: true, name: true } } as const;

    const [posts, media, postCount, mediaCount] = await Promise.all([
      this.prisma.clubPost.findMany({
        orderBy: { publishedAt: 'desc' },
        take,
        select: {
          id: true,
          title: true,
          body: true,
          imageUrl: true,
          publishedAt: true,
          hiddenAt: true,
          hiddenReason: true,
          club,
        },
      }),
      this.prisma.clubMedia.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          caption: true,
          imageUrl: true,
          youtubeId: true,
          createdAt: true,
          hiddenAt: true,
          hiddenReason: true,
          club,
        },
      }),
      this.prisma.clubPost.count(),
      this.prisma.clubMedia.count(),
    ]);

    const items: ClubContentItem[] = [
      ...posts.map((post) => ({
        kind: 'POST' as const,
        id: post.id,
        club: post.club,
        createdAt: post.publishedAt.toISOString(),
        title: post.title,
        excerpt: post.body.length > EXCERPT ? `${post.body.slice(0, EXCERPT)}…` : post.body,
        imageUrl: post.imageUrl,
        youtubeId: null,
        hidden: post.hiddenAt !== null,
        hiddenReason: post.hiddenReason,
      })),
      ...media.map((item) => ({
        kind: 'MEDIA' as const,
        id: item.id,
        club: item.club,
        createdAt: item.createdAt.toISOString(),
        title: item.caption,
        excerpt: null,
        imageUrl: item.imageUrl,
        youtubeId: item.youtubeId,
        hidden: item.hiddenAt !== null,
        hiddenReason: item.hiddenReason,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const start = (query.page - 1) * query.limit;

    return pageOf(items.slice(start, start + query.limit), postCount + mediaCount, query);
  }

  async hidePost(id: string, input: HideClubContentInput): Promise<void> {
    const { count } = await this.prisma.clubPost.updateMany({
      where: { id },
      data: hiddenData(input),
    });

    if (count === 0) throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found', { id });
  }

  async hideMedia(id: string, input: HideClubContentInput): Promise<void> {
    const { count } = await this.prisma.clubMedia.updateMany({
      where: { id },
      data: hiddenData(input),
    });

    if (count === 0) throw new AppError(ERROR_CODES.NOT_FOUND, 'Media not found', { id });
  }
}

function hiddenData(input: HideClubContentInput): {
  hiddenAt: Date | null;
  hiddenReason: string | null;
} {
  return input.hidden
    ? { hiddenAt: new Date(), hiddenReason: input.reason ?? null }
    : { hiddenAt: null, hiddenReason: null };
}
