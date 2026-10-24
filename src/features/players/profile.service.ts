import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  Page,
  PlayerAwardView,
  PlayerBestWinsQuery,
  PlayerBestWinsView,
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

import { chainBounds } from './history.js';
import { playerFields, toPlayerView } from './players.service.js';

/** Лучших побед в профиле — как у RTTF, пять строк. */
export const BEST_WINS = 5;

/** Турниры с местами: только у них итог уже определён. */
const CLOSED = ['FINISHED', 'RATED'] as const;

/** Заявка, с которой играли: снятые и отклонённые в число участников не входят. */
const PLAYED = ['REGISTERED', 'CONFIRMED', 'PLAYING'] as const;

const refFields = { id: true, name: true, startsAt: true } as const;

const clubFields = { club: { select: { id: true, name: true } } } as const;

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
    const [above, rankedPlayers, peak, matches, first, awards] = await Promise.all([
      // Место — как в списке рейтинга: равный рейтинг делит место.
      // Анкеты без рейтинга (ADR-072) в рейтинге не стоят и места не занимают.
      this.prisma.player.count({
        where: { rating: { gt: player.rating }, confirmedAt: { not: null } },
      }),
      this.prisma.player.count({ where: { confirmedAt: { not: null } } }),
      // Первое достижение максимума: повторить рекорд — не то же, что его поставить.
      this.prisma.ratingEvent.findFirst({
        where: { playerId: id },
        select: { ratingAfter: true, createdAt: true, tournament: { select: { startsAt: true } } },
        orderBy: [{ ratingAfter: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.match.findMany({
        where: { ...playedBy(id), ...periodFilter(query.period) },
        select: {
          tournamentId: true,
          playerAId: true,
          setsA: true,
          setsB: true,
          tournament: { select: { ...refFields, ...clubFields } },
        },
      }),
      this.prisma.tournament.findFirst({
        where: { matches: { some: playedBy(id) } },
        select: refFields,
        orderBy: { startsAt: 'asc' },
      }),
      this.awards(id),
    ]);

    // Рейтинг выше журнала бывает только без журнала: стартовый у новичка.
    const record = peak !== null && !player.rating.greaterThan(peak.ratingAfter) ? peak : null;
    const wins = matches.filter((match) => wonBy(match, id)).length;

    return {
      playerId: id,
      rank: above + 1,
      rankedPlayers,
      maxRating: (record?.ratingAfter ?? player.rating).toString(),
      // Дата — как у точки графика: старт турнира, у корректировки — запись.
      maxRatingAt:
        record === null ? null : (record.tournament?.startsAt ?? record.createdAt).toISOString(),
      period: query.period,
      tournaments: new Set(matches.map((match) => match.tournamentId)).size,
      wins,
      losses: matches.length - wins,
      firstTournament: first === null ? null : toRef(first),
      favoriteClub: favoriteClub(matches.map((match) => match.tournament)),
      awards,
    };
  }

  /**
   * Лучшие победы за период — ADR-050. Свой запрос, а не поле сводки: у
   * блока свои вкладки периода, и сводка ради них пересчитывалась бы целиком.
   */
  async bestWins(id: string, query: PlayerBestWinsQuery): Promise<PlayerBestWinsView> {
    await this.load(id);

    const matches = await this.prisma.match.findMany({
      where: { ...playedBy(id), ...periodFilter(query.period) },
      select: {
        id: true,
        playerAId: true,
        playerBId: true,
        setsA: true,
        setsB: true,
        startedAt: true,
        finishedAt: true,
        tournament: { select: refFields },
        ratingEvents: {
          where: { playerId: id },
          select: { delta: true, ratingBefore: true, opponentRating: true },
        },
      },
    });

    const wins = matches
      .filter((match) => wonBy(match, id))
      .flatMap((match) => {
        const event = match.ratingEvents[0];
        const opponentId = match.playerAId === id ? match.playerBId : match.playerAId;

        // Победа без рейтинга соперника — вне зачёта: сравнивать её не с чем.
        return event?.opponentRating == null || opponentId === null
          ? []
          : [{ match, event, opponentRating: event.opponentRating, opponentId }];
      })
      .sort(
        (left, right) =>
          right.opponentRating.comparedTo(left.opponentRating) ||
          // Равные по силе — свежая выше: порядок не прыгает от запроса к запросу.
          (right.match.finishedAt?.getTime() ?? 0) - (left.match.finishedAt?.getTime() ?? 0),
      )
      .slice(0, BEST_WINS);

    const opponents = await this.opponents(wins.map((win) => win.opponentId));

    return {
      period: query.period,
      items: wins.flatMap(({ match, event, opponentRating, opponentId }): PlayerBestWinView[] => {
        const opponent = opponents.get(opponentId);
        const isA = match.playerAId === id;

        return opponent === undefined
          ? []
          : [
              {
                matchId: match.id,
                tournament: toRef(match.tournament),
                startedAt: match.startedAt?.toISOString() ?? null,
                playedAt: match.finishedAt?.toISOString() ?? null,
                ratingBefore: event.ratingBefore.toString(),
                opponent,
                opponentRating: opponentRating.toString(),
                setsFor: (isA ? match.setsA : match.setsB) ?? 0,
                setsAgainst: (isA ? match.setsB : match.setsA) ?? 0,
                delta: event.delta.toString(),
                durationMinutes: durationMinutes(match.startedAt, match.finishedAt),
              },
            ];
      }),
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
      select: { ...refFields, status: true, level: true, ...clubFields },
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
          startedAt: true,
          finishedAt: true,
          bracketRound: true,
          sourceA: true,
          sourceB: true,
          stage: { select: { name: true, type: true } },
          group: { select: { label: true } },
          ratingEvents: {
            where: { playerId: id },
            select: { delta: true, ratingBefore: true, opponentRating: true },
          },
        },
        orderBy: [{ finishedAt: { sort: 'asc', nulls: 'last' } }],
      }),
      this.prisma.ratingEvent.findMany({
        where: { playerId: id, tournamentId: { in: pageIds } },
        select: { tournamentId: true, ratingBefore: true, delta: true, ratingAfter: true },
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

    const opponentIds = matches.map((match) =>
      match.playerAId === id ? match.playerBId : match.playerAId,
    );
    const [opponents, opponentStarts] = await Promise.all([
      this.opponents(opponentIds),
      // Рейтинг соперника на старте — пока турнир не обсчитан, журнала нет,
      // а колонка «рейтинг соперника» пустой быть не должна.
      this.prisma.registration.findMany({
        where: {
          tournamentId: { in: pageIds },
          playerId: { in: [...new Set(opponentIds.filter((other) => other !== null))] },
        },
        select: { tournamentId: true, playerId: true, ratingAtStart: true },
      }),
    ]);
    const startOf = new Map(
      opponentStarts.map((row) => [`${row.tournamentId}:${row.playerId}`, row.ratingAtStart]),
    );
    const finalOf = new Map(finals.map((row) => [row.stageId, row._max.bracketRound ?? 1]));
    const sizeOf = new Map(sizes.map((row) => [row.tournamentId, row._count._all]));
    const registrationOf = new Map(registrations.map((row) => [row.tournamentId, row]));

    const items = page.map((tournament): PlayerTournamentView => {
      const registration = registrationOf.get(tournament.id);
      const own = events.filter((event) => event.tournamentId === tournament.id);
      const delta = own.reduce((sum, event) => sum.plus(event.delta), new Prisma.Decimal(0));

      return {
        tournament: {
          ...toRef(tournament),
          status: tournament.status,
          level: tournament.level,
          club: tournament.club,
        },
        place: registration?.place ?? null,
        placeTo: registration?.placeTo ?? null,
        participants: sizeOf.get(tournament.id) ?? 0,
        ratingBefore: registration?.ratingAtStart?.toString() ?? null,
        // Дельты нет, пока турнир не обсчитан (ТЗ 7.3): ноль бы врал.
        delta: own.length === 0 ? null : delta.toFixed(2),
        // Конец цепочки, а не последняя по времени запись: журнал турнира
        // пишется одной пачкой с одинаковым `createdAt`, и «последняя» по нему
        // — случайная (та же причина, что в истории рейтинга).
        ratingAfter: own.length === 0 ? null : chainBounds(own).after.toString(),
        matches: matches
          .filter((match) => match.tournamentId === tournament.id)
          .map((match): PlayerTournamentMatchView => {
            const isA = match.playerAId === id;
            const setsFor = (isA ? match.setsA : match.setsB) ?? 0;
            const setsAgainst = (isA ? match.setsB : match.setsA) ?? 0;
            const opponentId = isA ? match.playerBId : match.playerAId;
            const bracket = (BRACKETS as readonly string[]).includes(match.stage.type);
            const placement = bracket && (takesLosers(match.sourceA) || takesLosers(match.sourceB));
            const event = match.ratingEvents[0];
            const opponentRating =
              event?.opponentRating ??
              (opponentId === null ? null : startOf.get(`${tournament.id}:${opponentId}`)) ??
              null;

            return {
              matchId: match.id,
              stageName: match.stage.name,
              groupLabel: match.group?.label ?? null,
              roundFromFinal:
                !bracket || match.bracketRound === null || placement
                  ? null
                  : Math.max(0, (finalOf.get(match.stageId) ?? 1) - match.bracketRound),
              placement,
              startedAt: match.startedAt?.toISOString() ?? null,
              playedAt: match.finishedAt?.toISOString() ?? null,
              opponent: opponentId === null ? null : (opponents.get(opponentId) ?? null),
              opponentRating: opponentRating?.toString() ?? null,
              ratingBefore: event?.ratingBefore.toString() ?? null,
              setsFor,
              setsAgainst,
              won: setsFor > setsAgainst,
              resultType: match.resultType,
              delta: event?.delta.toString() ?? null,
              durationMinutes: durationMinutes(match.startedAt, match.finishedAt),
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
      select: { place: true, tournament: { select: { ...refFields, ...clubFields } } },
      orderBy: { tournament: { startsAt: 'desc' } },
    });

    return prized.flatMap((row) =>
      row.place === null
        ? []
        : [{ tournament: toRef(row.tournament), club: row.tournament.club, place: row.place }],
    );
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

/** Условие периода на встречи — по дате турнира, как в статистике. */
function periodFilter(period: PlayerStatsPeriod): { tournament?: { startsAt: { gte: Date } } } {
  const since = periodStart(period, new Date());

  return since === null ? {} : { tournament: { startsAt: { gte: since } } };
}

function wonBy(
  match: { playerAId: string | null; setsA: number | null; setsB: number | null },
  id: string,
): boolean {
  const isA = match.playerAId === id;

  return ((isA ? match.setsA : match.setsB) ?? 0) > ((isA ? match.setsB : match.setsA) ?? 0);
}

/**
 * Длительность встречи в минутах — от вызова к столу до счёта (ADR-050).
 *
 * `null`, если встречу внесли без вызова к столу или конец раньше начала:
 * счёт, введённый офлайн задним числом, мог лечь раньше вызова. Ноль в таком
 * случае врал бы — встреча не длилась ноль минут.
 */
export function durationMinutes(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (startedAt === null || finishedAt === null) {
    return null;
  }

  const ms = finishedAt.getTime() - startedAt.getTime();

  return ms < 0 ? null : Math.round(ms / 60_000);
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
