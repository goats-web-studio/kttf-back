import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly database: 'up' | 'down';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthReport> {
    const database = await this.pingDatabase();

    return { status: database === 'up' ? 'ok' : 'degraded', database };
  }

  private async pingDatabase(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch (error) {
      // Бриф 3.5: пустых catch нет. Отказ базы — событие для лога, а не повод
      // уронить проверку живости.
      this.logger.warn('База недоступна', error);
      return 'down';
    }
  }
}
