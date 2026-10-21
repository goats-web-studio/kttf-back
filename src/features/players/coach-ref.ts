import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { isCoachPublic, type CoachStatus } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';

/** Поля страницы тренера, по которым решается, давать ли на неё ссылку. */
export const coachPageFields = {
  slug: true,
  status: true,
  hiddenAt: true,
} as const satisfies Prisma.CoachSelect;

export interface CoachPageRecord {
  slug: string;
  status: CoachStatus;
  hiddenAt: Date | null;
}

/** Адрес страницы тренера — только опубликованной: черновик по ссылке не откроется. */
export function publicCoachSlug(page: CoachPageRecord | null): string | null {
  return page !== null && isCoachPublic({ status: page.status, hidden: page.hiddenAt !== null })
    ? page.slug
    : null;
}

/**
 * Тренер обязан существовать и не быть самим игроком — и в анкете, и в
 * записи на турнир (T3).
 *
 * Ссылка на себя — не опечатка в данных, а замкнутая ветка: список учеников
 * такого игрока включает его самого, и всякий обход дерева по нему зациклится.
 */
export async function assertCoachExists(
  db: Pick<Prisma.TransactionClient, 'player'>,
  coachId: string | undefined,
  playerId?: string,
): Promise<void> {
  if (coachId === undefined) return;

  if (coachId === playerId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player cannot be their own coach', {
      coachId,
    });
  }

  const coach = await db.player.findUnique({
    where: { id: coachId },
    select: { id: true },
  });

  if (coach === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { coachId });
  }
}
