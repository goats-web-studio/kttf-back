import { PRODUCT_IMAGES_MAX } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { StorageService } from '../files/storage.service.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import type { CatalogService } from './catalog.service.js';

const BRAND = '11111111-1111-4111-8111-111111111111';

const product = {
  id: 'product-1',
  slug: 'tibhar-e-lebesson',
  category: 'BLADE' as const,
  name: 'E. Lebesson',
  status: 'PUBLISHED' as const,
  hiddenAt: null,
  brand: { id: BRAND, name: 'Tibhar', slug: 'tibhar' },
  aliases: [],
  description: null,
  attrs: { bladeType: 'OFF' },
  options: { handle: ['FL'] },
  createdAt: new Date('2026-10-20T10:00:00.000Z'),
  updatedAt: new Date('2026-10-20T10:00:00.000Z'),
  images: [],
};

const processed = {
  width: 1280,
  height: 960,
  variants: new Map([
    [240, Buffer.from('s')],
    [640, Buffer.from('m')],
    [1280, Buffer.from('l')],
  ]),
};

function makeDeps() {
  const prisma = {
    brand: {
      findUnique: vi.fn().mockResolvedValue({ name: 'Tibhar', slug: 'tibhar' }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((args: { data: object }) => ({
        id: BRAND,
        country: null,
        website: null,
        logoUrl: null,
        ...args.data,
      })),
      update: vi.fn().mockResolvedValue({ id: BRAND }),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue(product),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(product),
      update: vi.fn().mockResolvedValue(product),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    productImage: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 2 } }),
      create: vi
        .fn()
        .mockImplementation((args: { data: object }) => ({ id: 'image-1', ...args.data })),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({ id: 'image-1' }),
      update: vi.fn().mockResolvedValue({ id: 'image-1' }),
      delete: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  const images = { process: vi.fn().mockResolvedValue(processed), processVideoCover: vi.fn() };
  const storage = { putAt: vi.fn().mockResolvedValue(undefined) };
  const catalog = { findBrand: vi.fn(), findPage: vi.fn() };

  return { prisma, images, storage, catalog };
}

let deps: ReturnType<typeof makeDeps>;
let service: CatalogAdminService;

beforeEach(() => {
  deps = makeDeps();
  service = new CatalogAdminService(
    deps.prisma as unknown as PrismaService,
    deps.catalog as unknown as CatalogService,
    deps.images,
    deps.storage as unknown as StorageService,
  );
});

describe('производитель', () => {
  it('адрес — из названия', async () => {
    const brand = await service.createBrand({ name: 'Double Fish' });

    expect(brand).toMatchObject({ slug: 'double-fish', counts: {} });
  });

  it('то же название в другом регистре — BRAND_ALREADY_EXISTS', async () => {
    deps.prisma.brand.findFirst.mockResolvedValue({ id: BRAND });

    await expect(service.createBrand({ name: 'BUTTERFLY' })).rejects.toMatchObject({
      code: 'BRAND_ALREADY_EXISTS',
    });
    expect(deps.prisma.brand.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'BUTTERFLY', mode: 'insensitive' } },
      select: { id: true },
    });
    expect(deps.prisma.brand.create).not.toHaveBeenCalled();
  });

  it('смена регистра в своём названии — не дубликат', async () => {
    deps.prisma.brand.findFirst.mockResolvedValue({ id: BRAND });

    await service.updateBrand(BRAND, { name: 'TIBHAR' });

    expect(deps.prisma.brand.findFirst).not.toHaveBeenCalled();
    expect(deps.prisma.brand.update).toHaveBeenCalled();
  });
});

describe('товар', () => {
  it('занятый адрес получает суффикс, автор — администратор', async () => {
    deps.prisma.product.findMany.mockResolvedValue([
      { slug: 'tibhar-e-lebesson' },
      { slug: 'tibhar-e-lebesson-2' },
    ]);

    await service.createProduct(
      { category: 'BLADE', brandId: BRAND, name: 'E. Lebesson' },
      'admin-1',
    );

    expect(deps.prisma.product.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slug: 'tibhar-e-lebesson-3',
        createdById: 'admin-1',
        attrs: {},
        options: {},
        aliases: [],
      }) as unknown,
      select: expect.any(Object) as unknown,
    });
  });

  it('несуществующий производитель — отказ проверки', async () => {
    deps.prisma.brand.findUnique.mockResolvedValue(null);

    await expect(
      service.createProduct({ category: 'BLADE', brandId: BRAND, name: 'X' }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'brandId' } });
  });

  it('характеристики без категории проверяются по сохранённой', async () => {
    // У основания нет «тензора» — это ключ накладки.
    await expect(
      service.updateProduct('product-1', { attrs: { tensor: true } }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [expect.objectContaining({ path: 'attrs' }) as unknown] },
    });
    expect(deps.prisma.product.update).not.toHaveBeenCalled();
  });

  it('смена категории проверяет сохранённые характеристики по новой', async () => {
    await expect(service.updateProduct('product-1', { category: 'BALL' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('подходящие характеристики записываются, адрес не меняется', async () => {
    await service.updateProduct('product-1', { name: 'Lebesson', attrs: { bladeType: 'ALL' } });

    expect(deps.prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'product-1' },
      data: { name: 'Lebesson', attrs: { bladeType: 'ALL' } },
      select: expect.any(Object) as unknown,
    });
  });
});

describe('фото товара', () => {
  it('кладётся в products тремя ширинами, порядок — в конец', async () => {
    const image = await service.addImage('product-1', Buffer.from('png'), null);

    expect(deps.images.process).toHaveBeenCalledWith(Buffer.from('png'), [240, 640, 1280]);
    expect(image.url).toMatch(/^\/api\/v1\/files\/products\/[0-9a-f-]{36}\.webp$/);

    const id = image.url.slice('/api/v1/files/products/'.length, -'.webp'.length);
    const keys = deps.storage.putAt.mock.calls.map((call) => call[0] as string).sort();
    expect(keys).toEqual([
      `products/${id}-240.webp`,
      `products/${id}-640.webp`,
      `products/${id}.webp`,
    ]);
    expect(deps.prisma.productImage.create.mock.calls[0]?.[0]).toMatchObject({
      data: { sortOrder: 3, width: 1280, height: 960 },
    });
  });

  it('сверх предела — отказ до обработки файла', async () => {
    deps.prisma.productImage.count.mockResolvedValue(PRODUCT_IMAGES_MAX);

    await expect(service.addImage('product-1', Buffer.from('png'), null)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'LIMIT', max: PRODUCT_IMAGES_MAX },
    });
    expect(deps.images.process).not.toHaveBeenCalled();
  });

  it('порядок — ровно все фото товара', async () => {
    deps.prisma.productImage.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await expect(service.reorderImages('product-1', ['a'])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.reorderImages('product-1', ['a', 'c'])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    await service.reorderImages('product-1', ['b', 'a']);
    expect(deps.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('чужое фото не удаляется', async () => {
    deps.prisma.productImage.findFirst.mockResolvedValue(null);

    await expect(service.removeImage('product-1', 'image-9')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(deps.prisma.productImage.delete).not.toHaveBeenCalled();
  });
});
