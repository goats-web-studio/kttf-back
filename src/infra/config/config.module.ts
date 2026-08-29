import { Global, Module } from '@nestjs/common';

import { ENV, parseEnv } from './env.js';

/**
 * Окружение как единственный источник конфигурации.
 *
 * Модуль глобальный: конфигурация нужна почти каждому модулю, а импортировать
 * её в каждый — шум без пользы. Разбор происходит один раз при сборке
 * провайдера, то есть на старте приложения.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => parseEnv(process.env) }],
  exports: [ENV],
})
export class ConfigModule {}
