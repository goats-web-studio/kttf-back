import { DUEL_REMINDER_HOURS } from '@kttf/shared/types';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { playerName } from './duel-view.js';

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = DUEL_REMINDER_HOURS * HOUR_MS;
/** Как часто проверять: напоминание «за 3 часа» может прийти на 5 минут позже. */
const EVERY_MS = 5 * 60 * 1000;

const sideFields = { userId: true, lastName: true, firstName: true } as const;

/**
 * Напоминание обоим за 3 часа до начала — ADR-068, `DUEL_REMINDER`.
 *
 * Таймер процесса, а не отдельный планировщик: задача одна и дешёвая.
 * Экземпляров API может быть несколько — каждая дуэль захватывается
 * условным обновлением `reminderSentAt IS NULL`, и уведомление пишется той
 * же транзакцией: второй экземпляр строку уже не захватит.
 *
 * Игре, согласованной ближе чем за 3 часа до начала, напоминание не нужно:
 * о ней только что договорились.
 */
@Injectable()
export class DuelRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DuelRemindersService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test' || this.env.DUEL_REMINDERS === 'off') return;

    this.timer = setInterval(() => {
      void this.run();
    }, EVERY_MS);
    // Таймер не держит процесс: остановка API не ждёт следующей проверки.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Отправить причитающиеся напоминания. Возвращает, сколько дуэлей напомнено. */
  async sweep(now = new Date()): Promise<number> {
    const rows = await this.prisma.duel.findMany({
      where: {
        status: 'SCHEDULED',
        reminderSentAt: null,
        startsAt: { gt: now, lte: new Date(now.getTime() + WINDOW_MS) },
      },
      select: {
        id: true,
        kind: true,
        startsAt: true,
        agreedAt: true,
        venueName: true,
        club: { select: { name: true } },
        author: { select: sideFields },
        opponent: { select: sideFields },
      },
    });
    let sent = 0;

    for (const row of rows) {
      const { startsAt, opponent } = row;

      if (startsAt === null || opponent === null) continue;

      // Согласовали уже внутри окна — напоминать не о чем.
      if (row.agreedAt !== null && row.agreedAt.getTime() > startsAt.getTime() - WINDOW_MS) {
        continue;
      }

      const claimed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.duel.updateMany({
          where: { id: row.id, status: 'SCHEDULED', reminderSentAt: null, startsAt },
          data: { reminderSentAt: now },
        });

        if (updated.count === 0) return false;

        for (const [side, other] of [
          [row.author, opponent],
          [opponent, row.author],
        ] as const) {
          if (side.userId === null) continue;

          await this.notifications.create(tx, [side.userId], 'DUEL_REMINDER', {
            duelId: row.id,
            kind: row.kind,
            playerName: playerName(other),
            startsAt: startsAt.toISOString(),
            venueName: row.club?.name ?? row.venueName ?? '',
          });
        }

        return true;
      });

      if (claimed) sent += 1;
    }

    return sent;
  }

  /** Сбой проверки не роняет процесс: следующая попытка — через 5 минут. */
  private async run(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.warn('Не удалось отправить напоминания о дуэлях', error);
    }
  }
}
