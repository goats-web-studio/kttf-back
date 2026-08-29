import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { HealthModule } from '../src/features/health/health.module.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Проверка живости целиком, через настоящий контейнер Nest.
 *
 * Ценность теста не столько в самом эндпоинте, сколько в том, что он падает,
 * если сломается внедрение зависимостей: без метаданных декораторов Nest не
 * соберёт модуль, а метаданные выпускает не Vitest, а swc из vitest.config.ts.
 * Такая поломка иначе обнаруживается только запуском приложения руками.
 */
async function makeApp(queryRaw: () => Promise<unknown>): Promise<INestApplication> {
  // PrismaModule подключается настоящий: он глобальный, и именно через него
  // HealthModule видит клиента. Подменяется только сам провайдер, так что
  // соединение с базой не открывается.
  const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, HealthModule] })
    .overrideProvider(PrismaService)
    .useValue({ $queryRaw: queryRaw })
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  return app;
}

async function get(
  app: INestApplication,
  path: string,
): Promise<{ status: number; body: unknown }> {
  await app.listen(0);
  const url = await app.getUrl();

  try {
    const response = await fetch(`${url}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await app.close();
  }
}

describe('GET /api/v1/health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('база доступна — ok', async () => {
    const app = await makeApp(() => Promise.resolve([{ '?column?': 1 }]));

    await expect(get(app, '/api/v1/health')).resolves.toEqual({
      status: 200,
      body: { status: 'ok', database: 'up' },
    });
  });

  it('база недоступна — degraded, но всё ещё 200', async () => {
    // Перезапуск контейнера моргнувшую базу не чинит, а снятие живого
    // контейнера с балансировщика делает недоступность полной.
    const { Logger } = await import('@nestjs/common');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const app = await makeApp(() => Promise.reject(new Error('connection refused')));

    await expect(get(app, '/api/v1/health')).resolves.toEqual({
      status: 200,
      body: { status: 'degraded', database: 'down' },
    });
  });

  it('несуществующий маршрут отвечает в формате ТС 7.8', async () => {
    const app = await makeApp(() => Promise.resolve([]));

    const { status, body } = await get(app, '/api/v1/nope');

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
