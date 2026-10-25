import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { FollowReason, FollowState, FollowSuggestion, FollowTarget } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** На кого подписан человек — по типам, для ленты. */
export interface FollowedTargets {
  readonly clubs: ReadonlySet<string>;
  readonly coaches: ReadonlySet<string>;
  readonly players: ReadonlySet<string>;
}

export const NO_FOLLOWS: FollowedTargets = {
  clubs: new Set(),
  coaches: new Set(),
  players: new Set(),
};

/** Видимая страница тренера — одобрена и не скрыта (ADR-059). */
const VISIBLE_COACH = { status: 'APPROVED', hiddenAt: null } as const;

function fullName(player: { lastName: string; firstName: string }): string {
  return `${player.lastName} ${player.firstName}`;
}

/**
 * Подписки — ADR-073.
 *
 * Подписаться можно только на то, что видно: клуб не скрыт, страница тренера
 * одобрена, игрок — игровой профиль (ADR-072) и не ты сам. Повторная
 * подписка — не ошибка: кнопку нажимают дважды, ответ тот же.
 */
@Injectable()
export class FollowsService {
  constructor(private readonly prisma: PrismaService) {}

  async state(type: FollowTarget, id: string, viewerId?: string): Promise<FollowState> {
    const [followers, mine] = await Promise.all([
      this.prisma.follow.count({ where: { targetType: type, targetId: id } }),
      viewerId === undefined
        ? null
        : this.prisma.follow.findUnique({
            where: {
              userId_targetType_targetId: { userId: viewerId, targetType: type, targetId: id },
            },
            select: { userId: true },
          }),
    ]);

    return { followers, following: mine !== null };
  }

  async follow(type: FollowTarget, id: string, userId: string): Promise<FollowState> {
    await this.assertFollowable(type, id, userId);
    await this.prisma.follow.upsert({
      where: { userId_targetType_targetId: { userId, targetType: type, targetId: id } },
      create: { userId, targetType: type, targetId: id },
      update: {},
    });

    return this.state(type, id, userId);
  }

  async unfollow(type: FollowTarget, id: string, userId: string): Promise<FollowState> {
    await this.prisma.follow.deleteMany({ where: { userId, targetType: type, targetId: id } });

    return this.state(type, id, userId);
  }

  /** На кого подписан — одним запросом, разложено по типам. */
  async targetsOf(userId: string | undefined): Promise<FollowedTargets> {
    if (userId === undefined) return NO_FOLLOWS;

    const rows = await this.prisma.follow.findMany({
      where: { userId },
      select: { targetType: true, targetId: true },
    });
    const of = (type: FollowTarget) =>
      new Set(rows.filter((row) => row.targetType === type).map((row) => row.targetId));

    return { clubs: of('CLUB'), coaches: of('COACH'), players: of('PLAYER') };
  }

  /**
   * На кого подписаться. Вошедшему — сначала клубы, где он играл, его
   * соперники, клубы и тренеры его города; добивается популярными. Гостю —
   * только популярные. Уже подписанное и сам человек не предлагаются.
   */
  async suggestions(userId: string | undefined, limit: number): Promise<FollowSuggestion[]> {
    const followed = await this.targetsOf(userId);
    const me =
      userId === undefined
        ? null
        : await this.prisma.player.findUnique({
            where: { userId },
            select: { id: true, cityId: true },
          });

    const picks: { type: FollowTarget; id: string; reason: FollowReason }[] = [];
    const taken = (type: FollowTarget, id: string) =>
      picks.some((pick) => pick.type === type && pick.id === id) ||
      (type === 'CLUB' && followed.clubs.has(id)) ||
      (type === 'COACH' && followed.coaches.has(id)) ||
      (type === 'PLAYER' && (followed.players.has(id) || id === me?.id));
    const add = (type: FollowTarget, ids: readonly string[], reason: FollowReason) => {
      for (const id of ids) if (!taken(type, id)) picks.push({ type, id, reason });
    };

    if (me !== null) {
      const [played, opponents, cityClubs, cityCoaches] = await Promise.all([
        this.prisma.club.findMany({
          where: {
            hiddenAt: null,
            tournaments: { some: { registrations: { some: { playerId: me.id } } } },
          },
          select: { id: true },
          take: limit,
        }),
        this.opponentsOf(me.id, limit),
        this.prisma.club.findMany({
          where: { hiddenAt: null, cityId: me.cityId },
          select: { id: true },
          orderBy: { name: 'asc' },
          take: limit,
        }),
        this.prisma.coach.findMany({
          where: { ...VISIBLE_COACH, cityId: me.cityId },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: limit,
        }),
      ]);

      // Чередуем источники: пять клубов подряд — не рекомендации, а каталог.
      const lanes: [FollowTarget, string[], FollowReason][] = [
        ['CLUB', played.map((row) => row.id), 'PLAYED'],
        ['PLAYER', opponents, 'OPPONENT'],
        ['COACH', cityCoaches.map((row) => row.id), 'CITY'],
        ['CLUB', cityClubs.map((row) => row.id), 'CITY'],
      ];

      for (let index = 0; index < limit && picks.length < limit; index += 1) {
        for (const [type, ids, reason] of lanes) {
          const id = ids[index];
          if (id !== undefined && picks.length < limit) add(type, [id], reason);
        }
      }
    }

    if (picks.length < limit) {
      const [clubs, coaches] = await Promise.all([
        this.popular('CLUB', limit * 2),
        this.popular('COACH', limit * 2),
      ]);
      // Популярные — тоже вперемешку: клуб, тренер, клуб…
      const mixed = clubs.flatMap((id, index) => {
        const coach = coaches[index];
        return coach === undefined
          ? [['CLUB', id] as const]
          : [['CLUB', id] as const, ['COACH', coach] as const];
      });

      for (const [type, id] of mixed) {
        if (picks.length >= limit) break;
        add(type, [id], 'POPULAR');
      }
    }

    return this.describe(picks.slice(0, limit));
  }

  /** Подписчиков по целям одного типа — для рекомендаций. */
  private async followersOf(
    type: FollowTarget,
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.follow.groupBy({
      by: ['targetId'],
      where: { targetType: type, targetId: { in: [...ids] } },
      _count: { _all: true },
    });

    return new Map(rows.map((row) => [row.targetId, row._count._all]));
  }

  /** Клубы или тренеры по числу подписчиков, без подписчиков — по порядку заведения. */
  private async popular(type: 'CLUB' | 'COACH', take: number): Promise<string[]> {
    const ranked = await this.prisma.follow.groupBy({
      by: ['targetId'],
      where: { targetType: type },
      _count: { _all: true },
      orderBy: { _count: { targetId: 'desc' } },
      take,
    });
    const visible =
      type === 'CLUB'
        ? await this.prisma.club.findMany({
            where: { hiddenAt: null },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: take * 2,
          })
        : await this.prisma.coach.findMany({
            where: VISIBLE_COACH,
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: take * 2,
          });
    const ids = new Set(visible.map((row) => row.id));

    return [
      ...new Set([
        ...ranked.map((row) => row.targetId).filter((id) => ids.has(id)),
        ...visible.map((row) => row.id),
      ]),
    ].slice(0, take);
  }

  /** С кем чаще всего играл — по сыгранным встречам. */
  private async opponentsOf(playerId: string, take: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT side."opponentId" AS "id"
      FROM (
        SELECT m."playerBId" AS "opponentId", m."finishedAt" FROM "Match" m
        WHERE m."playerAId" = ${playerId} AND m."setsA" IS NOT NULL
        UNION ALL
        SELECT m."playerAId" AS "opponentId", m."finishedAt" FROM "Match" m
        WHERE m."playerBId" = ${playerId} AND m."setsA" IS NOT NULL
      ) side
      JOIN "Player" p ON p."id" = side."opponentId" AND p."confirmedAt" IS NOT NULL
      WHERE side."opponentId" IS NOT NULL
      GROUP BY side."opponentId"
      ORDER BY COUNT(*) DESC, MAX(side."finishedAt") DESC NULLS LAST
      LIMIT ${take}
    `;

    return rows.map((row) => row.id);
  }

  /** Имя, картинка, город и подписчики — по три запроса на тип, не по строке. */
  private async describe(
    picks: readonly { type: FollowTarget; id: string; reason: FollowReason }[],
  ): Promise<FollowSuggestion[]> {
    const ids = (type: FollowTarget) =>
      picks.filter((pick) => pick.type === type).map((pick) => pick.id);
    const city = { select: { name: true } } as const;

    const [clubs, coaches, players, clubFans, coachFans, playerFans] = await Promise.all([
      this.prisma.club.findMany({
        where: { id: { in: ids('CLUB') } },
        select: { id: true, name: true, logoUrl: true, city },
      }),
      this.prisma.coach.findMany({
        where: { id: { in: ids('COACH') } },
        select: {
          id: true,
          slug: true,
          photoUrl: true,
          city,
          player: { select: { lastName: true, firstName: true, photoUrl: true } },
        },
      }),
      this.prisma.player.findMany({
        where: { id: { in: ids('PLAYER') } },
        select: { id: true, lastName: true, firstName: true, photoUrl: true, rating: true, city },
      }),
      this.followersOf('CLUB', ids('CLUB')),
      this.followersOf('COACH', ids('COACH')),
      this.followersOf('PLAYER', ids('PLAYER')),
    ]);

    return picks.flatMap((pick): FollowSuggestion[] => {
      if (pick.type === 'CLUB') {
        const club = clubs.find((row) => row.id === pick.id);
        return club === undefined
          ? []
          : [
              {
                type: 'CLUB',
                id: club.id,
                name: club.name,
                imageUrl: club.logoUrl,
                slug: null,
                city: club.city.name,
                rating: null,
                followers: clubFans.get(club.id) ?? 0,
                reason: pick.reason,
              },
            ];
      }

      if (pick.type === 'COACH') {
        const coach = coaches.find((row) => row.id === pick.id);
        return coach === undefined
          ? []
          : [
              {
                type: 'COACH',
                id: coach.id,
                name: fullName(coach.player),
                imageUrl: coach.photoUrl ?? coach.player.photoUrl,
                slug: coach.slug,
                city: coach.city?.name ?? null,
                rating: null,
                followers: coachFans.get(coach.id) ?? 0,
                reason: pick.reason,
              },
            ];
      }

      const player = players.find((row) => row.id === pick.id);
      return player === undefined
        ? []
        : [
            {
              type: 'PLAYER',
              id: player.id,
              name: fullName(player),
              imageUrl: player.photoUrl,
              slug: null,
              city: player.city.name,
              rating: player.rating.toString(),
              followers: playerFans.get(player.id) ?? 0,
              reason: pick.reason,
            },
          ];
    });
  }

  private async assertFollowable(type: FollowTarget, id: string, userId: string): Promise<void> {
    const found =
      type === 'CLUB'
        ? await this.prisma.club.findFirst({ where: { id, hiddenAt: null }, select: { id: true } })
        : type === 'COACH'
          ? await this.prisma.coach.findFirst({
              where: { id, ...VISIBLE_COACH },
              select: { id: true },
            })
          : await this.prisma.player.findFirst({
              where: { id, confirmedAt: { not: null } },
              select: { id: true, userId: true },
            });

    if (found === null)
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Follow target not found', { type, id });

    if ('userId' in found && found.userId === userId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Cannot follow yourself', { type, id });
    }
  }
}
