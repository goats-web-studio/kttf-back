import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Inject, Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { mergeFields, mergeInto } from '../players/players.service.js';
import { type ArchiveSnapshot, lockPendingRequest, parseSnapshot } from './archive-snapshot.js';
import { phoneHash } from './phone-hash.js';

export type RestoreInvalidReason = 'NOTHING_ARCHIVED' | 'HAS_PROFILE' | 'PROFILE_TAKEN';

export function restoreInvalid(reason: RestoreInvalidReason): AppError {
  return new AppError(ERROR_CODES.ACCOUNT_RESTORE_INVALID, 'Cannot restore archived profile', {
    reason,
  });
}

/**
 * Восстановление архивного профиля — ADR-095, п. 5.
 *
 * Номер без SMS не подтверждён (ADR-034), поэтому историю к новому аккаунту
 * привязывает только администратор, одобряя заявку. Профиль возвращается
 * аккаунту; пока снимок не стёрт, возвращаются и личные поля, иначе — имя,
 * названное в заявке. Страница тренера, сообщения форума и отменённые дуэли
 * не возвращаются: они обработаны при удалении безвозвратно.
 */
@Injectable()
export class AccountRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async approve(requestId: string, adminId: string, now = new Date()): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const request = await lockPendingRequest(tx, requestId, 'RESTORE');
        const { userId, playerId } = request;

        if (userId === null) {
          throw new AppError(ERROR_CODES.NOT_FOUND, 'Account no longer exists', { requestId });
        }
        if (playerId === null) throw restoreInvalid('NOTHING_ARCHIVED');

        // Блокировка профиля: две заявки на один архив не проводятся разом.
        await tx.$queryRaw`SELECT id FROM "Player" WHERE id = ${playerId} FOR UPDATE`;

        const target = await tx.player.findUnique({
          where: { id: playerId },
          select: { id: true, userId: true, deletedAt: true, archive: true },
        });

        if (target === null) throw restoreInvalid('NOTHING_ARCHIVED');
        if (target.deletedAt === null || target.userId !== null || target.archive === null) {
          throw restoreInvalid('PROFILE_TAKEN');
        }

        const user = await tx.user.findUnique({ where: { id: userId }, select: { phone: true } });

        // Номер аккаунта обязан совпадать с архивом: заявку подавал он, но
        // проверка при одобрении не полагается на то, что видел клиент.
        if (
          user === null ||
          phoneHash(this.env.JWT_SECRET, user.phone) !== target.archive.phoneHash
        ) {
          throw restoreInvalid('NOTHING_ARCHIVED');
        }

        const own = await tx.player.findUnique({ where: { userId }, select: mergeFields });

        if (own?.confirmedAt != null) throw restoreInvalid('HAS_PROFILE');

        const snapshot = parseSnapshot(target.archive.snapshot);
        const data =
          snapshot === null
            ? {
                lastName: request.claimedLastName ?? '',
                firstName: request.claimedFirstName ?? '',
              }
            : await restoredFields(tx, playerId, snapshot);

        await tx.player.update({ where: { id: playerId }, data: { ...data, deletedAt: null } });

        // Неподтверждённая анкета заменяется архивным профилем. Не удаляется
        // напрямую, а вливается тем же путём, что «Это я» (ADR-072): на ней
        // могут висеть страница тренера и ученики, и с ней пропали бы.
        if (own !== null) {
          const restored = await tx.player.findUniqueOrThrow({
            where: { id: playerId },
            select: mergeFields,
          });
          await mergeInto(tx, own, restored);
        }

        const relinked = await tx.player.update({
          where: { id: playerId },
          data: { userId },
          select: { cityId: true },
        });
        // Города у аккаунта нет — город вернувшегося профиля (ADR-093).
        await tx.user.updateMany({
          where: { id: userId, cityId: null },
          data: { cityId: relinked.cityId },
        });
        await tx.playerArchive.delete({ where: { playerId } });
        await tx.accountRequest.update({
          where: { id: requestId },
          data: { status: 'APPROVED', decidedAt: now, decidedById: adminId },
        });

        // В журнал — только идентификаторы, как при удалении.
        await tx.auditLog.create({
          data: {
            actorId: adminId,
            action: 'account.restored',
            entityType: 'Player',
            entityId: playerId,
            after: { userId, requestId, withData: snapshot !== null },
          },
        });
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
  }
}

/**
 * Личные поля из снимка. Ссылки проверяются: за время архива клуб, товар
 * каталога или тренер могли исчезнуть, и висячая ссылка уронила бы запись.
 */
async function restoredFields(
  tx: Prisma.TransactionClient,
  playerId: string,
  snapshot: ArchiveSnapshot,
): Promise<Prisma.PlayerUncheckedUpdateInput> {
  const productIds = [
    snapshot.bladeProductId,
    snapshot.rubberForehandProductId,
    snapshot.rubberBackhandProductId,
  ].flatMap((id) => (id === null ? [] : [id]));

  const [club, products, coach] = await Promise.all([
    snapshot.clubId === null
      ? null
      : tx.club.findUnique({ where: { id: snapshot.clubId }, select: { id: true } }),
    productIds.length === 0
      ? []
      : tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true } }),
    snapshot.coachPlayerId === null || snapshot.coachPlayerId === playerId
      ? null
      : tx.player.findFirst({
          where: { id: snapshot.coachPlayerId, deletedAt: null },
          select: { id: true },
        }),
  ]);
  const known = new Set(products.map((product) => product.id));
  const product = (id: string | null): string | null => (id !== null && known.has(id) ? id : null);

  return {
    lastName: snapshot.lastName,
    firstName: snapshot.firstName,
    middleName: snapshot.middleName,
    birthDate: snapshot.birthDate === null ? null : new Date(snapshot.birthDate),
    birthYearOnly: snapshot.birthYearOnly,
    photoUrl: snapshot.photoUrl,
    clubId: club?.id ?? null,
    playingHand: snapshot.playingHand,
    grip: snapshot.grip,
    blade: snapshot.blade,
    rubberForehand: snapshot.rubberForehand,
    rubberBackhand: snapshot.rubberBackhand,
    bio: snapshot.bio,
    bladeProductId: product(snapshot.bladeProductId),
    rubberForehandProductId: product(snapshot.rubberForehandProductId),
    rubberBackhandProductId: product(snapshot.rubberBackhandProductId),
    coachPlayerId: coach?.id ?? null,
    // Строкой тренер был задан, только если не выбран из игроков.
    coachName: coach === null ? snapshot.coachName : null,
    coachVisibility: snapshot.coachVisibility,
  };
}
