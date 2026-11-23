import type { AuditEntry } from '@kttf/shared/types';

import { Prisma } from '../../generated/prisma/client.js';

/**
 * Журнал действий администратора — ADR-103.
 *
 * Каждое изменение аккаунта, профиля или роли пишется той же транзакцией,
 * что и само изменение: запись без действия или действие без записи —
 * одинаково плохой след. Пароль и его хеш в журнал не попадают никогда.
 */

export type AdminEntity = 'User' | 'Player' | 'ClubMember';

export interface AuditInput {
  readonly actorId: string;
  readonly action: string;
  readonly entityType: AdminEntity;
  readonly entityId: string;
  readonly before?: Prisma.InputJsonObject;
  readonly after?: Prisma.InputJsonObject;
}

export async function writeAudit(tx: Prisma.TransactionClient, entry: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      ...(entry.before === undefined ? {} : { before: entry.before }),
      ...(entry.after === undefined ? {} : { after: entry.after }),
    },
  });
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  createdAt: Date;
}

/** Журнал без связи с `User` (ADR-046): логины действовавших — одним запросом. */
export async function toAuditEntries(
  prisma: Pick<Prisma.TransactionClient, 'user'>,
  rows: readonly AuditRow[],
): Promise<AuditEntry[]> {
  const actorIds = [...new Set(rows.flatMap((row) => (row.actorId === null ? [] : [row.actorId])))];
  const actors =
    actorIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, login: true },
        });
  const byId = new Map(actors.map((actor) => [actor.id, actor]));

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    // Аккаунт действовавшего удалён — запись остаётся, автор неизвестен.
    actor: row.actorId === null ? null : (byId.get(row.actorId) ?? null),
    before: row.before,
    after: row.after,
    createdAt: row.createdAt.toISOString(),
  }));
}
