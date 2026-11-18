import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { StorageService } from '../files/storage.service.js';

const EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Срок архива — ADR-095, п. 4.
 *
 * Через ARCHIVE_PERSONAL_DATA_DAYS дней снимок личных полей стирается, фото
 * удаляется из хранилища. Хеш телефона и ссылка на профиль остаются: по ним
 * вернувшийся человек находит свою историю.
 *
 * Таймер процесса, как напоминания о дуэлях: раз в сутки и при старте API —
 * перезапуски не должны откладывать стирание на сутки. Экземпляров может быть
 * несколько: чистка повторяема, второй проход ничего не найдёт.
 */
@Injectable()
export class ArchivePurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArchivePurgeService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;

    void this.run();
    this.timer = setInterval(() => {
      void this.run();
    }, EVERY_MS);
    // Таймер не держит процесс: остановка API не ждёт следующей чистки.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Стереть просроченное. Возвращает, сколько архивов почищено. */
  async purge(now = new Date()): Promise<number> {
    const rows = await this.prisma.playerArchive.findMany({
      where: {
        purgeAt: { lt: now },
        OR: [{ photoKey: { not: null } }, { NOT: { snapshot: { equals: Prisma.DbNull } } }],
      },
      select: { playerId: true, photoKey: true },
    });

    if (rows.length === 0) return 0;

    const ids = rows.map((row) => row.playerId);
    const keys = rows.flatMap((row) => (row.photoKey === null ? [] : [row.photoKey]));

    // Сначала файлы: ключ стирается из базы, только когда файла уже нет, —
    // иначе сбой хранилища оставил бы фото, о котором никто не знает.
    // Снимок стирается в любом случае: личным данным в базе срок вышел.
    let filesRemoved = true;

    if (keys.length > 0) {
      try {
        await this.storage.remove(keys);
      } catch (error) {
        filesRemoved = false;
        this.logger.warn(`Archive photo cleanup failed for ${String(keys.length)} files`, error);
      }
    }

    await this.prisma.playerArchive.updateMany({
      where: { playerId: { in: ids } },
      data: filesRemoved
        ? { snapshot: Prisma.DbNull, photoKey: null }
        : { snapshot: Prisma.DbNull },
    });

    return rows.length;
  }

  private async run(): Promise<void> {
    try {
      const purged = await this.purge();
      if (purged > 0) this.logger.log(`Purged personal data of ${String(purged)} archives`);
    } catch (error) {
      this.logger.error('Archive purge failed', error);
    }
  }
}
