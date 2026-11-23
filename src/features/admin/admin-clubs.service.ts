import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { AdminClubListItem, AdminClubMember, AdminClubsQuery, Page } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { LIVE_PLAYER } from '../players/deleted-player.js';

const clubFields = {
  id: true,
  name: true,
  city: { select: { id: true, name: true } },
  createdAt: true,
  members: {
    where: { role: 'OWNER' },
    select: { user: { select: { id: true, login: true } } },
  },
  _count: {
    select: {
      members: true,
      // Удалённые игроки (ADR-092) в составе клуба не считаются.
      players: { where: LIVE_PLAYER },
      tournaments: true,
    },
  },
} as const satisfies Prisma.ClubSelect;

/**
 * Справочник клубов для администратора — ADR-103.
 * Править клуб администратор ходит в обычный кабинет клуба: охрана ролей
 * его пропускает (`ClubRoleGuard`).
 */
@Injectable()
export class AdminClubsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminClubsQuery): Promise<Page<AdminClubListItem>> {
    const search = query.search?.trim();
    const where: Prisma.ClubWhereInput =
      search === undefined || search.length === 0
        ? {}
        : {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { shortName: { contains: search, mode: 'insensitive' } },
            ],
          };

    const [rows, total] = await Promise.all([
      this.prisma.club.findMany({
        where,
        select: clubFields,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.club.count({ where }),
    ]);

    return pageOf(
      rows.map((club) => ({
        id: club.id,
        name: club.name,
        city: club.city,
        members: club._count.members,
        players: club._count.players,
        tournaments: club._count.tournaments,
        owners: club.members.map((member) => member.user),
        createdAt: club.createdAt.toISOString(),
      })),
      total,
      query,
    );
  }

  async members(clubId: string): Promise<AdminClubMember[]> {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });

    if (club === null) throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });

    const rows = await this.prisma.clubMember.findMany({
      where: { clubId },
      // Порядок перечисления ролей в базе: владельцы, организаторы, судьи.
      orderBy: [{ role: 'asc' }, { user: { login: 'asc' } }],
      select: {
        role: true,
        user: {
          select: {
            id: true,
            login: true,
            phone: true,
            player: { select: { lastName: true, firstName: true } },
          },
        },
      },
    });

    return rows.map(({ role, user }) => ({
      userId: user.id,
      login: user.login,
      phone: user.phone,
      name: user.player === null ? null : `${user.player.lastName} ${user.player.firstName}`.trim(),
      role,
    }));
  }
}
