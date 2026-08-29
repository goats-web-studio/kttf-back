import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../generated/prisma/client.js';
import { ENV, type Env } from '../config/env.js';

/**
 * Клиент Prisma, привязанный к жизненному циклу Nest.
 *
 * Начиная с Prisma 7 подключение идёт через адаптер драйвера, а строка берётся
 * из конфигурации, а не из схемы. Схема перестала быть местом, куда случайно
 * попадают секреты, — см. `prisma.config.ts`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Подключение к базе установлено');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
