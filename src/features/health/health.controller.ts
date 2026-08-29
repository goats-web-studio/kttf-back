import { Controller, Get } from '@nestjs/common';

import { HealthService, type HealthReport } from './health.service.js';

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
