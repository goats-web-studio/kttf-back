import {
  HOME_PODIUMS,
  HOME_STATS_PERIOD_DAYS,
  HOME_STATS_TOP,
  type HomeLeader,
  type HomeLeaders,
  type HomePodiums,
  type HomeStatsPeriod,
  type HomeStatsPlayer,
  type HomeUpsets,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { OCCUPYING_STATUSES } from '../tournaments/tournaments.select.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';

const CLOSED = ['FINISHED', 'RATED'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Начало скользящего окна периода. */
export function periodSince(period: HomeStatsPeriod, now: Date): Date {
  return new Date(now.getTime() - HOME_STATS_PERIOD_DAYS[period] * DAY_MS);
}

function fullName(player: { lastName: string; firstName: string }): string {
  return `${player.lastName} ${player.firstName}`;
}

/**
 * Живые блоки главной — ADR-071: результаты с призёрами, статистика
 * и лучшие победы по всей платформе, как на главной RTTF.
 *
 * Период считается по дате начала турнира — как статистика профиля
 * (ADR-048): встреча, внесённая задним числом, остаётся в своём турнире.
 */
@Injectable()
export class HomeStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tournaments: TournamentsService,
  ) {}

  /** Последние завершённые турниры с призёрами, свежие сверху. */
  async podiums(): Promise<HomePodiums> {
    const finished = await this.prisma.tournament.findMany({
      where: { status: { in: [...CLOSED] } },
      orderBy: { startsAt: 'desc' },
      take: HOME_PODIUMS,
      select: { id: true },
    });
    const ids = finished.map((tournament) => tournament.id);

    // Турниры, завершённые до ADR-048, мест не записали — досчитываются здесь.
    await this.tournaments.ensurePlaces(ids);

    const rows = await this.prisma.tournament.findMany({
      where: { id: { in: ids } },
      orderBy: { startsAt: 'desc' },
      select: {
        id: true,
        name: true,
        startsAt: true,
        level: true,
        ratingCapMax: true,
        ratingCapMin: true,
        club: { select: { id: true, name: true } },
        _count: { select: { registrations: { where: { status: { in: OCCUPYING_STATUSES } } } } },
        registrations: {
          where: { place: { lte: 3 } },
          orderBy: [{ place: 'asc' }],
          select: {
            place: true,
            placeTo: true,
            player: { select: { id: true, lastName: true, firstName: true } },
          },
        },
      },
    });

    return {
      items: rows.map((tournament) => ({
        tournamentId: tournament.id,
        name: tournament.name,
        startsAt: tournament.startsAt.toISOString(),
        level: tournament.level,
        ratingCapMax: tournament.ratingCapMax?.toString() ?? null,
        ratingCapMin: tournament.ratingCapMin?.toString() ?? null,
        club: tournament.club,
        participants: tournament._count.registrations,
        places: tournament.registrations.flatMap((registration) =>
          registration.place === null
            ? []
            : [
                {
                  place: registration.place,
                  placeTo: registration.placeTo,
                  playerId: registration.player.id,
                  name: fullName(registration.player),
                },
              ],
        ),
      })),
    };
  }

  /**
   * «Турниры» и «победы» — кто больше всех играл и выигрывал. Турнир
   * засчитывается, если игрок сыграл в нём хоть одну встречу: заявка без
   * игры — не участие. Победа неявкой — не победа за столом.
   */
  async leaders(period: HomeStatsPeriod, now = new Date()): Promise<HomeLeaders> {
    const since = periodSince(period, now);

    const [tournaments, wins] = await Promise.all([
      this.prisma.$queryRaw<{ playerId: string; count: number }[]>`
        SELECT side."playerId", COUNT(DISTINCT side."tournamentId")::int AS "count"
        FROM (
          SELECT m."playerAId" AS "playerId", m."tournamentId" FROM "Match" m
          JOIN "Tournament" t ON t."id" = m."tournamentId"
          WHERE m."setsA" IS NOT NULL AND t."startsAt" >= ${since} AND t."startsAt" <= ${now}
          UNION ALL
          SELECT m."playerBId", m."tournamentId" FROM "Match" m
          JOIN "Tournament" t ON t."id" = m."tournamentId"
          WHERE m."setsA" IS NOT NULL AND t."startsAt" >= ${since} AND t."startsAt" <= ${now}
        ) side
        JOIN "Player" p ON p."id" = side."playerId"
        GROUP BY side."playerId", p."rating"
        ORDER BY "count" DESC, p."rating" DESC
        LIMIT ${HOME_STATS_TOP}
      `,
      this.prisma.$queryRaw<{ playerId: string; count: number }[]>`
        SELECT w."playerId", COUNT(*)::int AS "count"
        FROM (
          SELECT CASE WHEN m."setsA" > m."setsB" THEN m."playerAId" ELSE m."playerBId" END AS "playerId"
          FROM "Match" m
          JOIN "Tournament" t ON t."id" = m."tournamentId"
          WHERE m."setsA" IS NOT NULL AND m."setsB" IS NOT NULL AND m."setsA" <> m."setsB"
            AND (m."resultType" IS NULL OR m."resultType" <> 'WALKOVER')
            AND t."startsAt" >= ${since} AND t."startsAt" <= ${now}
        ) w
        JOIN "Player" p ON p."id" = w."playerId"
        GROUP BY w."playerId", p."rating"
        ORDER BY "count" DESC, p."rating" DESC
        LIMIT ${HOME_STATS_TOP}
      `,
    ]);

    const players = await this.players([...tournaments, ...wins].map((row) => row.playerId));
    const toLeaders = (rows: readonly { playerId: string; count: number }[]): HomeLeader[] =>
      rows.flatMap((row) => {
        const player = players.get(row.playerId);

        return player === undefined ? [] : [{ player, count: row.count }];
      });

    return { period, tournaments: toLeaders(tournaments), wins: toLeaders(wins) };
  }

  /**
   * Лучшие победы: победитель был слабее по рейтингу на момент встречи.
   * Разрыв берётся из журнала (ADR-069) — значит, только обсчитанные турниры.
   */
  async upsets(period: HomeStatsPeriod, now = new Date()): Promise<HomeUpsets> {
    const since = periodSince(period, now);

    const rows = await this.prisma.$queryRaw<
      {
        matchId: string;
        winnerId: string;
        winnerRating: string;
        loserRating: string;
        winnerDelta: string;
      }[]
    >`
      SELECT e."matchId", e."playerId" AS "winnerId",
        e."ratingBefore"::text AS "winnerRating",
        e."opponentRating"::text AS "loserRating",
        e."delta"::text AS "winnerDelta"
      FROM "RatingEvent" e
      JOIN "Match" m ON m."id" = e."matchId"
      JOIN "Tournament" t ON t."id" = m."tournamentId"
      WHERE e."type" = 'MATCH'
        AND e."opponentRating" > e."ratingBefore"
        AND (m."resultType" IS NULL OR m."resultType" <> 'WALKOVER')
        AND (
          (m."playerAId" = e."playerId" AND m."setsA" > m."setsB")
          OR (m."playerBId" = e."playerId" AND m."setsB" > m."setsA")
        )
        AND t."startsAt" >= ${since} AND t."startsAt" <= ${now}
      ORDER BY (e."opponentRating" - e."ratingBefore") DESC, m."finishedAt" DESC NULLS LAST
      LIMIT ${HOME_STATS_TOP}
    `;

    if (rows.length === 0) {
      return { period, items: [] };
    }

    const matches = await this.prisma.match.findMany({
      where: { id: { in: rows.map((row) => row.matchId) } },
      select: {
        id: true,
        playerAId: true,
        playerBId: true,
        setsA: true,
        setsB: true,
        finishedAt: true,
        tournament: {
          select: {
            id: true,
            name: true,
            startsAt: true,
            club: { select: { id: true, name: true } },
          },
        },
        ratingEvents: { where: { type: 'MATCH' }, select: { playerId: true, delta: true } },
      },
    });
    const byId = new Map(matches.map((match) => [match.id, match]));
    const loserIds = rows.flatMap((row) => {
      const match = byId.get(row.matchId);
      const loserId = match?.playerAId === row.winnerId ? match.playerBId : match?.playerAId;

      return loserId == null ? [] : [loserId];
    });
    const players = await this.players([...rows.map((row) => row.winnerId), ...loserIds]);

    return {
      period,
      items: rows.flatMap((row) => {
        const match = byId.get(row.matchId);

        if (match === undefined) {
          return [];
        }

        const winnerIsA = match.playerAId === row.winnerId;
        const loserId = winnerIsA ? match.playerBId : match.playerAId;
        const winner = players.get(row.winnerId);
        const loser = loserId === null ? undefined : players.get(loserId);
        const loserEvent = match.ratingEvents.find((event) => event.playerId === loserId);

        if (winner === undefined || loser === undefined || loserEvent === undefined) {
          return [];
        }

        return [
          {
            matchId: match.id,
            tournament: {
              id: match.tournament.id,
              name: match.tournament.name,
              startsAt: match.tournament.startsAt.toISOString(),
            },
            club: match.tournament.club,
            playedAt: match.finishedAt?.toISOString() ?? null,
            winner: { id: winner.id, name: winner.name },
            winnerRating: row.winnerRating,
            winnerDelta: row.winnerDelta,
            loser: { id: loser.id, name: loser.name },
            loserRating: row.loserRating,
            loserDelta: loserEvent.delta.toString(),
            setsWinner: (winnerIsA ? match.setsA : match.setsB) ?? 0,
            setsLoser: (winnerIsA ? match.setsB : match.setsA) ?? 0,
          },
        ];
      }),
    };
  }

  private async players(ids: readonly string[]): Promise<Map<string, HomeStatsPlayer>> {
    const rows = await this.prisma.player.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, lastName: true, firstName: true, photoUrl: true, rating: true },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, name: fullName(row), photoUrl: row.photoUrl, rating: row.rating.toString() },
      ]),
    );
  }
}
