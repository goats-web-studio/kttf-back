import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Раз в шесть часов: строки истёкших сессий никому не нужны, спешить некуда. */
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Уборка истёкших сессий — ADR-131.
 *
 * Каждый вход заводит строку `Session` на 90 дней (`SESSION_TTL_MS`), и тех,
 * кто вышел, не нажав «Выйти», или очистил приложение, никто не удалял.
 * Истёкшей сессией не продлить вход (`AuthService.refresh` её отвергает),
 * поэтому её удаление ничего не меняет для человека. Повтор безвреден: два
 * экземпляра API удалят одно и то же, и только один найдёт строки.
 *
 * Фоновая задача процесса, как `ArchivePurgeService`, а не очередь: BullMQ
 * в стеке пока нет, а здесь одна быстрая выборка по индексу `expiresAt`.
 */
@Injectable()
export class SessionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    // В тестах таймеров нет: они пережили бы тест и держали процесс.
    if (this.env.NODE_ENV === 'test') return;

    void this.run();
    this.timer = setInterval(() => {
      void this.run();
    }, EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Удаляет сессии, срок которых вышел; отдаёт, сколько удалено. */
  async purge(now = new Date()): Promise<number> {
    const { count } = await this.prisma.session.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    return count;
  }

  private async run(): Promise<void> {
    try {
      const removed = await this.purge();

      if (removed > 0) this.logger.log(`Удалено истёкших сессий: ${String(removed)}`);
    } catch (error) {
      // Уборка не главная работа процесса: сбой — в журнал, повтор — по таймеру.
      this.logger.warn('Уборка истёкших сессий не удалась', error);
    }
  }
}
