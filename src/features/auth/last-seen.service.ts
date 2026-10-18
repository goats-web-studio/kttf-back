import { ONLINE_WINDOW_MS } from '@kttf/shared/types';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';

/**
 * Сколько пользователей держать в памяти, прежде чем выкинуть устаревшие
 * отметки. Каждая — пара строки и числа, так что потолок — про утечку при
 * долгой работе API, а не про объём.
 */
const MEMO_LIMIT = 10_000;

/**
 * Последнее посещение — ADR-050.
 *
 * Пишется не чаще раза в пять минут: «в сети» точнее не нужно, а UPDATE на
 * каждый запрос сделал бы из чтения сайта поток записей. Шаг держится в двух
 * местах. Память экземпляра снимает лишний запрос к базе, а условие в самом
 * UPDATE держит шаг, когда памяти нет — после перезапуска и при нескольких
 * экземплярах API.
 */
@Injectable()
export class LastSeenService {
  private readonly logger = new Logger(LastSeenService.name);
  private readonly written = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Отметить посещение. Не бросает: отметка — побочный эффект запроса, и её
   * сбой не должен ронять ответ, ради которого человек пришёл.
   */
  async touch(userId: string, now: Date = new Date()): Promise<void> {
    const last = this.written.get(userId);

    if (last !== undefined && now.getTime() - last < ONLINE_WINDOW_MS) {
      return;
    }

    this.remember(userId, now.getTime());

    try {
      await this.prisma.user.updateMany({
        where: {
          id: userId,
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lte: new Date(now.getTime() - ONLINE_WINDOW_MS) } },
          ],
        },
        data: { lastSeenAt: now },
      });
    } catch (error: unknown) {
      // Забытая отметка даст следующему запросу попробовать снова.
      this.written.delete(userId);
      this.logger.warn(`Не удалось отметить посещение ${userId}: ${String(error)}`);
    }
  }

  private remember(userId: string, at: number): void {
    if (this.written.size >= MEMO_LIMIT) {
      for (const [id, time] of this.written) {
        if (at - time >= ONLINE_WINDOW_MS) {
          this.written.delete(id);
        }
      }
    }

    this.written.set(userId, at);
  }
}
