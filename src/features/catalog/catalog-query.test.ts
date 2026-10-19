import { PRODUCT_CATEGORIES, parseProductFilters } from '@kttf/shared/types';
import { describe, expect, it } from 'vitest';

import { ProductCategory } from '../../generated/prisma/client.js';
import {
  containsPattern,
  pickSlug,
  productOrder,
  productWhere,
  searchIdsSql,
  searchTokens,
  suggestSql,
} from './catalog-query.js';

describe('категории', () => {
  it('перечисление в базе совпадает с общим кодом', () => {
    // Новая категория в kttf-shared без миграции упала бы на первой записи.
    expect(Object.values(ProductCategory).sort()).toEqual([...PRODUCT_CATEGORIES].sort());
  });
});

describe('адрес товара', () => {
  it('свободная основа — как есть', () => {
    expect(pickSlug('tibhar-e-lebesson', new Set(['tibhar-e-lebesson-pro']))).toBe(
      'tibhar-e-lebesson',
    );
  });

  it('занятая — с первым свободным суффиксом', () => {
    const taken = new Set(['butterfly-viscaria', 'butterfly-viscaria-2', 'butterfly-viscaria-4']);

    expect(pickSlug('butterfly-viscaria', taken)).toBe('butterfly-viscaria-3');
  });
});

describe('условие списка', () => {
  it('витрина — только опубликованные и не скрытые', () => {
    expect(productWhere({}, null, { withHidden: false })).toEqual({
      status: 'PUBLISHED',
      hiddenAt: null,
    });
    expect(productWhere({}, null, { withHidden: true })).toEqual({});
  });

  it('характеристики: перечисление — любое из, число — границы, да/нет — равенство', () => {
    const query = { category: 'BLADE' as const };
    const filters = parseProductFilters('BLADE', {
      bladeType: 'OFF,ALL',
      weight: '80-90',
      plies: '5-',
      handle: 'FL,ST',
    });

    expect(productWhere(query, filters, { withHidden: false })).toEqual({
      status: 'PUBLISHED',
      hiddenAt: null,
      category: 'BLADE',
      AND: [
        {
          OR: [
            { attrs: { path: ['bladeType'], equals: 'OFF' } },
            { attrs: { path: ['bladeType'], equals: 'ALL' } },
          ],
        },
        { attrs: { path: ['plies'], gte: 5 } },
        { attrs: { path: ['weight'], gte: 80, lte: 90 } },
        {
          OR: [
            { options: { path: ['handle'], array_contains: ['FL'] } },
            { options: { path: ['handle'], array_contains: ['ST'] } },
          ],
        },
      ],
    });
  });

  it('да/нет и производители', () => {
    const brandId = ['11111111-1111-4111-8111-111111111111'];
    const filters = parseProductFilters('RUBBER', { tensor: '1', hardness: 'BAD' });

    expect(productWhere({ category: 'RUBBER', brandId }, filters, { withHidden: true })).toEqual({
      category: 'RUBBER',
      brandId: { in: brandId },
      AND: [{ attrs: { path: ['tensor'], equals: true } }],
    });
  });

  it('без категории фильтры по характеристикам не применяются', () => {
    const filters = parseProductFilters('BLADE', { bladeType: 'OFF' });

    expect(productWhere({}, filters, { withHidden: true })).toEqual({});
  });

  it('найденное поиском — списком идентификаторов', () => {
    expect(productWhere({}, null, { withHidden: true, ids: ['a', 'b'] })).toEqual({
      id: { in: ['a', 'b'] },
    });
  });

  it('порядок всегда заканчивается идентификатором — страницы не теряют строк', () => {
    for (const sort of ['popular', 'name', 'new'] as const) {
      expect(productOrder(sort).at(-1)).toEqual({ id: 'asc' });
    }
    expect(productOrder('name')[0]).toEqual({ brand: { name: 'asc' } });
  });
});

describe('поиск', () => {
  it('слова строчными, без повторов', () => {
    expect(searchTokens('  Tibhar  LEBESSON tibhar ')).toEqual(['tibhar', 'lebesson']);
  });

  it('знаки шаблона LIKE из запроса — буквально', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('ввод — только параметрами, в текст запроса не попадает', () => {
    const sql = searchIdsSql(searchTokens('x\'; DROP TABLE "Product"; --'), false);

    expect(sql.sql.toLowerCase()).not.toContain('drop');
    expect(sql.values).toContain("%x';%");
    expect(sql.sql).toContain(`p."hiddenAt" IS NULL`);
  });

  it('администратору поиск — и по скрытым', () => {
    expect(searchIdsSql(['x'], true).sql).not.toContain('hiddenAt');
  });

  it('подсказки: категория и запрос — параметрами', () => {
    const sql = suggestSql('Тенерджи', 'RUBBER', 8);

    expect(sql.values).toEqual(expect.arrayContaining(['тенерджи', 'RUBBER', 8]));
    expect(sql.sql).not.toContain('RUBBER');
  });
});
