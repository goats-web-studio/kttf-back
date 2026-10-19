import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  EquipmentTextKind,
  EquipmentTextView,
  LinkEquipmentTextInput,
  LinkEquipmentTextResult,
  ListEquipmentTextsQuery,
  Page,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { VISIBLE } from './catalog-views.js';

/**
 * Строки инвентаря без товара: каждая строка анкеты — со своим слотом.
 * Имена колонок — константы здесь, а не ввод: в запрос они попадают
 * фрагментом SQL, и выбирает их только `kind`.
 */
function textsSql(kind: EquipmentTextKind): Prisma.Sql {
  return kind === 'BLADE'
    ? Prisma.sql`SELECT "id", trim("blade") AS text FROM "Player"
        WHERE "bladeProductId" IS NULL AND trim("blade") <> ''`
    : Prisma.sql`SELECT "id", trim("rubberForehand") AS text FROM "Player"
        WHERE "rubberForehandProductId" IS NULL AND trim("rubberForehand") <> ''
      UNION ALL
      SELECT "id", trim("rubberBackhand") AS text FROM "Player"
        WHERE "rubberBackhandProductId" IS NULL AND trim("rubberBackhand") <> ''`;
}

/** Категория товара для строки: основание — BLADE, накладки — RUBBER. */
const CATEGORY = { BLADE: 'BLADE', RUBBER: 'RUBBER' } as const;

/**
 * Несопоставленный инвентарь игроков — ADR-058, `docs/10` 4.2 и 5.8.
 *
 * Строки ADR-035 сводятся без регистра и пробелов по краям: «тенерджи 05 »
 * и «Тенерджи 05» — одна строка. Показывается самое частое написание.
 * Связывание проставляет товар разом всем, кто так написал, и только там,
 * где товара ещё нет. Сама строка остаётся: она — то, что игрок вписал.
 */
@Injectable()
export class CatalogEquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  async listTexts(query: ListEquipmentTextsQuery): Promise<Page<EquipmentTextView>> {
    const source = textsSql(query.kind);

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<EquipmentTextView[]>`
        SELECT mode() WITHIN GROUP (ORDER BY s.text) AS "text", count(DISTINCT s."id")::int AS "players"
        FROM (${source}) s
        GROUP BY lower(s.text)
        ORDER BY "players" DESC, lower(s.text) ASC
        LIMIT ${query.limit} OFFSET ${skipOf(query)}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(DISTINCT lower(s.text))::int AS "total" FROM (${source}) s`,
    ]);

    return pageOf(rows, totals[0]?.total ?? 0, query);
  }

  async link(input: LinkEquipmentTextInput): Promise<LinkEquipmentTextResult> {
    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, ...VISIBLE },
      select: { category: true },
    });

    if (product?.category !== CATEGORY[input.kind]) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Product does not fit the slot', {
        field: 'productId',
      });
    }

    // Регистр сводит база, как и в списке: правило одно, а не два.
    const text = input.text;

    // Одним запросом: игрок с одной накладкой с обеих сторон — один
    // обновлённый, а не два.
    const updated =
      input.kind === 'BLADE'
        ? await this.prisma.$executeRaw`
            UPDATE "Player" SET "bladeProductId" = ${input.productId}
            WHERE "bladeProductId" IS NULL AND lower(trim("blade")) = lower(${text})`
        : await this.prisma.$executeRaw`
            UPDATE "Player" SET
              "rubberForehandProductId" = CASE
                WHEN "rubberForehandProductId" IS NULL AND lower(trim("rubberForehand")) = lower(${text})
                THEN ${input.productId} ELSE "rubberForehandProductId" END,
              "rubberBackhandProductId" = CASE
                WHEN "rubberBackhandProductId" IS NULL AND lower(trim("rubberBackhand")) = lower(${text})
                THEN ${input.productId} ELSE "rubberBackhandProductId" END
            WHERE ("rubberForehandProductId" IS NULL AND lower(trim("rubberForehand")) = lower(${text}))
               OR ("rubberBackhandProductId" IS NULL AND lower(trim("rubberBackhand")) = lower(${text}))`;

    return { updated };
  }
}
