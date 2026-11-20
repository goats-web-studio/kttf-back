import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { FEED_PORTAL_SECTION, type ForumTopicTranslationInput } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import type { Writer } from './forum-access.service.js';

/**
 * Версии новости KTTF при создании темы и правке её первого сообщения —
 * ADR-099. Общие проверки и запись набора: их зовут и `ForumTopicsService`,
 * и `ForumPostsService`, поэтому — отдельно от `ForumTranslationsService`,
 * который сам зависит от тем.
 */

/**
 * Можно ли этому человеку вести версии этой темы: только модератору и только
 * у новостей KTTF. Не модератор — `FORBIDDEN`, не новость — `VALIDATION_FAILED`.
 */
export function assertCanTranslate(writer: Writer, sectionSlug: string, field: string): void {
  if (!writer.isAdmin) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Only moderators translate KTTF news', { field });
  }

  if (sectionSlug !== FEED_PORTAL_SECTION) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Only KTTF news have language versions', {
      field,
    });
  }
}

/**
 * Набор версий: каждый язык — один раз и не язык оригинала. Контракт
 * проверяет то же, но язык оригинала у правки знает только сервер.
 */
export function assertVersions(
  original: string,
  rows: readonly ForumTopicTranslationInput[],
): void {
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.locale === original) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A version in the original language', {
        field: 'translations',
        locale: row.locale,
      });
    }

    if (seen.has(row.locale)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Each language once', {
        field: 'translations',
        locale: row.locale,
      });
    }

    seen.add(row.locale);
  }
}

/**
 * Заменить набор версий темы: каких языков нет — убрать, остальные создать
 * или переписать на месте, в порядке набора. Внутри транзакции вызывающего.
 */
export async function replaceTranslations(
  tx: Prisma.TransactionClient,
  topicId: string,
  rows: readonly ForumTopicTranslationInput[],
  userId: string,
  now: Date,
): Promise<void> {
  await tx.forumTopicTranslation.deleteMany({
    where: { topicId, locale: { notIn: rows.map((row) => row.locale) } },
  });

  for (const [position, row] of rows.entries()) {
    const data = {
      title: row.title,
      body: row.body,
      images: (row.images ?? []).map((image) => ({ ...image })),
      position,
      updatedById: userId,
    };

    await tx.forumTopicTranslation.upsert({
      where: { topicId_locale: { topicId, locale: row.locale } },
      create: { topicId, locale: row.locale, ...data, createdAt: now },
      update: data,
    });
  }
}
