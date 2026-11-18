import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { AccountRequestKind } from '@kttf/shared/types';
import { z } from 'zod';

import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Снимок личных полей профиля в архиве — ADR-095.
 *
 * Ровно то, что обезличивание ADR-092 стирает: вернуть человеку можно только
 * то, что у него забрали. Год рождения, пол и город не стираются и в снимок
 * не входят. Схема разбирает JSON при восстановлении: снимок пролежал в базе
 * до 30 дней, и доверять его форме вслепую незачем.
 */
export const archiveSnapshotSchema = z.object({
  lastName: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  birthDate: z.string().nullable(),
  birthYearOnly: z.boolean(),
  photoUrl: z.string().nullable(),
  clubId: z.string().nullable(),
  playingHand: z.enum(['RIGHT', 'LEFT']).nullable(),
  grip: z.enum(['SHAKEHAND', 'PENHOLD']).nullable(),
  blade: z.string().nullable(),
  rubberForehand: z.string().nullable(),
  rubberBackhand: z.string().nullable(),
  bio: z.string().nullable(),
  bladeProductId: z.string().nullable(),
  rubberForehandProductId: z.string().nullable(),
  rubberBackhandProductId: z.string().nullable(),
  coachPlayerId: z.string().nullable(),
  coachName: z.string().nullable(),
  coachVisibility: z.enum(['ALL', 'CURRENT', 'NONE']),
});
export type ArchiveSnapshot = z.infer<typeof archiveSnapshotSchema>;

/** Поля игрока, из которых собирается снимок. */
export const snapshotFields = {
  lastName: true,
  firstName: true,
  middleName: true,
  birthDate: true,
  birthYearOnly: true,
  photoUrl: true,
  clubId: true,
  playingHand: true,
  grip: true,
  blade: true,
  rubberForehand: true,
  rubberBackhand: true,
  bio: true,
  bladeProductId: true,
  rubberForehandProductId: true,
  rubberBackhandProductId: true,
  coachPlayerId: true,
  coachName: true,
  coachVisibility: true,
} as const satisfies Prisma.PlayerSelect;

type SnapshotRow = Prisma.PlayerGetPayload<{ select: typeof snapshotFields }>;

export function snapshotOf(row: SnapshotRow): ArchiveSnapshot {
  return {
    ...row,
    // Дата рождения — колонка `date`: в JSON только день, без времени.
    birthDate: row.birthDate === null ? null : row.birthDate.toISOString().slice(0, 10),
  };
}

/** Снимок из базы; испорченный считается стёртым — вернётся названное имя. */
export function parseSnapshot(value: Prisma.JsonValue | null): ArchiveSnapshot | null {
  if (value === null) return null;

  const parsed = archiveSnapshotSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * Заявка, ждущая решения, под блокировкой строки.
 *
 * Два администратора, нажавшие «одобрить» одновременно, не проводят её
 * дважды: второй дождётся первого и увидит, что заявка уже решена.
 */
export async function lockPendingRequest(
  tx: Prisma.TransactionClient,
  id: string,
  kind?: AccountRequestKind,
): Promise<{
  id: string;
  kind: AccountRequestKind;
  userId: string | null;
  playerId: string | null;
  claimedLastName: string | null;
  claimedFirstName: string | null;
}> {
  await tx.$queryRaw`SELECT id FROM "AccountRequest" WHERE id = ${id} FOR UPDATE`;

  const request = await tx.accountRequest.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      userId: true,
      playerId: true,
      claimedLastName: true,
      claimedFirstName: true,
    },
  });

  // Решённая заявка для решения не существует: повторное одобрение не должно
  // ни удалить второй раз, ни переписать уже принятое решение.
  if (request?.status !== 'PENDING' || (kind !== undefined && request.kind !== kind)) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Pending account request not found', { id });
  }

  return request;
}
