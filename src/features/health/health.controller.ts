import { Controller, Get } from '@nestjs/common';

import { SkipRateLimit } from '../auth/rate-limit.interceptor.js';
import { HealthService, type HealthReport } from './health.service.js';

// Оркестратор спрашивает часто, и отказ ему означал бы «контейнер мёртв» (ADR-056).
@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Проверка живости для оркестратора.
   *
   * Отвечает 200 и при недоступной базе: контейнер, который не смог
   * подключиться, перезапуск не чинит, а вот снятие живого контейнера с
   * балансировщика из-за моргнувшей базы делает недоступность полной.
   * Состояние базы видно в теле ответа.
   */
  @Get()
  async check(): Promise<HealthReport> {
    return this.health.check();
  }
}
