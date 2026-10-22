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

  /** Свои уведомления, новые первыми. Строка, не прошедшая контракт, пропускается. */
  async list(
    userId: string,
    query: ListNotificationsQuery,
    now = new Date(),
  ): Promise<Page<NotificationView>> {
    await this.sweep(now);

    const where = { userId, createdAt: { gte: keepFrom(now) } };
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
