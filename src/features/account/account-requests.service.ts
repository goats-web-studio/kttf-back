import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  AccountRequestView,
  AccountStatusView,
  AdminAccountRequestView,
  ListAccountRequestsQuery,
  RejectAccountRequestInput,
  RequestAccountDeletionInput,
  RequestAccountRestoreInput,
} from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { ENV, type Env } from '../../infra/config/env.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { LoginThrottle } from '../auth/login-throttle.js';
import { DUMMY_HASH, verifyPassword } from '../auth/password.js';
import { assertDeletable, AccountDeletionService } from './account-deletion.service.js';
import { AccountRestoreService, restoreInvalid } from './account-restore.service.js';
import { lockPendingRequest, parseSnapshot } from './archive-snapshot.js';
import { phoneHash } from './phone-hash.js';

/** Сколько заявок отдаёт список администратора: очередь, а не архив. */
const ADMIN_LIST_LIMIT = 200;

const ownFields = {
  id: true,
  kind: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  answer: true,
} as const satisfies Prisma.AccountRequestSelect;

const adminFields = {
  ...ownFields,
  reason: true,
  claimedLastName: true,
  claimedFirstName: true,
  user: { select: { id: true, login: true, phone: true } },
  player: {
    select: {
      id: true,
      lastName: true,
      firstName: true,
      birthYear: true,
      rating: true,
      archive: { select: { snapshot: true } },
      _count: { select: { registrations: true } },
    },
  },
} as const satisfies Prisma.AccountRequestSelect;

type OwnRow = Prisma.AccountRequestGetPayload<{ select: typeof ownFields }>;
type AdminRow = Prisma.AccountRequestGetPayload<{ select: typeof adminFields }>;

/**
 * Заявки на удаление и восстановление аккаунта — ADR-095.
 *
 * Человек просит, администратор решает. До решения аккаунт работает как
 * обычно; сама работа решения — в `AccountDeletionService` (архив) и
 * `AccountRestoreService` (возврат профиля).
 */
@Injectable()
export class AccountRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly throttle: LoginThrottle,
    private readonly deletion: AccountDeletionService,
    private readonly restore: AccountRestoreService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async requestDeletion(
    userId: string,
    input: RequestAccountDeletionInput,
    ip: string,
  ): Promise<AccountRequestView> {
    const throttleKey = `delete:${userId}`;

    // Пароль подбирать перебором так же нельзя, как при входе (ADR-056).
    this.throttle.assertAllowed(throttleKey, ip);

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (account === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }

    // Без пароля аккаунтом не войти (ADR-034), и заявку так не подать:
    // сверка с подставным хешем всегда ложна, а время ответа то же.
    if (!verifyPassword(input.password, account.passwordHash ?? DUMMY_HASH)) {
      this.throttle.recordFailure(throttleKey, ip);
      throw new AppError(ERROR_CODES.WRONG_PASSWORD, 'Password is wrong');
    }

    this.throttle.recordSuccess(throttleKey);

    // Ранняя подсказка: последнему владельцу клуба незачем ждать отказа.
    // Решающая проверка — при одобрении.
    await assertDeletable(this.prisma, userId);
    await this.assertNoPending(userId, 'DELETE');

    const player = await this.prisma.player.findUnique({
      where: { userId },
      select: { id: true },
    });
    const created = await this.prisma.accountRequest.create({
      data: {
        kind: 'DELETE',
        userId,
        playerId: player?.id ?? null,
        reason: emptyToNull(input.reason),
      },
      select: ownFields,
    });

    return ownView(created);
  }

  /** Отозвать свою ожидающую заявку на удаление. */
  async cancelDeletion(userId: string): Promise<void> {
    const cancelled = await this.prisma.accountRequest.updateMany({
      where: { userId, kind: 'DELETE', status: 'PENDING' },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });

    if (cancelled.count === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'No pending deletion request');
    }
  }

  async status(userId: string): Promise<AccountStatusView> {
    const [deletion, restore, archive] = await Promise.all([
      this.latest(userId, 'DELETE'),
      this.latest(userId, 'RESTORE'),
      this.archiveOf(userId),
    ]);

    return {
      deletion: deletion === null ? null : ownView(deletion),
      restore: restore === null ? null : ownView(restore),
      restorable: archive !== null,
      restorableWithData: archive !== null && archive.snapshot !== null,
    };
  }

  async requestRestore(
    userId: string,
    input: RequestAccountRestoreInput,
  ): Promise<AccountRequestView> {
    const archive = await this.archiveOf(userId);

    if (archive === null) throw restoreInvalid('NOTHING_ARCHIVED');

    const own = await this.prisma.player.findUnique({
      where: { userId },
      select: { confirmedAt: true },
    });

    if (own?.confirmedAt != null) throw restoreInvalid('HAS_PROFILE');

    await this.assertNoPending(userId, 'RESTORE');

    const created = await this.prisma.accountRequest.create({
      data: {
        kind: 'RESTORE',
        userId,
        playerId: archive.playerId,
        claimedLastName: input.lastName,
        claimedFirstName: input.firstName,
        reason: emptyToNull(input.comment),
      },
      select: ownFields,
    });

    return ownView(created);
  }

  async list(query: ListAccountRequestsQuery): Promise<AdminAccountRequestView[]> {
    const rows = await this.prisma.accountRequest.findMany({
      where: query.status === undefined ? {} : { status: query.status },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_LIST_LIMIT,
      select: adminFields,
    });

    return rows.map(adminView);
  }

  async approve(id: string, adminId: string): Promise<AdminAccountRequestView> {
    const request = await this.prisma.accountRequest.findUnique({
      where: { id },
      select: { kind: true },
    });

    if (request === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Account request not found', { id });
    }

    if (request.kind === 'DELETE') {
      await this.deletion.approve(id, adminId);
    } else {
      await this.restore.approve(id, adminId);
    }

    return this.adminViewById(id);
  }

  async reject(
    id: string,
    adminId: string,
    input: RejectAccountRequestInput,
  ): Promise<AdminAccountRequestView> {
    await this.prisma.$transaction(async (tx) => {
      await lockPendingRequest(tx, id);
      await tx.accountRequest.update({
        where: { id },
        data: {
          status: 'REJECTED',
          answer: input.answer,
          decidedAt: new Date(),
          decidedById: adminId,
        },
      });
    });

    return this.adminViewById(id);
  }

  private async adminViewById(id: string): Promise<AdminAccountRequestView> {
    const row = await this.prisma.accountRequest.findUniqueOrThrow({
      where: { id },
      select: adminFields,
    });

    return adminView(row);
  }

  private async assertNoPending(userId: string, kind: 'DELETE' | 'RESTORE'): Promise<void> {
    const pending = await this.prisma.accountRequest.count({
      where: { userId, kind, status: 'PENDING' },
    });

    if (pending > 0) {
      throw new AppError(ERROR_CODES.ACCOUNT_REQUEST_PENDING, 'Request already pending', { kind });
    }
  }

  private latest(userId: string, kind: 'DELETE' | 'RESTORE'): Promise<OwnRow | null> {
    return this.prisma.accountRequest.findFirst({
      where: { userId, kind },
      orderBy: { createdAt: 'desc' },
      select: ownFields,
    });
  }

  /**
   * Архив по телефону аккаунта — ADR-095, п. 5. Только профиль, который всё
   * ещё «Удалённый игрок»: возвращённый другому аккаунту восстанавливать нечего.
   */
  private async archiveOf(
    userId: string,
  ): Promise<{ playerId: string; snapshot: Prisma.JsonValue | null } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });

    if (user === null) return null;

    return this.prisma.playerArchive.findFirst({
      where: {
        phoneHash: phoneHash(this.env.JWT_SECRET, user.phone),
        player: { deletedAt: { not: null }, userId: null },
      },
      orderBy: { archivedAt: 'desc' },
      select: { playerId: true, snapshot: true },
    });
  }
}

function ownView(row: OwnRow): AccountRequestView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    answer: row.answer,
  };
}

function adminView(row: AdminRow): AdminAccountRequestView {
  const { player } = row;
  // У «Удалённого игрока» имя в базе пустое. Пока снимок архива жив,
  // администратор видит прежнее имя: по нему он сверяет заявку на
  // восстановление с названным именем.
  const snapshot =
    player?.archive === null ? null : parseSnapshot(player?.archive.snapshot ?? null);

  return {
    ...ownView(row),
    reason: row.reason,
    user: row.user,
    player:
      player === null
        ? null
        : {
            id: player.id,
            lastName: snapshot?.lastName ?? player.lastName,
            firstName: snapshot?.firstName ?? player.firstName,
            birthYear: player.birthYear,
            rating: player.rating.toString(),
            tournaments: player._count.registrations,
          },
    claimedName:
      row.claimedLastName === null
        ? null
        : [row.claimedLastName, row.claimedFirstName ?? ''].join(' ').trim(),
  };
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}
