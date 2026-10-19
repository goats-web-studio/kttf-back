import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { CatalogAdminService } from './catalog-admin.service.js';
import { ImageFetchError, type CatalogImageFetcher } from './catalog-image-fetcher.js';
import { CatalogImportService } from './catalog-import.service.js';

const row = {
  rttfId: 1234,
  category: 'BLADE',
  brand: { rttfId: 7, name: 'Tibhar' },
  name: 'E. Lebesson',
  attrs: { bladeType: 'OFF', plies: 5 },
  options: { handle: ['FL', 'ST'] },
  images: [{ url: 'https://rttf.ru/img/items/Lebesson 1.jpg' }],
  imageCredit: 'rttf.ru',
  popularity: 40,
};

function makeDeps() {
  const prisma = {
    brand: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'brand-new', name: 'Tibhar' }),
      update: vi.fn().mockResolvedValue({ id: 'brand-1' }),
    },
    product: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'product-new' }),
      update: vi.fn().mockResolvedValue({ id: 'product-1' }),
    },
    productImage: { count: vi.fn().mockResolvedValue(0) },
  };
  const admin = {
    freeBrandSlug: vi.fn().mockResolvedValue('tibhar'),
    freeProductSlug: vi.fn().mockResolvedValue('tibhar-e-lebesson'),
    addImage: vi.fn().mockResolvedValue({}),
  };
  const fetcher = { fetch: vi.fn().mockResolvedValue(Buffer.from('jpg')) };

  return { prisma, admin, fetcher };
}

let deps: ReturnType<typeof makeDeps>;
let service: CatalogImportService;

beforeEach(() => {
  deps = makeDeps();
  service = new CatalogImportService(
    deps.prisma as unknown as PrismaService,
    deps.admin as unknown as CatalogAdminService,
    deps.fetcher as unknown as CatalogImageFetcher,
  );
});

describe('импорт строки', () => {
  it('новый товар нового производителя — заводятся оба, фото скачивается', async () => {
    const [result] = await service.import([row], 'admin-1');

    expect(result).toEqual({ rttfId: 1234, outcome: 'created' });
    expect(deps.prisma.brand.create).toHaveBeenCalledWith({
      data: { name: 'Tibhar', slug: 'tibhar', rttfId: 7 },
      select: { id: true, name: true },
    });
    expect(deps.prisma.product.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        brandId: 'brand-new',
        slug: 'tibhar-e-lebesson',
        rttfId: 1234,
        popularity: 40,
        createdById: 'admin-1',
      },
    });
    expect(deps.fetcher.fetch).toHaveBeenCalledWith('https://rttf.ru/img/items/Lebesson 1.jpg');
    expect(deps.admin.addImage).toHaveBeenCalledWith('product-new', Buffer.from('jpg'), 'rttf.ru');
  });

  it('производитель, заведённый вручную, находится по названию и получает номер RTTF', async () => {
    deps.prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', name: 'TIBHAR', rttfId: null });

    await service.import([row], 'admin-1');

    expect(deps.prisma.brand.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'Tibhar', mode: 'insensitive' } },
      select: { id: true, name: true, rttfId: true },
    });
    expect(deps.prisma.brand.update).toHaveBeenCalledWith({
      where: { id: 'brand-1' },
      data: { rttfId: 7 },
      select: { id: true },
    });
    expect(deps.prisma.brand.create).not.toHaveBeenCalled();
    expect(deps.prisma.product.create.mock.calls[0]?.[0]).toMatchObject({
      data: { brandId: 'brand-1' },
    });
  });

  it('повторный импорт обновляет по rttfId, популярность не опускает, фото не трогает', async () => {
    deps.prisma.brand.findUnique.mockResolvedValue({ id: 'brand-1', name: 'Tibhar' });
    deps.prisma.product.findUnique.mockResolvedValue({ id: 'product-1', popularity: 90 });
    deps.prisma.productImage.count.mockResolvedValue(2);

    const [result] = await service.import([{ ...row, name: 'E. Lebesson OFF' }], 'admin-1');

    expect(result).toEqual({ rttfId: 1234, outcome: 'updated' });
    expect(deps.prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'product-1' },
      data: {
        category: 'BLADE',
        brandId: 'brand-1',
        name: 'E. Lebesson OFF',
        attrs: row.attrs,
        options: row.options,
        popularity: 90,
      },
      select: { id: true },
    });
    expect(deps.prisma.product.create).not.toHaveBeenCalled();
    expect(deps.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('неверная строка отвергается с причиной, остальные проходят', async () => {
    const results = await service.import(
      [{ ...row, rttfId: 1, attrs: { bladeType: 'OFF-' } }, { rttfId: 'x' }, row],
      'admin-1',
    );

    expect(results[0]).toMatchObject({ rttfId: 1, outcome: 'rejected' });
    expect(results[0]?.reason).toContain('attrs.bladeType');
    expect(results[1]).toMatchObject({ rttfId: null, outcome: 'rejected' });
    expect(results[2]).toEqual({ rttfId: 1234, outcome: 'created' });
    expect(deps.prisma.product.create).toHaveBeenCalledOnce();
  });

  it('нескачанное фото строку не отвергает — причина дописывается', async () => {
    deps.fetcher.fetch
      .mockRejectedValueOnce(new ImageFetchError('HOST'))
      .mockResolvedValueOnce(Buffer.from('jpg'));
    deps.admin.addImage.mockRejectedValueOnce(
      new AppError(ERROR_CODES.VALIDATION_FAILED, 'Image cannot be processed', {
        reason: 'DECODE',
      }),
    );

    const [result] = await service.import(
      [
        {
          ...row,
          images: [{ url: 'https://evil.example/a.jpg' }, { url: 'https://rttf.ru/b.jpg' }],
        },
      ],
      'admin-1',
    );

    expect(result).toEqual({
      rttfId: 1234,
      outcome: 'created',
      reason: 'images.0: HOST; images.1: DECODE',
    });
  });

  it('отказ базы на строке — строка отвергается, пачка идёт дальше', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    deps.prisma.product.create
      .mockRejectedValueOnce(new Error('unique constraint'))
      .mockResolvedValueOnce({ id: 'product-2' });

    const results = await service.import([row, { ...row, rttfId: 5678 }], 'admin-1');

    expect(results.map((result) => result.outcome)).toEqual(['rejected', 'created']);
    expect(results[0]?.reason).toBe('INTERNAL_ERROR');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
