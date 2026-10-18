import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  Page,
  PlayerAwardView,
  PlayerBestWinView,
  PlayerStatsPeriod,
  PlayerSummaryQuery,
  PlayerSummaryView,
  PlayerTournamentMatchView,
  PlayerTournamentsQuery,
  PlayerTournamentView,
  PlayerView,
  TournamentRef,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';

import { playerFields, toPlayerView } from './players.service.js';

/** Лучших побед в профиле — как у RTTF, пять строк. */
export const BEST_WINS = 5;

/** Турниры с местами: только у них итог уже определён. */
const CLOSED = ['FINISHED', 'RATED'] as const;

/** Заявка, с которой играли: снятые и отклонённые в число участников не входят. */
const PLAYED = ['REGISTERED', 'CONFIRMED', 'PLAYING'] as const;

const refFields = { id: true, name: true, startsAt: true } as const;

/**
 * Этапы-сетки: только у их встреч круг считается от финала. У групповых
 * встреч `bracketRound` тоже заполнен — это номер тура, а не круг сетки.
 */
const BRACKETS = ['KNOCKOUT', 'CONSOLATION'] as const;

/** Сыгранная встреча игрока — та же граница, что в истории встреч. */
function playedBy(playerId: string) {
  return { OR: [{ playerAId: playerId }, { playerBId: playerId }], setsA: { not: null } };
}

/**
 * Публичный профиль в структуре RTTF — ADR-048.
 *
 * Сводка и турниры считаются сервером: по странице встреч статистика была
 * бы неверной, а тянуть на клиент всю историю ради пяти чисел незачем.
 * Места в турнирах берутся из заявок (ADR-048); у турниров, завершённых
 * раньше, они досчитываются здесь же при первом обращении.
 */
@Injectable()
export class PlayerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tournaments: TournamentsService,
  ) {}

  async summary(id: string, query: PlayerSummaryQuery): Promise<PlayerSummaryView> {
    const player = await this.load(id);
    const since = periodStart(query.period, new Date());

    const [above, rankedPlayers, peak, matches, first, awards] = await Promise.all([
      // Место — как в списке рейтинга: равный рейтинг делит место.
      this.prisma.player.count({ where: { rating: { gt: player.rating } } }),
      this.prisma.player.count(),
      this.prisma.ratingEvent.aggregate({ where: { playerId: id }, _max: { ratingAfter: true } }),
      this.prisma.match.findMany({
        where: {
          ...playedBy(id),
          ...(since === null ? {} : { tournament: { startsAt: { gte: since } } }),
        },
        select: {
          id: true,
          tournamentId: true,
          playerAId: true,
          playerBId: true,
          setsA: true,
          setsB: true,
          finishedAt: true,
          tournament: { select: { ...refFields, club: { select: { id: true, name: true } } } },
          ratingEvents: {
            where: { playerId: id },
            select: { delta: true, opponentRating: true },
          },
        },
      }),
      this.prisma.tournament.findFirst({
        where: { matches: { some: playedBy(id) } },
        select: refFields,
        orderBy: { startsAt: 'asc' },
      }),
      this.awards(id),
    ]);

    const peakRating = peak._max.ratingAfter;
    const maxRating = peakRating?.greaterThan(player.rating) === true ? peakRating : player.rating;

    const wonBy = (match: (typeof matches)[number]): boolean => {
      const isA = match.playerAId === id;
      return ((isA ? match.setsA : match.setsB) ?? 0) > ((isA ? match.setsB : match.setsA) ?? 0);
    };
    const wins = matches.filter(wonBy).length;

    return {
      playerId: id,
      rank: above + 1,
      rankedPlayers,
      maxRating: maxRating.toString(),
      period: query.period,
      tournaments: new Set(matches.map((match) => match.tournamentId)).size,
      wins,
      losses: matches.length - wins,
      firstTournament: first === null ? null : toRef(first),
      favoriteClub: favoriteClub(matches.map((match) => match.tournament)),
      bestWins: await this.bestWins(
        matches
          .filter(wonBy)
          .flatMap((match) => {
            const event = match.ratingEvents[0];
            const opponentId = match.playerAId === id ? match.playerBId : match.playerAId;

            // Победа без рейтинга соперника — вне зачёта: сравнивать её не с чем.
            return event?.opponentRating == null || opponentId === null
              ? []
              : [{ match, event: { ...event, opponentRating: event.opponentRating }, opponentId }];
          })
          .sort((left, right) => right.event.opponentRating.comparedTo(left.event.opponentRating))
          .slice(0, BEST_WINS),
        id,
      ),
      awards,
    };
  }

  /** «Результаты»: турниры игрока, свежие сверху, со встречами внутри. */
  async tournamentsOf(
    id: string,
    query: PlayerTournamentsQuery,
  ): Promise<Page<PlayerTournamentView>> {
    await this.load(id);

    const played = await this.prisma.match.groupBy({ by: ['tournamentId'], where: playedBy(id) });
    const ids = played.map((row) => row.tournamentId);

    const page = await this.prisma.tournament.findMany({
      where: { id: { in: ids } },
      select: { ...refFields, status: true, club: { select: { id: true, name: true } } },
      orderBy: { startsAt: 'desc' },
      skip: skipOf(query),
      take: query.limit,
    });
    const pageIds = page.map((tournament) => tournament.id);

    await this.tournaments.ensurePlaces(pageIds);

    const [registrations, sizes, matches, events, finals] = await Promise.all([
      this.prisma.registration.findMany({
        where: { playerId: id, tournamentId: { in: pageIds } },
        select: { tournamentId: true, place: true, placeTo: true, ratingAtStart: true },
      }),
      this.prisma.registration.groupBy({
        by: ['tournamentId'],
        where: { tournamentId: { in: pageIds }, status: { in: [...PLAYED] } },
        _count: { _all: true },
      }),
      this.prisma.match.findMany({
        where: { ...playedBy(id), tournamentId: { in: pageIds } },
        select: {
          id: true,
          tournamentId: true,
          stageId: true,
          playerAId: true,
          playerBId: true,
          setsA: true,
          setsB: true,
          resultType: true,
          finishedAt: true,
          bracketRound: true,
          sourceA: true,
          sourceB: true,
          stage: { select: { name: true, type: true } },
          group: { select: { label: true } },
          ratingEvents: { where: { playerId: id }, select: { delta: true } },
        },
        orderBy: [{ finishedAt: { sort: 'asc', nulls: 'last' } }],
      }),
      this.prisma.ratingEvent.findMany({
        where: { playerId: id, tournamentId: { in: pageIds } },
        select: { tournamentId: true, delta: true, ratingAfter: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Последний круг каждой сетки — от него круг встречи считается до финала.
      this.prisma.match.groupBy({
        by: ['stageId'],
        where: {
          tournamentId: { in: pageIds },
          bracketRound: { not: null },
          stage: { type: { in: [...BRACKETS] } },
        },
        _max: { bracketRound: true },
      }),
    ]);

    const opponents = await this.opponents(
      matches.map((match) => (match.playerAId === id ? match.playerBId : match.playerAId)),
    );
    const finalOf = new Map(finals.map((row) => [row.stageId, row._max.bracketRound ?? 1]));
    const sizeOf = new Map(sizes.map((row) => [row.tournamentId, row._count._all]));
    const registrationOf = new Map(registrations.map((row) => [row.tournamentId, row]));

    const items = page.map((tournament): PlayerTournamentView => {
      const registration = registrationOf.get(tournament.id);
      const own = events.filter((event) => event.tournamentId === tournament.id);
      const delta = own.reduce((sum, event) => sum.plus(event.delta), new Prisma.Decimal(0));

      return {
        tournament: { ...toRef(tournament), status: tournament.status, club: tournament.club },
        place: registration?.place ?? null,
        placeTo: registration?.placeTo ?? null,
        participants: sizeOf.get(tournament.id) ?? 0,
        ratingBefore: registration?.ratingAtStart?.toString() ?? null,
        // Дельты нет, пока турнир не обсчитан (ТЗ 7.3): ноль бы врал.
        delta: own.length === 0 ? null : delta.toFixed(2),
        ratingAfter: own.at(-1)?.ratingAfter.toString() ?? null,
        matches: matches
          .filter((match) => match.tournamentId === tournament.id)
          .map((match): PlayerTournamentMatchView => {
            const isA = match.playerAId === id;
            const setsFor = (isA ? match.setsA : match.setsB) ?? 0;
            const setsAgainst = (isA ? match.setsB : match.setsA) ?? 0;
            const opponentId = isA ? match.playerBId : match.playerAId;
            const bracket = (BRACKETS as readonly string[]).includes(match.stage.type);
            const placement = bracket && (takesLosers(match.sourceA) || takesLosers(match.sourceB));

            return {
              matchId: match.id,
              stageName: match.stage.name,
              groupLabel: match.group?.label ?? null,
              roundFromFinal:
                !bracket || match.bracketRound === null || placement
                  ? null
                  : Math.max(0, (finalOf.get(match.stageId) ?? 1) - match.bracketRound),
              placement,
              playedAt: match.finishedAt?.toISOString() ?? null,
              opponent: opponentId === null ? null : (opponents.get(opponentId) ?? null),
              setsFor,
              setsAgainst,
              won: setsFor > setsAgainst,
              resultType: match.resultType,
              delta: match.ratingEvents[0]?.delta.toString() ?? null,
            };
          }),
      };
    });

    return pageOf(items, ids.length, query);
  }

  /** Призовые места 1–3 во всех завершённых турнирах, свежие сверху. */
  private async awards(id: string): Promise<PlayerAwardView[]> {
    const closed = await this.prisma.registration.findMany({
      where: { playerId: id, tournament: { status: { in: [...CLOSED] } } },
      select: { tournamentId: true },
    });

    await this.tournaments.ensurePlaces(closed.map((row) => row.tournamentId));

    const prized = await this.prisma.registration.findMany({
      where: { playerId: id, place: { lte: 3 }, tournament: { status: { in: [...CLOSED] } } },
      select: { place: true, tournament: { select: refFields } },
      orderBy: { tournament: { startsAt: 'desc' } },
    });

    return prized.flatMap((row) =>
      row.place === null ? [] : [{ tournament: toRef(row.tournament), place: row.place }],
    );
  }

  private async bestWins(
    wins: readonly {
      readonly match: {
        readonly id: string;
        readonly playerAId: string | null;
        readonly setsA: number | null;
        readonly setsB: number | null;
        readonly finishedAt: Date | null;
        readonly tournament: {
          readonly id: string;
          readonly name: string;
          readonly startsAt: Date;
        };
      };
      readonly event: { readonly delta: Prisma.Decimal; readonly opponentRating: Prisma.Decimal };
      readonly opponentId: string;
    }[],
    id: string,
  ): Promise<PlayerBestWinView[]> {
    const opponents = await this.opponents(wins.map((win) => win.opponentId));

    return wins.flatMap(({ match, event, opponentId }) => {
      const opponent = opponents.get(opponentId);
      const isA = match.playerAId === id;

      return opponent === undefined
        ? []
        : [
            {
              matchId: match.id,
              tournament: toRef(match.tournament),
              playedAt: match.finishedAt?.toISOString() ?? null,
              opponent,
              opponentRating: event.opponentRating.toString(),
              setsFor: (isA ? match.setsA : match.setsB) ?? 0,
              setsAgainst: (isA ? match.setsB : match.setsA) ?? 0,
              delta: event.delta.toString(),
            },
          ];
    });
  }

  /** Соперники одним запросом: иначе на каждую встречу уходил бы свой. */
  private async opponents(ids: readonly (string | null)[]): Promise<Map<string, PlayerView>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];

    if (unique.length === 0) {
      return new Map();
    }

    const players = await this.prisma.player.findMany({
      where: { id: { in: unique } },
      select: playerFields,
    });

    return new Map(players.map((player) => [player.id, toPlayerView(player)]));
  }

  private async load(id: string): Promise<{ id: string; rating: Prisma.Decimal }> {
    const player = await this.prisma.player.findUnique({
      where: { id },
      select: { id: true, rating: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });
    }

    return player;
  }
}

/** Начало периода статистики; `null` — за всё время. */
export function periodStart(period: PlayerStatsPeriod, now: Date): Date | null {
  const months = { QUARTER: 3, HALF: 6, YEAR: 12, ALL: 0 }[period];

  if (months === 0) {
    return null;
  }

  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - months);

  return start;
}

/**
 * «Чаще всего в»: клуб, где сыграно больше всего турниров. При равенстве —
 * по названию, чтобы ответ не прыгал от запроса к запросу.
 */
export function favoriteClub(
  tournaments: readonly {
    readonly id: string;
    readonly club: { readonly id: string; readonly name: string };
  }[],
): PlayerSummaryView['favoriteClub'] {
  const byClub = new Map<string, { id: string; name: string; tournaments: Set<string> }>();

  for (const tournament of tournaments) {
    const entry = byClub.get(tournament.club.id) ?? { ...tournament.club, tournaments: new Set() };
    entry.tournaments.add(tournament.id);
    byClub.set(tournament.club.id, entry);
  }

  const [best] = [...byClub.values()].sort(
    (left, right) =>
      right.tournaments.size - left.tournaments.size || left.name.localeCompare(right.name),
  );

  return best === undefined
    ? null
    : { id: best.id, name: best.name, tournaments: best.tournaments.size };
}

/** Встреча за места: в неё едут проигравшие, а не победители. */
function takesLosers(source: Prisma.JsonValue): boolean {
  return (
    typeof source === 'object' &&
    source !== null &&
    !Array.isArray(source) &&
    (source as Record<string, unknown>).kind === 'LOSER'
  );
}

function toRef(tournament: { id: string; name: string; startsAt: Date }): TournamentRef {
  return { id: tournament.id, name: tournament.name, startsAt: tournament.startsAt.toISOString() };
}
