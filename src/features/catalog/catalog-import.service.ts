import { isAppError } from '@kttf/shared/errors';
import {
  importProductRowSchema,
  type ImportProductRow,
  type ImportRowResult,
} from '@kttf/shared/types';
import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CatalogAdminService, json } from './catalog-admin.service.js';
import { CatalogImageFetcher, ImageFetchError } from './catalog-image-fetcher.js';

/** Сколько замечаний схемы попадает в причину отказа: дальше человек всё равно не читает. */
const ISSUES_SHOWN = 5;

/**
 * Импорт каталога — ADR-058, `docs/10` 5.8 и 6.
 *
 * Строки проверяются по одной: неверная строка отвергается с причиной,
 * остальные идут дальше. Ключ повторного импорта — `rttfId`: тот же товар
 * обновляется, а не заводится вторым. Строки идут по порядку, а не разом:
 * два товара одного нового производителя в пачке завели бы его дважды.
 */
@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: CatalogAdminService,
    private readonly fetcher: CatalogImageFetcher,
  ) {}

  async import(rows: readonly unknown[], userId: string): Promise<ImportRowResult[]> {
    const results: ImportRowResult[] = [];

    for (const raw of rows) results.push(await this.importRow(raw, userId));

    return results;
  }

  private async importRow(raw: unknown, userId: string): Promise<ImportRowResult> {
    const parsed = importProductRowSchema.safeParse(raw);

    if (!parsed.success) {
      return {
        rttfId: rawRttfId(raw),
        outcome: 'rejected',
        reason: describeIssues(parsed.error.issues),
      };
    }

    const row = parsed.data;

    try {
      const brand = await this.brandFor(row.brand);
      const { productId, outcome } = await this.upsert(row, brand, userId);
      const failures = await this.importImages(productId, row);

      return {
        rttfId: row.rttfId,
        outcome,
        ...(failures.length === 0 ? {} : { reason: failures.join('; ') }),
      };
    } catch (error) {
      // Отказ базы на одной строке не должен ронять пачку: строка отвергается,
      // подробности — в журнал сервера, а не в ответ.
      this.logger.error(`Строка импорта rttfId=${String(row.rttfId)} не записана`, error);

      return {
        rttfId: row.rttfId,
        outcome: 'rejected',
        reason: isAppError(error) ? error.code : 'INTERNAL_ERROR',
      };
    }
  }

  /**
   * Производитель строки: по номеру RTTF, иначе по названию без регистра —
   * заведённому вручную «Butterfly» номер RTTF дописывается. Нет нигде —
   * заводится.
   */
  private async brandFor(input: ImportProductRow['brand']): Promise<{ id: string; name: string }> {
    const byRttf = await this.prisma.brand.findUnique({
      where: { rttfId: input.rttfId },
      select: { id: true, name: true },
    });

    if (byRttf !== null) return byRttf;

    const byName = await this.prisma.brand.findFirst({
      where: { name: { equals: input.name, mode: 'insensitive' } },
      select: { id: true, name: true, rttfId: true },
    });

    if (byName !== null) {
      if (byName.rttfId === null) {
        await this.prisma.brand.update({
          where: { id: byName.id },
          data: { rttfId: input.rttfId },
          select: { id: true },
        });
      }

      return { id: byName.id, name: byName.name };
    }

    return this.prisma.brand.create({
      data: {
        name: input.name,
        slug: await this.admin.freeBrandSlug(input.name),
        rttfId: input.rttfId,
      },
      select: { id: true, name: true },
    });
  }

  /**
   * Повторный импорт обновляет содержание карточки, но не трогает то, что
   * нажито у нас: адрес, скрытие, фото. Популярность не опускается — свои
   * просмотры к этому времени уже могли её поднять. Нет в строке русских
   * написаний или описания — остаются прежние: их дописывают вручную.
   */
  private async upsert(
    row: ImportProductRow,
    brand: { id: string; name: string },
    userId: string,
  ): Promise<{ productId: string; outcome: 'created' | 'updated' }> {
    const existing = await this.prisma.product.findUnique({
      where: { rttfId: row.rttfId },
      select: { id: true, popularity: true },
    });
    const content = {
      category: row.category,
      brandId: brand.id,
      name: row.name,
      attrs: json(row.attrs),
      options: json(row.options),
      ...(row.aliases === undefined ? {} : { aliases: row.aliases }),
      ...(row.description === undefined ? {} : { description: row.description }),
    };

    if (existing !== null) {
      await this.prisma.product.update({
        where: { id: existing.id },
        data: { ...content, popularity: Math.max(existing.popularity, row.popularity) },
        select: { id: true },
      });

      return { productId: existing.id, outcome: 'updated' };
    }

    const created = await this.prisma.product.create({
      data: {
        ...content,
        slug: await this.admin.freeProductSlug(brand.name, row.name),
        rttfId: row.rttfId,
        popularity: row.popularity,
        createdById: userId,
      },
      select: { id: true },
    });

    return { productId: created.id, outcome: 'created' };
  }

  /**
   * Фото — только товару без фото: заменённые администратором или магазином
   * повторный импорт не возвращает. Нескачанное фото строку не отвергает —
   * причина дописывается в итог.
   */
  private async importImages(productId: string, row: ImportProductRow): Promise<string[]> {
    if (row.images.length === 0) return [];

    const count = await this.prisma.productImage.count({ where: { productId } });

    if (count > 0) return [];

    const failures: string[] = [];

    for (const [index, image] of row.images.entries()) {
      try {
        const body = await this.fetcher.fetch(image.url);

        await this.admin.addImage(productId, body, row.imageCredit ?? null);
      } catch (error) {
        failures.push(`images.${String(index)}: ${imageFailure(error)}`);
      }
    }

    return failures;
  }
}

function imageFailure(error: unknown): string {
  if (error instanceof ImageFetchError) return error.reason;

  if (isAppError(error)) {
    const reason = error.details?.reason;

    return typeof reason === 'string' ? reason : error.code;
  }

  return 'INTERNAL_ERROR';
}

/** Номер RTTF из отвергнутой строки — чтобы в отчёте было видно, какая это. */
function rawRttfId(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const value = (raw as Record<string, unknown>).rttfId;

  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function describeIssues(issues: z.ZodError['issues']): string {
  return issues
    .slice(0, ISSUES_SHOWN)
    .map((issue) => `${issue.path.join('.') || '(строка)'}: ${issue.message}`)
    .join('; ');
}
