import {
  NOTIFICATIONS_KEEP_DAYS,
  notificationViewSchema,
  type ListNotificationsQuery,
  type NotificationType,
  type NotificationView,
  type NotificationsUnread,
  type Page,
  type ReadNotificationsInput,
} from '@kttf/shared/types';
import { Injectable, Logger } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Снимок события по типу — ровно то, что потом отдаст `notificationViewSchema`. */
export type NotificationData = {
  [T in NotificationType]: Extract<NotificationView, { type: T }>['data'];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Типы уведомлений, которые знает этот контракт. */
const KNOWN_TYPES: readonly NotificationType[] = notificationViewSchema.options.map(
  (option) => option.shape.type.value,
);
/** Старые уведомления чистятся попутно, не чаще раза в час на процесс. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Уведомления внутри сайта — ТЗ 10, первая часть (ADR-059, T3).
 *
 * Пишутся той же транзакцией, что и событие: заявка без уведомления
 * адресату хуже, чем отказ целиком. Хранятся `NOTIFICATIONS_KEEP_DAYS` —
 * старше не показываются и удаляются попутно при чтении списка, без
 * отдельного планировщика.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private sweptAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async create<T extends NotificationType>(
    tx: Pick<Prisma.TransactionClient, 'notification'>,
    userIds: readonly string[],
    type: T,
    data: NotificationData[T],
  ): Promise<void> {
    const unique = [...new Set(userIds)];

    if (unique.length === 0) return;

    await tx.notification.createMany({
      data: unique.map((userId) => ({ userId, type, data })),
    });
  }

  /**
   * Заявка разобрана — ответ или отзыв: «новая заявка» у всех адресатов
   * становится прочитанной. Иначе у второго сотрудника клуба висит
   * уведомление о заявке, на которую уже ответил первый.
   */
  async settleTrialRequest(
    tx: Pick<Prisma.TransactionClient, 'notification'>,
    trialRequestId: string,
    now = new Date(),
  ): Promise<void> {
    await tx.notification.updateMany({
      where: {
        type: 'TRIAL_REQUEST_NEW',
        readAt: null,
        data: { path: ['trialRequestId'], equals: trialRequestId },
      },
      data: { readAt: now },
    });
  }

  /**
   * Новое сообщение в теме — подписчикам (ADR-064 §6). У кого непрочитанное
   * о ней уже есть, у того растёт счётчик и обновляется автор, а ссылка
   * остаётся на первом непрочитанном; остальным — новое уведомление.
   */
  async bumpForumTopic(
    tx: Pick<Prisma.TransactionClient, 'notification'>,
    userIds: readonly string[],
    data: Omit<NotificationData['FORUM_TOPIC_UPDATE'], 'count'>,
    now = new Date(),
  ): Promise<void> {
    const unique = [...new Set(userIds)];

    if (unique.length === 0) return;

    const pending = await tx.notification.findMany({
      where: {
        userId: { in: unique },
        type: 'FORUM_TOPIC_UPDATE',
        readAt: null,
        data: { path: ['topicId'], equals: data.topicId },
      },
      select: { id: true, userId: true, data: true },
    });
    const bumped = new Set<string>();

    for (const row of pending) {
      const previous = row.data as Partial<NotificationData['FORUM_TOPIC_UPDATE']>;

      await tx.notification.update({
        where: { id: row.id },
        data: {
          data: { ...previous, authorName: data.authorName, count: (previous.count ?? 1) + 1 },
          // Свежее событие поднимает строку наверх списка.
          createdAt: now,
        },
      });
      bumped.add(row.userId);
    }

    await this.create(
      tx,
      unique.filter((userId) => !bumped.has(userId)),
      'FORUM_TOPIC_UPDATE',
      { ...data, count: 1 },
    );
  }

  /** Человек открыл тему — уведомления о ней прочитаны. */
  async settleForumTopic(userId: string, topicId: string, now = new Date()): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        type: { in: ['FORUM_REPLY', 'FORUM_TOPIC_UPDATE'] },
        readAt: null,
        data: { path: ['topicId'], equals: topicId },
      },
      data: { readAt: now },
    });
  }

  /** Свои уведомления, новые первыми. Строка, не прошедшая контракт, пропускается. */
  async list(
    userId: string,
    query: ListNotificationsQuery,
    now = new Date(),
  ): Promise<Page<NotificationView>> {
    await this.sweep(now);

    // Только типы, которые знает эта сборка: строку типа новее неё клиент
    // базы не разберёт и уронит весь список (поэтапное обновление, общая база).
    const where = {
      userId,
      createdAt: { gte: keepFrom(now) },
      type: { in: [...KNOWN_TYPES] },
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        select: { id: true, type: true, data: true, readAt: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    const items = rows.flatMap((row) => {
      const parsed = notificationViewSchema.safeParse({
        id: row.id,
        type: row.type,
        data: row.data,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      });

      if (parsed.success) return [parsed.data];

      this.logger.warn(`Уведомление ${row.id} (${row.type}) не прошло контракт — пропущено`);

      return [];
    });

    return pageOf(items, total, query);
  }

  async unread(userId: string, now = new Date()): Promise<NotificationsUnread> {
    const unread = await this.prisma.notification.count({
      where: { userId, readAt: null, createdAt: { gte: keepFrom(now) } },
    });

    return { unread };
  }

  /** Отметить прочитанными свои: перечисленные или все. Чужие идентификаторы молча не трогаются. */
  async read(userId: string, input: ReadNotificationsInput, now = new Date()): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId,
        readAt: null,
        ...(input.ids === undefined ? {} : { id: { in: input.ids } }),
      },
      data: { readAt: now },
    });
  }

  /** Удаление старых. Сбой чистки не мешает чтению списка — следующая попытка через час. */
  private async sweep(now: Date): Promise<void> {
    if (now.getTime() - this.sweptAt < SWEEP_EVERY_MS) return;

    this.sweptAt = now.getTime();

    try {
      await this.prisma.notification.deleteMany({ where: { createdAt: { lt: keepFrom(now) } } });
    } catch (error) {
      this.logger.warn('Не удалось удалить старые уведомления', error);
    }
  }
}

function keepFrom(now: Date): Date {
  return new Date(now.getTime() - NOTIFICATIONS_KEEP_DAYS * DAY_MS);
}
