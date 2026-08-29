import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ENV, type Env } from './infra/config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Версия в префиксе, а не в заголовке: ТС 7 задаёт /api/v1 явно.
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.useGlobalFilters(new AllExceptionsFilter());

  // Без этого onModuleDestroy не вызывается по SIGTERM, и соединения с базой
  // остаются висеть при остановке контейнера.
  app.enableShutdownHooks();

  const env = app.get<Env>(ENV);
  await app.listen(env.PORT);

  new Logger('bootstrap').log(`API слушает порт ${String(env.PORT)} в режиме ${env.NODE_ENV}`);
}

await bootstrap();
