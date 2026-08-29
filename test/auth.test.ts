import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Контракт ТС 7.1 целиком, через настоящее приложение.
 *
 * База подменена, всё остальное настоящее: маршруты, валидация схемой, guard,
 * фильтр ошибок. Именно на стыках этих частей ломается то, чего не видят
 * юнит-тесты сервиса, — например, отказ в формате Nest вместо формата ТС 7.8.
 */
const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  AUTH_CODE_SECRET: 'code_secret_at_least_32_characters!!',
};

const account = {
  id: 'user-1',
  phone: '+77015550101',
  email: null,
  locale: 'RU',
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  player: null,
  clubRoles: [],
};

function makePrisma() {
  const prisma = {
    authCode: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'code-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      upsert: vi.fn().mockResolvedValue(account),
      findUnique: vi.fn().mockResolvedValue(account),
    },
    session: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

// Может остаться неназначенным, если сборка контейнера упала: тогда afterEach
// не должен добавлять к настоящей ошибке свою.
let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let base: string;
/** Коды, которые адаптер написал бы в лог. */
let sentCodes: string[];

beforeEach(async () => {
  prisma = makePrisma();
  sentCodes = [];

  // Адаптер пишет код в лог — здесь лог и перехватывается: тест видит код так
  // же, как его увидит разработчик, пока провайдера SMS нет.
  const { Logger } = await import('@nestjs/common');
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    const match = /: (\d{6}) /.exec(String(message));
    if (match?.[1] !== undefined) sentCodes.push(match[1]);
  });

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  base = `${await app.getUrl()}/api/v1/auth`;
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function get(path: string, token?: string) {
  const response = await fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

  return { status: response.status, body: await response.json() };
}

/** Проходит вход целиком и отдаёт выданную пару токенов. */
async function signIn() {
  await post('/request-code', { phone: account.phone });
  const code = sentCodes[0] ?? '';

  const stored = prisma.authCode.create.mock.calls[0]?.[0] as { data: { codeHash: string } };
  prisma.authCode.findFirst.mockResolvedValue({
    id: 'code-1',
    phone: account.phone,
    codeHash: stored.data.codeHash,
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });

  const result = await post('/verify-code', { phone: account.phone, code });

  return result.body as { accessToken: string; refreshToken: string };
}

describe('POST /auth/request-code', () => {
  it('принимает телефон и отвечает 202', async () => {
    const result = await post('/request-code', { phone: account.phone });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ expiresInSeconds: 300 });
    expect(sentCodes).toHaveLength(1);
  });

  it('код в ответе не возвращается', async () => {
    // Иначе эндпоинт выдаёт код любому, кто знает чужой номер.
    const result = await post('/request-code', { phone: account.phone });

    expect(JSON.stringify(result.body)).not.toContain(sentCodes[0] ?? 'нет кода');
  });

  it('телефон не в формате E.164 отвергается в формате ТС 7.8', async () => {
    const result = await post('/request-code', { phone: '87015550101' });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('пустое тело отвергается', async () => {
    expect((await post('/request-code', {})).status).toBe(400);
  });
});

describe('POST /auth/verify-code', () => {
  it('верный код отдаёт пару токенов и пользователя', async () => {
    const tokens = await signIn();

    expect(tokens.accessToken).toBeTypeOf('string');
    expect(tokens.refreshToken).toBeTypeOf('string');
  });

  it('неверный код — 401 в формате ТС 7.8', async () => {
    await post('/request-code', { phone: account.phone });
    prisma.authCode.findFirst.mockResolvedValue({
      id: 'code-1',
      phone: account.phone,
      codeHash: 'что-то другое',
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    const result = await post('/verify-code', { phone: account.phone, code: '000000' });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('код не из шести цифр не доходит до сервиса', async () => {
    const result = await post('/verify-code', { phone: account.phone, code: '12' });

    expect(result.status).toBe(400);
    expect(prisma.authCode.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /auth/me', () => {
  it('с токеном отдаёт пользователя', async () => {
    const tokens = await signIn();

    const result = await get('/me', tokens.accessToken);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 'user-1', phone: account.phone, playerId: null });
  });

  it('без токена — 401', async () => {
    const result = await get('/me');

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('токен, подписанный чужим ключом, — 401', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const alien = new JwtService({ secret: 'someone_elses_secret_32_characters!!' }).sign({
      sub: 'user-1',
    });

    expect((await get('/me', alien)).status).toBe(401);
  });

  it('refresh-токен не годится как access — это разные вещи', async () => {
    // Один непрозрачная строка для продления, другой подписанный JWT.
    // Перепутать их легко, и без проверки это дало бы вечный доступ.
    const tokens = await signIn();

    expect((await get('/me', tokens.refreshToken)).status).toBe(401);
  });
});

describe('POST /auth/refresh и /auth/logout', () => {
  it('обновление выдаёт новую пару', async () => {
    const tokens = await signIn();
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await post('/refresh', { refreshToken: tokens.refreshToken });

    expect(result.status).toBe(200);
    expect((result.body as { refreshToken: string }).refreshToken).not.toBe(tokens.refreshToken);
  });

  it('неизвестный refresh-токен — 401', async () => {
    const result = await post('/refresh', { refreshToken: 'нет такого' });

    expect(result.status).toBe(401);
  });

  it('выход отвечает 204 и не требует токена доступа', async () => {
    const tokens = await signIn();

    const result = await post('/logout', { refreshToken: tokens.refreshToken });

    expect(result.status).toBe(204);
    expect(prisma.session.deleteMany).toHaveBeenCalledOnce();
  });

  it('повторный выход выглядит так же', async () => {
    // Иначе эндпоинт сообщает, существует ли сессия.
    expect((await post('/logout', { refreshToken: 'уже нет' })).status).toBe(204);
  });
});
