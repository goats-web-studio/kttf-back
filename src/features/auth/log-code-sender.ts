import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV, type Env } from '../../infra/config/env.js';
import { type CodeSender } from './code-sender.js';

/**
 * Адаптер на время отсутствия SMS-провайдера: код уходит в лог.
 *
 * В продакшне это дыра — код виден каждому, у кого есть доступ к логам.
 * Поэтому адаптер отказывается работать при `NODE_ENV=production`: забыть
 * подменить его при выкатке слишком легко, а цена забывчивости — вход в любой
 * аккаунт по номеру телефона. Отказ происходит при сборке контейнера, то есть
 * приложение просто не поднимется.
 */
@Injectable()
export class LogCodeSender implements CodeSender {
  private readonly logger = new Logger(LogCodeSender.name);

  constructor(@Inject(ENV) env: Env) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'LogCodeSender пишет код в лог и в продакшне недопустим. ' +
          'Подключите настоящего провайдера SMS — ОВ-9 в docs/05-state.md.',
      );
    }
  }

  send(phone: string, code: string): Promise<void> {
    this.logger.warn(`Код для ${phone}: ${code} (провайдер SMS не подключён)`);
    return Promise.resolve();
  }
}
