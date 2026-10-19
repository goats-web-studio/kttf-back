import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CATALOG_IMAGE_MAX_BYTES,
  createBrandSchema,
  createProductSchema,
  importProductsSchema,
  listProductsSchema,
  rejectPhoto,
  reorderProductImagesSchema,
  setProductHiddenSchema,
  suggestProductsSchema,
  updateBrandSchema,
  updateProductSchema,
  type AdminProductListItemView,
  type AdminProductView,
  type BrandView,
  type CreateBrandInput,
  type CreateProductInput,
  type ImportProductsInput,
  type ImportRowResult,
  type ListProductsQuery,
  type Page,
  type ProductImageView,
  type ProductListItemView,
  type ProductView,
  type ReorderProductImagesInput,
  type SetProductHiddenInput,
  type SuggestProductsQuery,
  type UpdateBrandInput,
  type UpdateProductInput,
} from '@kttf/shared/types';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';

import { clientIp } from '../../common/client-ip.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId } from '../auth/jwt-auth.guard.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { CatalogImportService } from './catalog-import.service.js';
import { CatalogService } from './catalog.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());
const slugParam = new ZodValidationPipe(z.string().min(1).max(100));

interface IncomingFile {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly size: number;
}

/** Правило приёма картинки — общее с формой: она отказывает тому же файлу (ADR-036). */
function acceptedImage(file: IncomingFile | undefined): Buffer {
  if (file === undefined) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is missing', { field: 'file' });
  }

  const rejection = rejectPhoto({ type: file.mimetype, size: file.size }, CATALOG_IMAGE_MAX_BYTES);

  if (rejection !== null) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is not accepted', {
      field: 'file',
      reason: rejection,
    });
  }

  return file.buffer;
}

const imageUpload = FileInterceptor('file', { limits: { fileSize: CATALOG_IMAGE_MAX_BYTES } });

/**
 * Каталог маркета — ADR-058, `docs/10` 4.1.
 *
 * Открыт без входа, как каталог клубов. Фильтры по характеристикам приходят
 * своими параметрами адреса, поэтому запрос читается дважды: схемой списка
 * и целиком — для `parseProductFilters`.
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('brands')
  async listBrands(): Promise<BrandView[]> {
    return this.catalog.listBrands();
  }

  @Get('brands/:slug')
  async findBrand(@Param('slug', slugParam) slug: string): Promise<BrandView> {
    return this.catalog.findBrand(slug);
  }

  @Get('products')
  async listProducts(
    @Query(new ZodValidationPipe(listProductsSchema)) query: ListProductsQuery,
    @Query() raw: Record<string, unknown>,
  ): Promise<Page<ProductListItemView>> {
    return this.catalog.listProducts(query, raw);
  }

  /** Маршрут раньше `:slug`: иначе «suggest» читался бы адресом товара. */
  @Get('products/suggest')
  async suggest(
    @Query(new ZodValidationPipe(suggestProductsSchema)) query: SuggestProductsQuery,
  ): Promise<ProductListItemView[]> {
    return this.catalog.suggest(query);
  }

  @Get('products/:slug')
  async findProduct(@Param('slug', slugParam) slug: string): Promise<ProductView> {
    return this.catalog.findProduct(slug);
  }

  /** Просмотр карточки. Ответ пустой и одинаковый всегда — и для повтора, и для чужого товара. */
  @Post('products/:id/view')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordView(@Param('id', uuidParam) id: string, @Req() request: Request): Promise<void> {
    await this.catalog.recordView(id, clientIp(request));
  }
}

/** Ведение каталога — администратор платформы (`docs/10` 4.6, 5.8). */
@Controller('admin/catalog')
@RequireAdmin()
export class CatalogAdminController {
  constructor(
    private readonly admin: CatalogAdminService,
    private readonly importer: CatalogImportService,
  ) {}

  @Get('brands')
  async listBrands(): Promise<BrandView[]> {
    return this.admin.listBrands();
  }

  @Post('brands')
  async createBrand(
    @Body(new ZodValidationPipe(createBrandSchema)) body: CreateBrandInput,
  ): Promise<BrandView> {
    return this.admin.createBrand(body);
  }

  @Patch('brands/:id')
  async updateBrand(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(updateBrandSchema)) body: UpdateBrandInput,
  ): Promise<BrandView> {
    return this.admin.updateBrand(id, body);
  }

  @Post('brands/:id/logo')
  @UseInterceptors(imageUpload)
  async setBrandLogo(
    @Param('id', uuidParam) id: string,
    @UploadedFile() file?: IncomingFile,
  ): Promise<BrandView> {
    return this.admin.setBrandLogo(id, acceptedImage(file));
  }

  @Get('products')
  async listProducts(
    @Query(new ZodValidationPipe(listProductsSchema)) query: ListProductsQuery,
    @Query() raw: Record<string, unknown>,
  ): Promise<Page<AdminProductListItemView>> {
    return this.admin.listProducts(query, raw);
  }

  /** Карточка по идентификатору — со скрытыми: открытая часть их не отдаёт. */
  @Get('products/:id')
  async findProduct(@Param('id', uuidParam) id: string): Promise<AdminProductView> {
    return this.admin.findProduct(id);
  }

  @Post('products')
  async createProduct(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
    @CurrentUserId() userId: string,
  ): Promise<AdminProductView> {
    return this.admin.createProduct(body, userId);
  }

  @Patch('products/:id')
  async updateProduct(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<AdminProductView> {
    return this.admin.updateProduct(id, body);
  }

  @Patch('products/:id/hidden')
  async setHidden(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(setProductHiddenSchema))
    body: SetProductHiddenInput,
  ): Promise<AdminProductView> {
    return this.admin.setProductHidden(id, body.hidden);
  }

  @Post('products/:id/images')
  @UseInterceptors(imageUpload)
  async addImage(
    @Param('id', uuidParam) id: string,
    @UploadedFile() file?: IncomingFile,
  ): Promise<ProductImageView> {
    return this.admin.addImage(id, acceptedImage(file), null);
  }

  /** Раньше `images/:imageId`: иначе «order» читался бы идентификатором фото. */
  @Put('products/:id/images/order')
  async reorderImages(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(reorderProductImagesSchema))
    body: ReorderProductImagesInput,
  ): Promise<ProductImageView[]> {
    return this.admin.reorderImages(id, body.ids);
  }

  @Delete('products/:id/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeImage(
    @Param('id', uuidParam) id: string,
    @Param('imageId', uuidParam) imageId: string,
  ): Promise<void> {
    await this.admin.removeImage(id, imageId);
  }

  /**
   * Пачка импорта. Строки проверяются по одной — неверная отвергается с
   * причиной, остальные записываются. Ответ — итог по каждой строке.
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  async import(
    @Body(new ZodValidationPipe(importProductsSchema)) body: ImportProductsInput,
    @CurrentUserId() userId: string,
  ): Promise<ImportRowResult[]> {
    return this.importer.import(body.rows, userId);
  }
}
