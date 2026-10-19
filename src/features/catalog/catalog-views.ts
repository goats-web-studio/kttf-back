import type {
  AdminProductListItemView,
  AdminProductView,
  BrandView,
  ProductCategory,
  ProductImageView,
  ProductListItemView,
  ProductView,
} from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

/** Товар в общем каталоге: опубликован и не скрыт. */
export const VISIBLE = {
  status: 'PUBLISHED',
  hiddenAt: null,
} as const satisfies Prisma.ProductWhereInput;

const imageOrder = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] as const;

export const brandRefFields = {
  id: true,
  name: true,
  slug: true,
} as const satisfies Prisma.BrandSelect;

export const brandFields = {
  ...brandRefFields,
  country: true,
  website: true,
  logoUrl: true,
} as const satisfies Prisma.BrandSelect;

export const imageFields = {
  id: true,
  imageUrl: true,
  width: true,
  height: true,
  credit: true,
} as const satisfies Prisma.ProductImageSelect;

export const listItemFields = {
  id: true,
  slug: true,
  category: true,
  name: true,
  status: true,
  hiddenAt: true,
  brand: { select: brandRefFields },
  // Первое фото — для плитки; остальные списку не нужны.
  images: { select: imageFields, orderBy: [...imageOrder], take: 1 },
} as const satisfies Prisma.ProductSelect;

export const productFields = {
  ...listItemFields,
  aliases: true,
  description: true,
  attrs: true,
  options: true,
  createdAt: true,
  updatedAt: true,
  images: { select: imageFields, orderBy: [...imageOrder] },
  // «Где стоит»: клубы со столом этой модели, без скрытых.
  _count: { select: { clubTables: { where: { club: { hiddenAt: null } } } } },
} as const satisfies Prisma.ProductSelect;

type BrandRecord = Prisma.BrandGetPayload<{ select: typeof brandFields }>;
type ImageRecord = Prisma.ProductImageGetPayload<{ select: typeof imageFields }>;
export type ListItemRecord = Prisma.ProductGetPayload<{ select: typeof listItemFields }>;
export type ProductRecord = Prisma.ProductGetPayload<{ select: typeof productFields }>;

export function toBrandView(
  brand: BrandRecord,
  counts: Partial<Record<ProductCategory, number>> = {},
): BrandView {
  return { ...brand, counts };
}

export function toImageView(image: ImageRecord): ProductImageView {
  return {
    id: image.id,
    url: image.imageUrl,
    width: image.width,
    height: image.height,
    credit: image.credit,
  };
}

/** Виден ли товар в общем каталоге — для мест, где он приходит связью, а не выборкой. */
export function isVisible(product: { status: string; hiddenAt: Date | null }): boolean {
  return product.status === 'PUBLISHED' && product.hiddenAt === null;
}

/** `playerCount` считается отдельно, одним запросом на страницу (`countPlayers`). */
export function toListItemView(product: ListItemRecord, playerCount: number): ProductListItemView {
  const first = product.images[0];

  return {
    id: product.id,
    slug: product.slug,
    category: product.category,
    name: product.name,
    brand: product.brand,
    image:
      first === undefined
        ? null
        : { id: first.id, url: first.imageUrl, width: first.width, height: first.height },
    playerCount,
  };
}

export function toAdminListItemView(
  product: ListItemRecord,
  playerCount: number,
): AdminProductListItemView {
  return {
    ...toListItemView(product, playerCount),
    hidden: product.hiddenAt !== null,
    status: product.status,
  };
}

export function toProductView(product: ProductRecord, playerCount: number): ProductView {
  return {
    id: product.id,
    slug: product.slug,
    category: product.category,
    name: product.name,
    brand: product.brand,
    aliases: product.aliases,
    description: product.description,
    attrs: jsonRecord(product.attrs),
    options: optionLists(product.options),
    images: product.images.map(toImageView),
    status: product.status,
    playerCount,
    clubCount: product._count.clubTables,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export function toAdminProductView(product: ProductRecord, playerCount: number): AdminProductView {
  return { ...toProductView(product, playerCount), hidden: product.hiddenAt !== null };
}

/** `Json` из базы как объект. Пишет туда только сервер после проверки, но тип у колонки шире. */
export function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function optionLists(value: Prisma.JsonValue): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const [axis, list] of Object.entries(jsonRecord(value))) {
    if (Array.isArray(list)) {
      result[axis] = list.filter((item): item is string => typeof item === 'string');
    }
  }

  return result;
}
