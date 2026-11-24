import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { ClubApplicationsModule } from '../src/features/club-applications/club-applications.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Заявка клуба через настоящее приложение — ADR-047, ADR-096.
 *
 * Здесь проверяется сборка: модуль заявок видит справочник городов,
 * и ссылка на город доходит до базы только проверенной. Лимит и ловушка
 * для ботов — в юнит-тестах сервиса.
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

const USER_ID = '22222222-2222-4222-8222-222222222222';
const CITY_ID = '55555555-5555-4555-8555-555555555555';
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333';

const body = {
  name: 'Арман',
  contact: '+7 701 123 45 67',
  clubName: 'Спин',
  city: 'Темиртау',
};

const row = {
  id: APPLICATION_ID,
  ...body,
  cityId: CITY_ID,
  address: null,
  tableCount: null,
  tournaments: null,
  message: null,
  status: 'NEW',
  userId: null,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  handledAt: null,
};

function makePrisma() {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: true }) },
    city: { findFirst: vi.fn().mockResolvedValue({ id: CITY_ID }) },
    clubApplication: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([row]),
    },
  };
}

let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let root: string;
let token: string;

beforeEach(async () => {
  prisma = makePrisma();

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule, ClubApplicationsModule],
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
  root = `${await app.getUrl()}/api/v1`;
  token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: USER_ID }, { expiresIn: 600 });
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

async function call(method: string, path: string, options: { body?: unknown; auth?: boolean }) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.auth === true ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();

  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

describe('заявка только от вошедшего — ADR-104', () => {
  it('без токена — 401, заявка не пишется', async () => {
    expect(await call('POST', '/club-applications', { body })).toMatchObject({ status: 401 });
    expect(prisma.clubApplication.create).not.toHaveBeenCalled();
  });

  it('с токеном — заявка привязана к аккаунту', async () => {
    expect((await call('POST', '/club-applications', { body, auth: true })).status).toBe(204);
    expect(prisma.clubApplication.create.mock.calls[0]?.[0]).toMatchObject({
      data: { userId: USER_ID },
    });
  });
});

describe('город заявки из справочника — ADR-096', () => {
  it('выбранный город сохраняется и строкой, и ссылкой', async () => {
    const result = await call('POST', '/club-applications', {
      body: { ...body, cityId: CITY_ID },
      auth: true,
    });

    expect(result.status).toBe(204);
    expect(prisma.city.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: CITY_ID, isActive: true, country: { isActive: true } },
    });
    expect(prisma.clubApplication.create.mock.calls[0]?.[0]).toMatchObject({
      data: { city: 'Темиртау', cityId: CITY_ID },
    });
  });

  it('вписанный руками — без ссылки', async () => {
    expect((await call('POST', '/club-applications', { body, auth: true })).status).toBe(204);
    expect(prisma.city.findFirst).not.toHaveBeenCalled();
    expect(prisma.clubApplication.create.mock.calls[0]?.[0]).toMatchObject({
      data: { city: 'Темиртау', cityId: null },
    });
  });

  it('неизвестный или скрытый город — 400 CITY_UNAVAILABLE, заявка не пишется', async () => {
    prisma.city.findFirst.mockResolvedValue(null);

    expect(
      await call('POST', '/club-applications', { body: { ...body, cityId: CITY_ID }, auth: true }),
    ).toMatchObject({ status: 400, body: { error: { code: 'CITY_UNAVAILABLE' } } });
    expect(prisma.clubApplication.create).not.toHaveBeenCalled();
  });

  it('ссылка не идентификатор — 400 по схеме', async () => {
    expect(
      await call('POST', '/club-applications', {
        body: { ...body, cityId: 'темиртау' },
        auth: true,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_FAILED' } } });
    expect(prisma.city.findFirst).not.toHaveBeenCalled();
  });

  it('администратор видит ссылку на город', async () => {
    const result = await call('GET', '/admin/club-applications', { auth: true });

    expect(result).toMatchObject({
      status: 200,
      body: { items: [{ city: 'Темиртау', cityId: CITY_ID }] },
    });
  });
});
