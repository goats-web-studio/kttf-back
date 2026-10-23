import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  FORUM_POSTS_PER_HOUR,
  FORUM_REPORTS_PER_DAY,
  FORUM_TOPICS_PER_DAY,
  type ForumMe,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ANONYMOUS, authorName, type Viewer } from './forum-views.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Тот, кто пишет: прошёл проверки, имя — для снимков в уведомлениях. */
export interface Writer {
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly name: string;
}

export type ForumLimitKind = 'TOPICS' | 'POSTS' | 'REPORTS';

/**
 * Кто и что может на форуме — ADR-064 §2, §5. Писать — вошедший с профилем
 * игрока и без запрета. Лимиты считаются по базе, а не в памяти процесса:
 * при двух экземплярах API счётчик в памяти делился бы на два (ADR-056).
 * Администратора лимиты не касаются.
 */
@Injectable()
export class ForumAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async viewer(userId: string | undefined): Promise<Viewer> {
    if (userId === undefined) return ANONYMOUS;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });

    return { userId, isAdmin: user?.isAdmin === true };
  }

  async me(userId: string, now = new Date()): Promise<ForumMe> {
    const user = await this.load(userId);
    const mute = activeMute(user.forumMute, now);

    return {
      canPost: user.player !== null && mute === null,
      profileRequired: user.player === null,
      mute: mute === null ? null : { until: mute.until.toISOString(), reason: mute.reason },
      moderator: user.isAdmin,
    };
  }

  /** Может ли писать: профиль есть, запрета нет. */
  async writer(userId: string, now = new Date()): Promise<Writer> {
    const user = await this.load(userId);

    if (user.player === null) {
      throw new AppError(ERROR_CODES.FORUM_PROFILE_REQUIRED, 'Forum requires a player profile');
    }

    const mute = activeMute(user.forumMute, now);

    if (mute !== null) {
      throw new AppError(ERROR_CODES.FORUM_MUTED, 'User is muted on the forum', {
        until: mute.until.toISOString(),
        reason: mute.reason,
      });
    }

    return { userId, isAdmin: user.isAdmin, name: authorName(user) ?? '' };
  }

  /** Лимит на темы, сообщения или жалобы за окно. */
  async assertLimit(writer: Writer, kind: ForumLimitKind, now = new Date()): Promise<void> {
    if (writer.isAdmin) return;

    const { limit, count } = await this.usage(writer.userId, kind, now);

    if (count >= limit) {
      throw new AppError(ERROR_CODES.FORUM_LIMIT, 'Forum limit reached', { kind, limit });
    }
  }

  private async usage(
    userId: string,
    kind: ForumLimitKind,
    now: Date,
  ): Promise<{ limit: number; count: number }> {
    switch (kind) {
      case 'TOPICS':
        return {
          limit: FORUM_TOPICS_PER_DAY,
          // Тема предмета заводится первым ответом на его странице — это ответ, а не тема.
          count: await this.prisma.forumTopic.count({
            where: {
              authorId: userId,
              subjectType: null,
              createdAt: { gte: new Date(now.getTime() - DAY_MS) },
            },
          }),
        };
      case 'POSTS':
        return {
          limit: FORUM_POSTS_PER_HOUR,
          count: await this.prisma.forumPost.count({
            where: { authorId: userId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
          }),
        };
      case 'REPORTS':
        return {
          limit: FORUM_REPORTS_PER_DAY,
          count: await this.prisma.forumReport.count({
            where: { reporterId: userId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
          }),
        };
    }
  }

  private async load(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isAdmin: true,
        player: { select: { lastName: true, firstName: true } },
        forumMute: { select: { until: true, reason: true } },
      },
    });

    if (user === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User not found');
    }

    return user;
  }
}

function activeMute<T extends { until: Date }>(mute: T | null, now: Date): T | null {
  return mute !== null && mute.until > now ? mute : null;
}
