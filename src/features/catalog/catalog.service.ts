import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  parseProductFilters,
  type BrandView,
  type ListProductsQuery,
  type Page,
  type ProductCategory,
  type ProductListItemView,
  type ProductView,
  type SuggestProductsQuery,
} from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { RepeatFilter } from '../../common/repeat-filter.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import {
  productOrder,
  productWhere,
  searchIdsSql,
  searchTokens,
  suggestSql,
} from './catalog-query.js';
import {
  VISIBLE,
  brandFields,
  listItemFields,
  productFields,
  toBrandView,
  toListItemView,
  toProductView,
} from './catalog-views.js';

type ListItemRecord = Prisma.ProductGetPayload<{ select: typeof listItemFields }>;

type CategoryCounts = Partial<Record<ProductCategory, number>>;

/**
 * Публичный каталог маркета — ADR-058, `docs/10` 4.1 и 5.
 *
 * Открыт без входа, как каталог клубов. В нём только опубликованные и не
 * скрытые товары: карточка на проверке (M1.3) видна лишь в магазине, который
 * её предложил.
 */
@Injectable()
export class CatalogService {
  private readonly repeats: RepeatFilter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.repeats = new RepeatFilter(env.JWT_SECRET);
  }

  /** Производители, у которых есть что показать, — по названию. */
  async listBrands(): Promise<BrandView[]> {
    const counts = await this.countByBrand(VISIBLE);
    const brands = await this.prisma.brand.findMany({
      where: { id: { in: [...counts.keys()] } },
      select: brandFields,
      orderBy: { name: 'asc' },
    });

    return brands.map((brand) => toBrandView(brand, counts.get(brand.id)));
  }

  /** Страница производителя открывается и без товаров: ссылку на неё могли сохранить. */
  async findBrand(slug: string): Promise<BrandView> {
    const brand = await this.prisma.brand.findUnique({ where: { slug }, select: brandFields });

    if (brand === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Brand not found', { slug });
    }

    const counts = await this.countByBrand({ ...VISIBLE, brandId: brand.id });

    return toBrandView(brand, counts.get(brand.id));
  }

  async listProducts(
    query: ListProductsQuery,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Page<ProductListItemView>> {
    const { rows, total } = await this.findPage(query, raw, false);

    return pageOf(rows.map(toListItemView), total, query);
  }

  /**
   * Страница списка — общая для витрины и администрирования.
   *
   * Без поиска — два запроса: число и страница. С поиском — ещё один
   * впереди: идентификаторы найденного (`searchIdsSql`).
   */
  async findPage(
    query: ListProductsQuery,
    raw: Readonly<Record<string, unknown>>,
    withHidden: boolean,
  ): Promise<{ rows: ListItemRecord[]; total: number }> {
    const filters = query.category === undefined ? null : parseProductFilters(query.category, raw);
    let ids: string[] | undefined;

    if (query.search !== undefined) {
      const tokens = searchTokens(query.search);
      const found = await this.prisma.$queryRaw<{ id: string }[]>(searchIdsSql(tokens, withHidden));

      ids = found.map((row) => row.id);
    }

    const where = productWhere(query, filters, {
      withHidden,
      ...(ids === undefined ? {} : { ids }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: listItemFields,
        orderBy: productOrder(query.sort),
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { rows, total };
  }

  /** Подсказки при вводе — в порядке похожести. */
  async suggest(query: SuggestProductsQuery): Promise<ProductListItemView[]> {
    const found = await this.prisma.$queryRaw<{ id: string }[]>(
      suggestSql(query.q, query.category, query.limit),
    );

    if (found.length === 0) return [];

    const rows = await this.prisma.product.findMany({
      where: { id: { in: found.map((row) => row.id) } },
      select: listItemFields,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return found.flatMap((row) => {
      const product = byId.get(row.id);

      return product === undefined ? [] : [toListItemView(product)];
    });
  }

  async findProduct(slug: string): Promise<ProductView> {
    const product = await this.prisma.product.findFirst({
      where: { slug, ...VISIBLE },
      select: productFields,
    });

    if (product === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Product not found', { slug });
    }

    return toProductView(product);
  }

  /**
   * Просмотр карточки — к популярности. Повтор с того же адреса за полчаса не
   * считается. Чужой и скрытый товар молча не считается: отказ подсказал бы,
   * какие товары есть.
   */
  async recordView(productId: string, ip: string, now = new Date()): Promise<void> {
    if (this.repeats.isRepeat(ip, `product:${productId}`, now)) return;

    await this.prisma.product.updateMany({
      where: { id: productId, ...VISIBLE },
      data: { popularity: { increment: 1 } },
    });
  }

  private async countByBrand(
    where: Prisma.ProductWhereInput,
  ): Promise<Map<string, CategoryCounts>> {
    const groups = await this.prisma.product.groupBy({
      by: ['brandId', 'category'],
      where,
      _count: { _all: true },
    });
    const counts = new Map<string, CategoryCounts>();

    for (const group of groups) {
      const brand = counts.get(group.brandId) ?? {};
      brand[group.category] = group._count._all;
      counts.set(group.brandId, brand);
    }

    return counts;
  }
}
