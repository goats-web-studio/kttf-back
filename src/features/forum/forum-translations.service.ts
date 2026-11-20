import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  FEED_PORTAL_SECTION,
  type ForumTopicView,
  type ForumTranslationInput,
  type SiteLocale,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ForumAccessService, type Writer } from './forum-access.service.js';
import { canSeeTopic, topicNotFound } from './forum-posts.service.js';
import { ForumTopicsService } from './forum-topics.service.js';

/**
 * Версии новости KTTF на языках сайта — ADR-098 §8. Оригинал — сама тема и
 * её первое сообщение, язык — `ForumTopic.locale`; версии — отдельные
 * строки. Ведёт модератор (администратор платформы); только у тем раздела
 * «Новости KTTF».
 */
@Injectable()
export class ForumTranslationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ForumAccessService,
    private readonly topics: ForumTopicsService,
  ) {}

  /** Создать или заменить версию на языке. */
  async put(
    topicId: string,
    locale: SiteLocale,
    userId: string,
    input: ForumTranslationInput,
    now = new Date(),
  ): Promise<ForumTopicView> {
    const { writer, topic } = await this.news(topicId, userId, now);

    if (topic.locale === locale) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'This is the original language', {
        field: 'locale',
      });
    }

    // Без обложки — `null` в колонке: версия показывает фото оригинала.
    const data = {
      title: input.title,
      body: input.body,
      image: input.image === undefined || input.image === null ? Prisma.DbNull : { ...input.image },
      updatedById: userId,
    };

    await this.prisma.forumTopicTranslation.upsert({
      where: { topicId_locale: { topicId, locale } },
      create: { topicId, locale, ...data, createdAt: now },
      update: data,
    });

    return this.topics.get(topicId, writer, now);
  }

  /** Убрать версию. Её нет — ничего не меняется. */
  async remove(topicId: string, locale: SiteLocale, userId: string, now = new Date()) {
    await this.news(topicId, userId, now);
    await this.prisma.forumTopicTranslation.deleteMany({ where: { topicId, locale } });
  }

  /** Язык оригинала. Совпадает с языком версии — сначала убрать версию. */
  async setLocale(
    topicId: string,
    locale: SiteLocale,
    userId: string,
    now = new Date(),
  ): Promise<ForumTopicView> {
    const { writer } = await this.news(topicId, userId, now);
    const clash = await this.prisma.forumTopicTranslation.findUnique({
      where: { topicId_locale: { topicId, locale } },
      select: { locale: true },
    });

    if (clash !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A version in this language exists', {
        field: 'locale',
      });
    }

    await this.prisma.forumTopic.update({ where: { id: topicId }, data: { locale } });

    return this.topics.get(topicId, writer, now);
  }

  /** Тема-новость KTTF, которую этот человек вправе переводить. */
  private async news(
    topicId: string,
    userId: string,
    now: Date,
  ): Promise<{ writer: Writer; topic: { locale: string | null } }> {
    const writer = await this.access.writer(userId, now);

    if (!writer.isAdmin) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only moderators translate KTTF news', {
        topicId,
      });
    }

    const topic = await this.prisma.forumTopic.findUnique({
      where: { id: topicId },
      select: {
        authorId: true,
        hiddenAt: true,
        locale: true,
        section: { select: { slug: true } },
      },
    });

    if (topic === null || !canSeeTopic(topic, writer)) throw topicNotFound(topicId);

    if (topic.section.slug !== FEED_PORTAL_SECTION) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Only KTTF news have language versions', {
        field: 'topicId',
      });
    }

    return { writer, topic };
  }
}
