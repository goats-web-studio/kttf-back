import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CATALOG_IMAGE_WIDTHS,
  PRODUCT_IMAGES_MAX,
  productAttrsSchema,
  productOptionsSchema,
  slugify,
  type AdminProductListItemView,
  type AdminProductView,
  type BrandView,
  type CreateBrandInput,
  type CreateProductInput,
  type ListProductsQuery,
  type Page,
  type ProductCategory,
  type ProductImageView,
  type UpdateBrandInput,
  type UpdateProductInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { pageOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { storeImage } from '../files/club-image.js';
import { ImageService } from '../files/image.service.js';
import { StorageService } from '../files/storage.service.js';
import { countPlayers } from './catalog-players.js';
import { pickSlug } from './catalog-query.js';
import {
  VISIBLE,
  brandFields,
  imageFields,
  jsonRecord,
  productFields,
  toAdminListItemView,
  toAdminProductView,
  toBrandView,
  toImageView,
  type ProductRecord,
} from './catalog-views.js';
import { CatalogService } from './catalog.service.js';

/**
 * Администрирование каталога — ADR-058, `docs/10` 5.8.
 *
 * Каталог — общий справочник продукта, и ведёт его администратор платформы:
 * производители, карточки, фото, скрытие. Адрес карточки выдаётся один раз
 * и при правке названия не меняется: на него уже ведут ссылки и поиск.
 */
@Injectable()
export class CatalogAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly images: ImageService,
    private readonly storage: StorageService,
  ) {}

  // ---------- производители ----------

  /** Все производители, и без товаров: из этого списка выбирают производителя карточки. */
  async listBrands(): Promise<BrandView[]> {
    const [brands, groups] = await Promise.all([
      this.prisma.brand.findMany({ select: brandFields, orderBy: { name: 'asc' } }),
      this.prisma.product.groupBy({
        by: ['brandId', 'category'],
        where: VISIBLE,
        _count: { _all: true },
      }),
    ]);

    return brands.map((brand) =>
      toBrandView(
        brand,
        Object.fromEntries(
          groups
            .filter((group) => group.brandId === brand.id)
            .map((group) => [group.category, group._count._all]),
        ),
      ),
    );
  }

  async createBrand(input: CreateBrandInput): Promise<BrandView> {
    await this.assertBrandNameFree(input.name);

    const brand = await this.prisma.brand.create({
      data: { ...defined(input), slug: await this.freeBrandSlug(input.name) },
      select: brandFields,
    });

    return toBrandView(brand);
  }

  async updateBrand(id: string, input: UpdateBrandInput): Promise<BrandView> {
    const current = await this.findBrand(id);

    // Смена регистра в своём же названии — не дубликат: «joola» → «JOOLA».
    if (input.name !== undefined && input.name.toLowerCase() !== current.name.toLowerCase()) {
      await this.assertBrandNameFree(input.name);
    }

    await this.prisma.brand.update({ where: { id }, data: defined(input), select: { id: true } });

    return this.catalog.findBrand(current.slug);
  }

  /** Логотип пережимается и сразу становится логотипом производителя. */
  async setBrandLogo(id: string, file: Buffer): Promise<BrandView> {
    const current = await this.findBrand(id);
    const image = await storeImage(
      this.storage,
      'brands',
      await this.images.process(file, CATALOG_IMAGE_WIDTHS),
    );

    await this.prisma.brand.update({
      where: { id },
      data: { logoUrl: image.url },
      select: { id: true },
    });

    return this.catalog.findBrand(current.slug);
  }

  /** Свободный адрес производителя: «Double Fish» и «Double-Fish» — разные названия, адрес один. */
  async freeBrandSlug(name: string): Promise<string> {
    const base = slugify(name);
    const taken = await this.prisma.brand.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });

    return pickSlug(base, new Set(taken.map((brand) => brand.slug)));
  }

  /**
   * Без учёта регистра: «Butterfly» и «BUTTERFLY» — ровно тот разнобой, от
   * которого справочник избавляет. Уникальный индекс в базе регистр
   * различает, поэтому проверка здесь.
   */
  private async assertBrandNameFree(name: string): Promise<void> {
    const taken = await this.prisma.brand.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });

    if (taken !== null) {
      throw new AppError(ERROR_CODES.BRAND_ALREADY_EXISTS, 'Brand already exists', {
        field: 'name',
      });
    }
  }

  private async findBrand(id: string): Promise<{ name: string; slug: string }> {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      select: { name: true, slug: true },
    });

    if (brand === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Brand not found', { id });
    }

    return brand;
  }

  // ---------- товары ----------

  /** Список со скрытыми и непроверенными. */
  async listProducts(
    query: ListProductsQuery,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<Page<AdminProductListItemView>> {
    const { rows, total, players } = await this.catalog.findPage(query, raw, true);

    return pageOf(
      rows.map((row) => toAdminListItemView(row, players.get(row.id) ?? 0)),
      total,
      query,
    );
  }

  async findProduct(id: string): Promise<AdminProductView> {
    const product = await this.prisma.product.findUnique({ where: { id }, select: productFields });

    if (product === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Product not found', { id });
    }

    return this.view(product);
  }

  async createProduct(input: CreateProductInput, userId: string): Promise<AdminProductView> {
    const brand = await this.brandOf(input.brandId);
    const product = await this.prisma.product.create({
      data: {
        category: input.category,
        brandId: input.brandId,
        name: input.name,
        slug: await this.freeProductSlug(brand.name, input.name),
        aliases: input.aliases ?? [],
        description: input.description ?? null,
        attrs: json(input.attrs ?? {}),
        options: json(input.options ?? {}),
        createdById: userId,
      },
      select: productFields,
    });

    return this.view(product);
  }

  /**
   * Правка карточки. Характеристики и варианты проверяются по итоговой
   * категории: пришла только категория — по ней проверяются сохранённые,
   * пришли только характеристики — проверка по сохранённой категории.
   */
  async updateProduct(id: string, input: UpdateProductInput): Promise<AdminProductView> {
    const current = await this.prisma.product.findUnique({
      where: { id },
      select: { category: true, attrs: true, options: true },
    });

    if (current === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Product not found', { id });
    }

    if (input.brandId !== undefined) await this.brandOf(input.brandId);

    if (input.category !== undefined || input.attrs !== undefined || input.options !== undefined) {
      assertProductShape(
        input.category ?? current.category,
        input.attrs ?? jsonRecord(current.attrs),
        input.options ?? jsonRecord(current.options),
      );
    }

    const { attrs, options, ...rest } = input;
    const product = await this.prisma.product.update({
      where: { id },
      data: {
        ...defined(rest),
        ...(attrs === undefined ? {} : { attrs: json(attrs) }),
        ...(options === undefined ? {} : { options: json(options) }),
      },
      select: productFields,
    });

    return this.view(product);
  }

  async setProductHidden(id: string, hidden: boolean): Promise<AdminProductView> {
    await this.assertProduct(id);

    return this.view(
      await this.prisma.product.update({
        where: { id },
        data: { hiddenAt: hidden ? new Date() : null },
        select: productFields,
      }),
    );
  }

  private async view(product: ProductRecord): Promise<AdminProductView> {
    const players = await countPlayers(this.prisma, [product.id]);

    return toAdminProductView(product, players.get(product.id) ?? 0);
  }

  /** Свободный адрес товара: `tibhar-e-lebesson`, занят — `tibhar-e-lebesson-2`. */
  async freeProductSlug(brandName: string, name: string): Promise<string> {
    const base = slugify(brandName, name);
    const taken = await this.prisma.product.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });

    return pickSlug(base, new Set(taken.map((product) => product.slug)));
  }

  private async brandOf(brandId: string): Promise<{ name: string }> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { name: true },
    });

    // Производитель выбирается из списка — нет его, значит, неверен запрос.
    if (brand === null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Brand not found', { field: 'brandId' });
    }

    return brand;
  }

  private async assertProduct(id: string): Promise<void> {
    const product = await this.prisma.product.findUnique({ where: { id }, select: { id: true } });

    if (product === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Product not found', { id });
    }
  }

  // ---------- фото ----------

  /**
   * Фото товара. Предел — до обработки файла: незачем жать картинку, которую
   * не сохранить. Сервер сам знает размеры — клиенту их не доверяют.
   */
  async addImage(
    productId: string,
    file: Buffer,
    credit: string | null,
  ): Promise<ProductImageView> {
    await this.assertProduct(productId);

    const [count, last] = await Promise.all([
      this.prisma.productImage.count({ where: { productId } }),
      this.prisma.productImage.aggregate({ where: { productId }, _max: { sortOrder: true } }),
    ]);

    if (count >= PRODUCT_IMAGES_MAX) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Product images limit reached', {
        field: 'file',
        reason: 'LIMIT',
        max: PRODUCT_IMAGES_MAX,
      });
    }

    const image = await storeImage(
      this.storage,
      'products',
      await this.images.process(file, CATALOG_IMAGE_WIDTHS),
    );

    return toImageView(
      await this.prisma.productImage.create({
        data: {
          productId,
          imageUrl: image.url,
          width: image.width,
          height: image.height,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
          credit,
        },
        select: imageFields,
      }),
    );
  }

  /**
   * Удаление фото. Файлы в хранилище остаются: ключ неизменяем и мог
   * разойтись по кэшам, уборка осиротевших — отдельная фоновая задача.
   */
  async removeImage(productId: string, imageId: string): Promise<void> {
    const image = await this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
      select: { id: true },
    });

    if (image === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Image not found', { id: imageId });
    }

    await this.prisma.productImage.delete({ where: { id: imageId } });
  }

  /** Порядок фото целиком: переставить можно только своё, и только всё сразу. */
  async reorderImages(productId: string, ids: readonly string[]): Promise<ProductImageView[]> {
    await this.assertProduct(productId);

    const own = await this.prisma.productImage.findMany({
      where: { productId },
      select: { id: true },
    });
    const known = new Set(own.map((image) => image.id));

    if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'Order must list every product image once',
        {
          field: 'ids',
        },
      );
    }

    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.productImage.update({
          where: { id },
          data: { sortOrder: index },
          select: { id: true },
        }),
      ),
    );

    const images = await this.prisma.productImage.findMany({
      where: { productId },
      select: imageFields,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return images.map(toImageView);
  }
}

/** Проверенный схемой объект — это JSON; тип Prisma шире, чем `Record<string, unknown>`. */
export function json(value: Readonly<Record<string, unknown>>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

/**
 * Характеристики и варианты по описанию категории. Отказ — в том же виде,
 * что у проверки схемой на входе: форма подсвечивает поля одинаково.
 */
export function assertProductShape(
  category: ProductCategory,
  attrs: unknown,
  options: unknown,
): void {
  const fields: { path: string; message: string }[] = [];

  for (const [field, schema] of [
    ['attrs', productAttrsSchema(category)],
    ['options', productOptionsSchema(category)],
  ] as const) {
    for (const issue of schema.safeParse(field === 'attrs' ? attrs : options).error?.issues ?? []) {
      fields.push({ path: [field, ...issue.path].join('.'), message: issue.message });
    }
  }

  if (fields.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Attributes do not match the category', {
      fields,
    });
  }
}
