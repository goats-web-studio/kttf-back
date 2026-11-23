import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  AdminConfirmPlayerInput,
  AdminPlayerListItem,
  AdminPlayersQuery,
  Page,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { isDeletedPlayer, LIVE_PLAYER } from '../players/deleted-player.js';
import { confirmSheet, nameWords } from '../players/players.service.js';
import { writeAudit } from './audit.js';

const itemFields = {
  id: true,
  lastName: true,
  firstName: true,
  middleName: true,
  birthYear: true,
  gender: true,
  city: { select: { id: true, name: true } },
  club: { select: { id: true, name: true } },
  rating: true,
  confirmedAt: true,
  user: { select: { id: true, login: true, phone: true } },
  createdAt: true,
  _count: { select: { registrations: true } },
} as const satisfies Prisma.PlayerSelect;

type ItemRecord = Prisma.PlayerGetPayload<{ select: typeof itemFields }>;

/**
 * Поиск и фильтр профилей — ADR-103. Анкеты без рейтинга тоже здесь:
 * администратор подтверждает их без клуба. Удалённые (ADR-092) — нет:
 * человека уже нет, править нечего.
 */
export function adminPlayersWhere(
  query: Pick<AdminPlayersQuery, 'search' | 'filter'>,
): Prisma.PlayerWhereInput {
  const search = query.search?.trim();

  return {
    ...LIVE_PLAYER,
    ...filterWhere(query.filter),
    ...(search === undefined || search.length === 0 ? {} : { AND: nameWords(search) }),
  };
}

function filterWhere(filter: AdminPlayersQuery['filter']): Prisma.PlayerWhereInput {
  switch (filter) {
    case 'unconfirmed':
      return { confirmedAt: null };
    case 'noAccount':
      return { userId: null };
    case 'withAccount':
      return { userId: { not: null } };
    case 'all':
    case undefined:
      return {};
  }
}

/** Профили игроков глазами администратора — ADR-103. */
@Injectable()
export class AdminPlayersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminPlayersQuery): Promise<Page<AdminPlayerListItem>> {
    const where = adminPlayersWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.player.findMany({
        where,
        select: itemFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.player.count({ where }),
    ]);

    return pageOf(rows.map(toItem), total, query);
  }

  /**
   * Подтвердить анкету без клуба — ADR-103. Та же запись, что у
   * организатора (ADR-072): рейтинг по уровню игры событием INITIAL.
   * Тёзки (ADR-100) не проверяются: администратор подтверждает, уже
   * разобравшись, кто это.
   */
  async confirm(
    id: string,
    input: AdminConfirmPlayerInput,
    adminId: string,
  ): Promise<AdminPlayerListItem> {
    const player = await this.prisma.player.findUnique({
      where: { id },
      select: { deletedAt: true },
    });

    if (player === null || isDeletedPlayer(player)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      await confirmSheet(tx, id, input.startRating);
      await writeAudit(tx, {
        actorId: adminId,
        action: 'player.confirm',
        entityType: 'Player',
        entityId: id,
        before: { confirmed: false },
        after: { confirmed: true, startRating: input.startRating },
      });

      return tx.player.findUniqueOrThrow({ where: { id }, select: itemFields });
    });

    return toItem(confirmed);
  }
}

function toItem(player: ItemRecord): AdminPlayerListItem {
  return {
    id: player.id,
    lastName: player.lastName,
    firstName: player.firstName,
    middleName: player.middleName,
    birthYear: player.birthYear,
    gender: player.gender,
    city: player.city,
    club: player.club,
    rating: player.rating.toString(),
    confirmed: player.confirmedAt !== null,
    user: player.user,
    tournaments: player._count.registrations,
    createdAt: player.createdAt.toISOString(),
  };
}
