import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { CoachContentItem, HideCoachContentInput, Page, PageQuery } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf } from '../../common/pagination.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Сколько знаков текста записи видно в ленте модерации. */
const EXCERPT = 240;

/** Тренер в ленте: адрес страницы и имя игрока, на чьём профиле она стоит. */
const coach = {
  select: {
    id: true,
    slug: true,
    player: { select: { lastName: true, firstName: true } },
  },
} as const;

function coachRef(record: {
  id: string;
  slug: string;
  player: { lastName: string; firstName: string };
}): CoachContentItem['coach'] {
  return {
    id: record.id,
    slug: record.slug,
    name: `${record.player.lastName} ${record.player.firstName}`,
  };
}

/**
 * Модерация контента тренеров — T2.2 (ADR-059), постмодерация как у клубов
 * (`ClubContentAdminService`, ADR-055).
 *
 * Лента свежего всех тренеров, записи и медиа вместе, новые сверху.
 * Скрытое остаётся в ленте с отметкой: администратор видит, что уже
 * разобрано, и может вернуть скрытое по ошибке.
 */
@Injectable()
export class CoachContentAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async feed(query: PageQuery): Promise<Page<CoachContentItem>> {
    // Две таблицы одной лентой: с каждой берётся столько, сколько может
    // понадобиться до конца страницы, затем они сливаются по дате.
    const take = query.page * query.limit;

    const [posts, media, postCount, mediaCount] = await Promise.all([
      this.prisma.coachPost.findMany({
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
          coach,
        },
      }),
      this.prisma.coachMedia.findMany({
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
          coach,
        },
      }),
      this.prisma.coachPost.count(),
      this.prisma.coachMedia.count(),
    ]);

    const items: CoachContentItem[] = [
      ...posts.map((post) => ({
        kind: 'POST' as const,
        id: post.id,
        coach: coachRef(post.coach),
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
        coach: coachRef(item.coach),
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

  async hidePost(id: string, input: HideCoachContentInput): Promise<void> {
    const { count } = await this.prisma.coachPost.updateMany({
      where: { id },
      data: hiddenData(input),
    });

    if (count === 0) throw new AppError(ERROR_CODES.NOT_FOUND, 'Post not found', { id });
  }

  async hideMedia(id: string, input: HideCoachContentInput): Promise<void> {
    const { count } = await this.prisma.coachMedia.updateMany({
      where: { id },
      data: hiddenData(input),
    });

    if (count === 0) throw new AppError(ERROR_CODES.NOT_FOUND, 'Media not found', { id });
  }
}

function hiddenData(input: HideCoachContentInput): {
  hiddenAt: Date | null;
  hiddenReason: string | null;
} {
  return input.hidden
    ? { hiddenAt: new Date(), hiddenReason: input.reason ?? null }
    : { hiddenAt: null, hiddenReason: null };
}
