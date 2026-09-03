import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { hashPassword } from '../src/features/auth/password.js';
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
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
};

const PASSWORD = 'parol123';

const account = {
  id: 'user-1',
  phone: '+77015550101',
  login: 'aslan',
  passwordHash: hashPassword(PASSWORD),
  email: null,
  locale: 'RU',
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  player: null,
  clubRoles: [],
};

function makePrisma() {
  const prisma = {
    user: {
      create: vi.fn().mockResolvedValue(account),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(account),
    },
    player: {
      findUnique: vi.fn().mockResolvedValue({ userId: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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

beforeEach(async () => {
  prisma = makePrisma();

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
  const result = await post('/login', { identifier: account.login, password: PASSWORD });

  return result.body as { accessToken: string; refreshToken: string };
}

describe('POST /auth/login', () => {
  it('верный пароль отдаёт пару токенов и пользователя', async () => {
    const result = await post('/login', { identifier: account.login, password: PASSWORD });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ user: { id: 'user-1', login: 'aslan' } });
  });

  it('пускает и по телефону тем же полем', async () => {
    const result = await post('/login', { identifier: account.phone, password: PASSWORD });

    expect(result.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: account.phone } }),
    );
  });

  it('неверный пароль — 401 в формате ТС 7.8', async () => {
    const result = await post('/login', { identifier: account.login, password: 'ne-parol' });

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('хеш пароля наружу не выходит ни при удаче, ни при отказе', async () => {
    const ok = await post('/login', { identifier: account.login, password: PASSWORD });
    const no = await post('/login', { identifier: account.login, password: 'ne-parol' });

    for (const result of [ok, no]) {
      expect(JSON.stringify(result.body)).not.toContain('scrypt');
    }
  });

  it('пустое тело отвергается схемой, до сервиса не доходит', async () => {
    const result = await post('/login', {});

    expect(result.status).toBe(400);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /auth/sign-up', () => {
  const body = { login: 'novyi', password: PASSWORD, phone: '+77015550102' };

  it('заводит аккаунт и сразу отдаёт сессию', async () => {
    const result = await post('/sign-up', body);

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ user: { id: 'user-1' } });
  });

  it('короткий пароль не доходит до сервиса', async () => {
    const result = await post('/sign-up', { ...body, password: 'korotk1' });

    expect(result.status).toBe(400);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('логин кириллицей отвергается схемой', async () => {
    // Латинская «а» против кириллической — отказ во входе, которого человек
    // не увидит глазами.
    const result = await post('/sign-up', { ...body, login: 'аслан' });

    expect(result.status).toBe(400);
  });

  it('занятый телефон отвергается с указанием поля', async () => {
    prisma.user.findFirst.mockResolvedValue({ phone: body.phone, login: 'drugoi' });

    const result = await post('/sign-up', body);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { details: { field: 'phone' } } });
  });

  it('игрока с кабинетом занять нельзя', async () => {
    prisma.player.findUnique.mockResolvedValue({ userId: 'user-2' });

    const result = await post('/sign-up', {
      ...body,
      playerId: '00000000-0000-4000-8000-000000000009',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { details: { field: 'playerId' } } });
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
