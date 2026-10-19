import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CatalogEquipmentService } from './catalog-equipment.service.js';

const PRODUCT = '11111111-1111-4111-8111-111111111111';

function makePrisma() {
  return {
    product: { findFirst: vi.fn().mockResolvedValue({ category: 'RUBBER' }) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(3),
  };
}

let prisma: ReturnType<typeof makePrisma>;
let service: CatalogEquipmentService;

beforeEach(() => {
  prisma = makePrisma();
  service = new CatalogEquipmentService(prisma as unknown as PrismaService);
});

function sqlOf(call: unknown[] | undefined): string {
  // Тегированный шаблон: первый аргумент — части текста, дальше — параметры.
  return (call?.[0] as readonly string[]).join('?');
}

describe('строки инвентаря без товара', () => {
  it('страница строк и общее число', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ text: 'Тенерджи 05', players: 20 }])
      .mockResolvedValueOnce([{ total: 41 }]);

    const page = await service.listTexts({ kind: 'RUBBER', page: 2, limit: 20 });

    expect(page).toEqual({
      items: [{ text: 'Тенерджи 05', players: 20 }],
      total: 41,
      page: 2,
      limit: 20,
    });
    expect(sqlOf(prisma.$queryRaw.mock.calls[0])).toContain('GROUP BY lower(s.text)');
  });
});

describe('связать строку с товаром', () => {
  it('накладка — одним запросом на обе стороны, ввод — параметром', async () => {
    const result = await service.link({ kind: 'RUBBER', text: 'Тенерджи 05', productId: PRODUCT });

    expect(result).toEqual({ updated: 3 });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();

    const call = prisma.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain('"rubberForehandProductId" IS NULL');
    expect(sqlOf(call)).toContain('"rubberBackhandProductId" IS NULL');
    expect(sqlOf(call)).not.toContain('Тенерджи');
    expect(call?.slice(1)).toContain('Тенерджи 05');
  });

  it('основание — только к товару BLADE', async () => {
    await expect(
      service.link({ kind: 'BLADE', text: 'Viscaria', productId: PRODUCT }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'productId' } });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('скрытый или неизвестный товар — отказ', async () => {
    prisma.product.findFirst.mockResolvedValue(null);

    await expect(
      service.link({ kind: 'RUBBER', text: 'x', productId: PRODUCT }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.product.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'PUBLISHED', hiddenAt: null },
    });
  });
});
