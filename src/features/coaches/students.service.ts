import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  COACH_GROWTH_DAYS,
  COACH_GROWTH_TOP,
  COACH_MEDALS_DAYS,
  COACH_MEDALS_RECENT,
  COACH_STUDENTS_TOP,
  COACH_TOURNAMENTS_RECENT,
  isCoachPublic,
  isNamedStudent,
  type CoachStudentRow,
  type CoachStudentsView,
  type ListCoachStudentsQuery,
  type Page,
  type StudentRef,
  type StudentTournament,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { cityRefFields } from '../places/place.fields.js';
import { followProfileCoach, switchCoach } from '../players/coach-tenure.js';
import { OCCUPYING_STATUSES } from '../tournaments/tournaments.select.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сыгравший на турнире — запись, оставшаяся в составе. На старте такие
 * записи переходят в PLAYING и после завершения в нём остаются; REGISTERED
 * и CONFIRMED — на случай записей, не прошедших через старт (перенос
 * данных). Снятые и не явившиеся не считаются, даже если успели сыграть
 * часть встреч; отклонённые, лист ожидания и заявки не играли вовсе.
 */
const PLAYED_STATUSES = [...OCCUPYING_STATUSES];

const studentFields = {
  id: true,
  lastName: true,
  firstName: true,
  photoUrl: true,
  rating: true,
  birthYear: true,
  createdAt: true,
  coachVisibility: true,
  city: { select: cityRefFields },
} as const satisfies Prisma.PlayerSelect;

type StudentRecord = Prisma.PlayerGetPayload<{ select: typeof studentFields }>;

/**
 * Называется ли ученик на странице тренера: не младше 14 (ADR-059) и не
 * спрятал тренера (ADR-066). Иначе он только в числе учеников — имя
 * в «лучших» раскрыло бы то, что игрок скрыл у себя на профиле.
 */
function isNamed(player: StudentRecord, now: Date): boolean {
  return isNamedStudent(player.birthYear, now) && player.coachVisibility !== 'NONE';
}

function toStudentRef(player: StudentRecord): StudentRef {
  return {
    id: player.id,
    lastName: player.lastName,
    firstName: player.firstName,
    photoUrl: player.photoUrl,
    // Строкой, как везде (ADR-014).
    rating: player.rating.toString(),
    city: player.city,
  };
}

/**
 * Прирост строкой со знаком и сотыми: «+42.10». Только Decimal — через
 * float сумма дельт потеряла бы копейки рейтинга (ADR-014).
 */
export function signedDelta(sum: Prisma.Decimal): string {
  return `${sum.isNegative() ? '' : '+'}${sum.toFixed(2)}`;
}

/** Лучший рост: суммы дельт по игроку, только прирост, сильнейший первым. */
export function bestGrowth(
  sums: readonly { playerId: string; delta: Prisma.Decimal | null }[],
  top: number = COACH_GROWTH_TOP,
): { playerId: string; delta: Prisma.Decimal }[] {
  return sums
    .flatMap((row) =>
      row.delta?.greaterThan(0) === true ? [{ playerId: row.playerId, delta: row.delta }] : [],
    )
    .sort((a, b) => b.delta.comparedTo(a.delta))
    .slice(0, top);
}

/**
 * Ученики тренера — T2 (ADR-059, `docs/11` 3.2.1). Ученик — игрок, у кого
 * этот тренер выбран в анкете (ADR-035); история — `CoachTenure` по
 * игроку-тренеру. Младшие 14 лет публично не называются нигде — только
 * числом (`isNamedStudent`).
 */
@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tournaments: TournamentsService,
  ) {}

  /** Ученики на странице тренера. Неопубликованную видят владелец и администратор. */
  async view(
    coachId: string,
    viewerId: string | undefined,
    now = new Date(),
  ): Promise<CoachStudentsView> {
    const coach = await this.coachOf(coachId);

    if (!coach.public && !(await this.isPrivileged(coach.userId, viewerId))) {
      throw coachNotFound(coachId);
    }

    const current = await this.prisma.player.findMany({
      where: { coachPlayerId: coach.playerId },
      select: studentFields,
    });
    const currentIds = current.map((player) => player.id);
    const named = current.filter((player) => isNamed(player, now));
    const namedById = new Map(named.map((player) => [player.id, player]));

    const [former, medals, growth] = await Promise.all([
      this.prisma.coachTenure.findMany({
        where: {
          coachPlayerId: coach.playerId,
          to: { not: null },
          playerId: { notIn: currentIds },
        },
        distinct: ['playerId'],
        select: { playerId: true },
      }),
      this.medals(coach.playerId, now),
      this.prisma.ratingEvent.groupBy({
        by: ['playerId'],
        where: {
          playerId: { in: [...namedById.keys()] },
          createdAt: { gte: new Date(now.getTime() - COACH_GROWTH_DAYS * DAY_MS) },
        },
        _sum: { delta: true },
      }),
    ]);
    // После медалей, а не параллельно: обе выборки досчитывают места одних и
    // тех же турниров, и вдвоём они записали бы их дважды.
    const tournaments = await this.tournamentsOf(coach.playerId);

    const top = [...named]
      .sort((a, b) => b.rating.comparedTo(a.rating) || a.lastName.localeCompare(b.lastName, 'ru'))
      .slice(0, COACH_STUDENTS_TOP);

    return {
      current: current.length,
      younger: current.filter((player) => !isNamedStudent(player.birthYear, now)).length,
      former: former.length,
      top: top.map(toStudentRef),
      medals: {
        total: medals.length,
        recent: medals
          .flatMap(({ player, place, tournament }) =>
            place === null || !isNamed(player, now) ? [] : [{ player, place, tournament }],
          )
          .slice(0, COACH_MEDALS_RECENT)
          .map(({ player, place, tournament }) => ({
            player: toStudentRef(player),
            place,
            tournament: {
              id: tournament.id,
              name: tournament.name,
              startsAt: tournament.startsAt.toISOString(),
            },
          })),
      },
      growth: bestGrowth(
        growth.map((row) => ({ playerId: row.playerId, delta: row._sum.delta })),
      ).flatMap(({ playerId, delta }) => {
        const player = namedById.get(playerId);

        return player === undefined
          ? []
          : [{ player: toStudentRef(player), delta: signedDelta(delta) }];
      }),
      tournaments,
    };
  }

  /** Все текущие ученики — кабинет тренера. */
  async manage(coachId: string, query: ListCoachStudentsQuery): Promise<Page<CoachStudentRow>> {
    const coach = await this.coachOf(coachId);
    const where = { coachPlayerId: coach.playerId };
    const [rows, total] = await Promise.all([
      this.prisma.player.findMany({
        where,
        select: studentFields,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.player.count({ where }),
    ]);
    const open = await this.prisma.coachTenure.findMany({
      where: {
        coachPlayerId: coach.playerId,
        to: null,
        playerId: { in: rows.map((row) => row.id) },
      },
      select: { playerId: true, from: true },
    });
    const since = new Map(open.map((tenure) => [tenure.playerId, tenure.from]));

    return pageOf(
      rows.map((player) => ({
        player: toStudentRef(player),
        birthYear: player.birthYear,
        // Без открытой записи — с заведения профиля, как при переносе.
        since: (since.get(player.id) ?? player.createdAt).toISOString(),
      })),
      total,
      query,
    );
  }

  /** Тренер убирает чужую ссылку на себя. */
  async remove(coachId: string, playerId: string): Promise<void> {
    const coach = await this.coachOf(coachId);

    await this.unlink(playerId, coach.playerId);
  }

  /** «Я ученик» — вошедший игрок ставит тренера в анкету с его страницы. */
  async join(coachId: string, userId: string): Promise<void> {
    const [coach, player] = await Promise.all([this.coachOf(coachId), this.playerOf(userId)]);

    if (!coach.public) throw coachNotFound(coachId);

    if (player.id === coach.playerId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player cannot be their own coach', {
        field: 'coachId',
      });
    }

    if (player.coachPlayerId === coach.playerId) return;

    await this.prisma.$transaction(async (tx) => {
      // Тренер из списка и вписанный строкой не живут вместе (ADR-035).
      await tx.player.update({
        where: { id: player.id },
        data: { coachPlayerId: coach.playerId, coachName: null },
      });
      await switchCoach(tx, player.id, player.coachPlayerId, coach.playerId);
      await followProfileCoach(tx, player.id, { coachPlayerId: coach.playerId, coachName: null });
    });
  }

  /** Больше не ученик — только у своего текущего тренера. */
  async leave(coachId: string, userId: string): Promise<void> {
    const [coach, player] = await Promise.all([this.coachOf(coachId), this.playerOf(userId)]);

    await this.unlink(player.id, coach.playerId);
  }

  /**
   * Места 1–3 учеников в турнирах, завершённых за окно, — новые первыми.
   * Учеником на турнире считается заявившийся с этим тренером (T3), а не
   * тот, кого он тренирует сегодня. Турниры до ADR-048 мест не записали —
   * досчитываются здесь.
   */
  private async medals(coachPlayerId: string, now: Date) {
    const finished = {
      status: { in: ['FINISHED' as const, 'RATED' as const] },
      finishedAt: { gte: new Date(now.getTime() - COACH_MEDALS_DAYS * DAY_MS) },
    };
    const tournaments = await this.prisma.tournament.findMany({
      where: { ...finished, registrations: { some: { coachPlayerId } } },
      select: { id: true },
    });

    await this.tournaments.ensurePlaces(tournaments.map((tournament) => tournament.id));

    return this.prisma.registration.findMany({
      where: { coachPlayerId, place: { gte: 1, lte: 3 }, tournament: finished },
      select: {
        place: true,
        player: { select: studentFields },
        tournament: { select: { id: true, name: true, startsAt: true, finishedAt: true } },
      },
      orderBy: [{ tournament: { finishedAt: 'desc' } }, { place: 'asc' }],
    });
  }

  /**
   * Последние завершённые турниры, где играли ученики этого тренера (T3), —
   * сколько их было и сколько мест 1–3 они взяли. Делённое место считается
   * по верхней границе (`place`), как в медалях.
   */
  private async tournamentsOf(coachPlayerId: string): Promise<StudentTournament[]> {
    const played = { coachPlayerId, status: { in: PLAYED_STATUSES } };
    const rows = await this.prisma.tournament.findMany({
      where: { status: { in: ['FINISHED', 'RATED'] }, registrations: { some: played } },
      select: { id: true, name: true, startsAt: true },
      orderBy: [{ finishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: COACH_TOURNAMENTS_RECENT,
    });

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);

    await this.tournaments.ensurePlaces(ids);

    const entries = await this.prisma.registration.findMany({
      where: { ...played, tournamentId: { in: ids } },
      select: { tournamentId: true, place: true },
    });

    return rows.map((row) => {
      const own = entries.filter((entry) => entry.tournamentId === row.id);
      const placed = (place: number) => own.filter((entry) => entry.place === place).length;

      return {
        tournament: { id: row.id, name: row.name, startsAt: row.startsAt.toISOString() },
        students: own.length,
        gold: placed(1),
        silver: placed(2),
        bronze: placed(3),
      };
    });
  }

  /** Стереть тренера у игрока, если он — этот тренер; иначе ученика нет. */
  private async unlink(playerId: string, coachPlayerId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.player.updateMany({
        where: { id: playerId, coachPlayerId },
        data: { coachPlayerId: null },
      });

      if (count === 0) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Student not found', { playerId });
      }

      await switchCoach(tx, playerId, coachPlayerId, null);
      await followProfileCoach(tx, playerId, { coachPlayerId: null, coachName: null });
    });
  }

  private async coachOf(
    coachId: string,
  ): Promise<{ playerId: string; userId: string; public: boolean }> {
    const coach = await this.prisma.coach.findUnique({
      where: { id: coachId },
      select: { playerId: true, userId: true, status: true, hiddenAt: true },
    });

    if (coach === null) throw coachNotFound(coachId);

    return {
      playerId: coach.playerId,
      userId: coach.userId,
      public: isCoachPublic({ status: coach.status, hidden: coach.hiddenAt !== null }),
    };
  }

  /** Профиль игрока вошедшего: без него учеником не стать. */
  private async playerOf(userId: string): Promise<{ id: string; coachPlayerId: string | null }> {
    const player = await this.prisma.player.findUnique({
      where: { userId },
      select: { id: true, coachPlayerId: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'A player profile is required');
    }

    return player;
  }

  private async isPrivileged(ownerId: string, viewerId: string | undefined): Promise<boolean> {
    if (viewerId === undefined) return false;
    if (viewerId === ownerId) return true;

    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerId },
      select: { isAdmin: true },
    });

    return viewer?.isAdmin === true;
  }
}

function coachNotFound(id: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { id });
}
