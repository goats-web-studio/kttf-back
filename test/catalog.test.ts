import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { CatalogModule } from '../src/features/catalog/catalog.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Каталог маркета через настоящее приложение — ADR-058.
 *
 * Главное здесь — права: каталог читают все без входа, а ведёт его только
 * администратор платформы. Забытый guard открыл бы правку справочника всем
 * вошедшим, и ни один тест сервиса этого не увидит.
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
const BRAND_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';
const IMAGE_ID = '55555555-5555-4555-8555-555555555555';

const brand = {
  id: BRAND_ID,
  name: 'Tibhar',
  slug: 'tibhar',
  country: 'DE',
  website: null,
  logoUrl: null,
};

function makePrisma() {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ isAdmin: false }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    brand: {
      findMany: vi.fn().mockResolvedValue([brand]),
      findUnique: vi.fn().mockResolvedValue(brand),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(brand),
      update: vi.fn().mockResolvedValue(brand),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi
        .fn()
        .mockResolvedValue([{ brandId: BRAND_ID, category: 'BLADE', _count: { _all: 3 } }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
      update: vi.fn(),
    },
    productImage: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let root: string;
let token: string;

beforeEach(async () => {
  prisma = makePrisma();

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule, CatalogModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
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

  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

function asAdmin(): void {
  prisma.user.findUnique.mockResolvedValue({ isAdmin: true });
}

describe('публичный каталог', () => {
  it('производители и товары открыты без токена', async () => {
    expect(await call('GET', '/catalog/brands')).toMatchObject({
      status: 200,
      body: [{ slug: 'tibhar', counts: { BLADE: 3 } }],
    });
    expect(await call('GET', '/catalog/products')).toMatchObject({
      status: 200,
      body: { items: [], total: 0, page: 1, limit: 20 },
    });
  });

  it('фильтры по характеристикам доходят из адреса до условия выборки', async () => {
    await call('GET', '/catalog/products?category=BLADE&bladeType=OFF&weight=80-90&sort=new');

    expect(prisma.product.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        status: 'PUBLISHED',
        hiddenAt: null,
        category: 'BLADE',
        AND: [
          { OR: [{ attrs: { path: ['bladeType'], equals: 'OFF' } }] },
          { attrs: { path: ['weight'], gte: 80, lte: 90 } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('подсказки не читаются адресом товара', async () => {
    expect(await call('GET', '/catalog/products/suggest?q=ле')).toMatchObject({
      status: 200,
      body: [],
    });
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it('скрытый или неизвестный товар — 404', async () => {
    expect(await call('GET', '/catalog/products/tibhar-x')).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
    expect(prisma.product.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { slug: 'tibhar-x', status: 'PUBLISHED', hiddenAt: null },
    });
  });

  it('просмотр — 204 без токена, повтор не считается', async () => {
    expect((await call('POST', `/catalog/products/${PRODUCT_ID}/view`)).status).toBe(204);
    expect((await call('POST', `/catalog/products/${PRODUCT_ID}/view`)).status).toBe(204);

    expect(prisma.product.updateMany).toHaveBeenCalledOnce();
  });
});

describe('ведение каталога', () => {
  const routes = [
    ['GET', '/admin/catalog/brands', undefined],
    ['POST', '/admin/catalog/brands', { name: 'Joola' }],
    ['PATCH', `/admin/catalog/brands/${BRAND_ID}`, { country: 'DE' }],
    ['POST', `/admin/catalog/brands/${BRAND_ID}/logo`, undefined],
    ['GET', '/admin/catalog/products', undefined],
    ['GET', `/admin/catalog/products/${PRODUCT_ID}`, undefined],
    ['POST', '/admin/catalog/products', { category: 'BALL', brandId: BRAND_ID, name: 'R40+' }],
    ['PATCH', `/admin/catalog/products/${PRODUCT_ID}`, { name: 'R40+ 3*' }],
    ['PATCH', `/admin/catalog/products/${PRODUCT_ID}/hidden`, { hidden: true }],
    ['POST', `/admin/catalog/products/${PRODUCT_ID}/images`, undefined],
    ['PUT', `/admin/catalog/products/${PRODUCT_ID}/images/order`, { ids: [IMAGE_ID] }],
    ['DELETE', `/admin/catalog/products/${PRODUCT_ID}/images/${IMAGE_ID}`, undefined],
    ['POST', '/admin/catalog/import', { rows: [{}] }],
    ['GET', '/admin/catalog/equipment-texts?kind=BLADE', undefined],
    [
      'POST',
      '/admin/catalog/equipment-texts/link',
      { kind: 'BLADE', text: 'Viscaria', productId: PRODUCT_ID },
    ],
  ] as const;

  it.each(routes)('%s %s без токена — 401', async (method, path, body) => {
    expect((await call(method, path, { body })).status).toBe(401);
  });

  it.each(routes)('%s %s не администратору — 403', async (method, path, body) => {
    expect(await call(method, path, { body, auth: true })).toMatchObject({
      status: 403,
      body: { error: { code: 'FORBIDDEN' } },
    });
    expect(prisma.brand.create).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('дубликат производителя — 409', async () => {
    asAdmin();
    prisma.brand.findFirst.mockResolvedValue({ id: BRAND_ID });

    expect(
      await call('POST', '/admin/catalog/brands', { body: { name: 'TIBHAR' }, auth: true }),
    ).toMatchObject({ status: 409, body: { error: { code: 'BRAND_ALREADY_EXISTS' } } });
  });

  it('администратор видит и скрытое', async () => {
    asAdmin();

    expect((await call('GET', '/admin/catalog/products', { auth: true })).status).toBe(200);
    expect(prisma.product.findMany.mock.calls[0]?.[0]).toHaveProperty('where', {});
  });

  it('импорт: неверная строка — итог с причиной, а не отказ пачки', async () => {
    asAdmin();

    expect(
      await call('POST', '/admin/catalog/import', { body: { rows: [{ rttfId: 9 }] }, auth: true }),
    ).toMatchObject({ status: 200, body: [{ rttfId: 9, outcome: 'rejected' }] });
  });
});
