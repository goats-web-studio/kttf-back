import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { PlacesModule } from '../src/features/places/places.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Справочник через настоящее приложение — ADR-046.
 *
 * Главное здесь — права: ведение справочника закрыто администратором
 * платформы, и забытый guard открыл бы правку городов всем вошедшим.
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
const COUNTRY_ID = '66666666-6666-4666-8666-666666666666';
const CITY_ID = '55555555-5555-4555-8555-555555555555';

const country = {
  id: COUNTRY_ID,
  code: 'KZ',
  name: 'Казахстан',
  nameKk: 'Қазақстан',
  sortOrder: 10,
  isActive: true,
};

const city = {
  id: CITY_ID,
  countryId: COUNTRY_ID,
  name: 'Алматы',
  nameKk: null,
  sortOrder: 20,
  isActive: true,
};

function makePrisma() {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) },
    country: {
      findMany: vi.fn().mockResolvedValue([country]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(country),
      update: vi.fn().mockResolvedValue(country),
    },
    city: {
      findMany: vi.fn().mockResolvedValue([city]),
      findUnique: vi.fn().mockResolvedValue(city),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(city),
      update: vi.fn().mockResolvedValue(city),
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
    imports: [ConfigModule, PrismaModule, AuthModule, PlacesModule],
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

async function call(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.auth === true ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return { status: response.status, body: await response.json() };
}

function asAdmin(): void {
  prisma.user.findUnique.mockResolvedValue({ isAdmin: true });
}

describe('справочник для выбора', () => {
  it('страны и города открыты без токена', async () => {
    expect(await call('GET', '/countries')).toMatchObject({ status: 200, body: [country] });
    expect(await call('GET', '/cities')).toMatchObject({ status: 200, body: [city] });
  });

  it('скрытое в открытый список не попадает', async () => {
    await call('GET', `/cities?countryId=${COUNTRY_ID}`);

    expect(prisma.city.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { countryId: COUNTRY_ID, isActive: true, country: { isActive: true } },
    });
  });
});

describe('ведение справочника', () => {
  const routes = [
    ['GET', '/admin/countries', undefined],
    ['POST', '/admin/countries', { code: 'UZ', name: 'Узбекистан' }],
    ['PATCH', `/admin/countries/${COUNTRY_ID}`, { isActive: false }],
    ['GET', '/admin/cities', undefined],
    ['POST', '/admin/cities', { countryId: COUNTRY_ID, name: 'Каскелен' }],
    ['PATCH', `/admin/cities/${CITY_ID}`, { name: 'Алма-Ата' }],
  ] as const;

  it.each(routes)('%s %s без токена — 401', async (method, path, body) => {
    expect((await call(method, path, { body })).status).toBe(401);
  });

  it.each(routes)('%s %s не администратору — 403', async (method, path, body) => {
    expect(await call(method, path, { body, auth: true })).toMatchObject({
      status: 403,
      body: { error: { code: 'FORBIDDEN' } },
    });
    expect(prisma.country.create).not.toHaveBeenCalled();
    expect(prisma.city.update).not.toHaveBeenCalled();
  });

  it('администратор видит и скрытое', async () => {
    asAdmin();

    expect((await call('GET', '/admin/cities', { auth: true })).status).toBe(200);
    expect(prisma.city.findMany.mock.calls[0]?.[0]).toMatchObject({ where: {} });
  });

  it('администратор заводит город', async () => {
    asAdmin();
    prisma.country.findUnique.mockResolvedValue(country);

    const result = await call('POST', '/admin/cities', {
      body: { countryId: COUNTRY_ID, name: 'Каскелен' },
      auth: true,
    });

    expect(result.status).toBe(201);
    expect(prisma.city.create).toHaveBeenCalledWith({
      data: { countryId: COUNTRY_ID, name: 'Каскелен' },
      select: expect.any(Object) as unknown,
    });
  });

  it('дубликат — 409', async () => {
    asAdmin();
    prisma.country.findUnique.mockResolvedValue(country);

    const result = await call('POST', '/admin/countries', {
      body: { code: 'kz', name: 'Казахстан' },
      auth: true,
    });

    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'PLACE_ALREADY_EXISTS' } },
    });
  });

  it('удаления нет', async () => {
    asAdmin();

    expect((await call('DELETE', `/admin/cities/${CITY_ID}`, { auth: true })).status).toBe(404);
  });
});
