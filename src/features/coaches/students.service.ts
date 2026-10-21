import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  COACH_GROWTH_DAYS,
  COACH_GROWTH_TOP,
  COACH_MEDALS_DAYS,
  COACH_MEDALS_RECENT,
  COACH_STUDENTS_TOP,
  isCoachPublic,
  isNamedStudent,
  type CoachStudentRow,
  type CoachStudentsView,
  type ListCoachStudentsQuery,
  type Page,
  type StudentRef,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { cityRefFields } from '../places/place.fields.js';
import { followProfileCoach, switchCoach } from '../players/coach-tenure.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const studentFields = {
  id: true,
  lastName: true,
  firstName: true,
  photoUrl: true,
  rating: true,
  birthYear: true,
  createdAt: true,
  city: { select: cityRefFields },
} as const satisfies Prisma.PlayerSelect;

type StudentRecord = Prisma.PlayerGetPayload<{ select: typeof studentFields }>;

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
    const named = current.filter((player) => isNamedStudent(player.birthYear, now));
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
      this.medals(currentIds, now),
      this.prisma.ratingEvent.groupBy({
        by: ['playerId'],
        where: {
          playerId: { in: [...namedById.keys()] },
          createdAt: { gte: new Date(now.getTime() - COACH_GROWTH_DAYS * DAY_MS) },
        },
        _sum: { delta: true },
      }),
    ]);

    const top = [...named]
      .sort((a, b) => b.rating.comparedTo(a.rating) || a.lastName.localeCompare(b.lastName, 'ru'))
      .slice(0, COACH_STUDENTS_TOP);

    return {
      current: current.length,
      younger: current.length - named.length,
      former: former.length,
      top: top.map(toStudentRef),
      medals: {
        total: medals.length,
        recent: medals
          .flatMap((medal) => {
            const player = namedById.get(medal.playerId);

            return player === undefined || medal.place === null ? [] : [{ medal, player }];
          })
          .slice(0, COACH_MEDALS_RECENT)
          .map(({ medal, player }) => ({
            player: toStudentRef(player),
            place: medal.place ?? 1,
            tournament: {
              id: medal.tournament.id,
              name: medal.tournament.name,
              startsAt: medal.tournament.startsAt.toISOString(),
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
   * Места 1–3 у текущих учеников в турнирах, завершённых за окно, — новые
   * первыми. Турниры до ADR-048 мест не записали — досчитываются здесь.
   */
  private async medals(playerIds: readonly string[], now: Date) {
    if (playerIds.length === 0) return [];

    const finished = {
      status: { in: ['FINISHED' as const, 'RATED' as const] },
      finishedAt: { gte: new Date(now.getTime() - COACH_MEDALS_DAYS * DAY_MS) },
    };
    const tournaments = await this.prisma.tournament.findMany({
      where: { ...finished, registrations: { some: { playerId: { in: [...playerIds] } } } },
      select: { id: true },
    });

    await this.tournaments.ensurePlaces(tournaments.map((tournament) => tournament.id));

    return this.prisma.registration.findMany({
      where: {
        playerId: { in: [...playerIds] },
        place: { gte: 1, lte: 3 },
        tournament: finished,
      },
      select: {
        playerId: true,
        place: true,
        tournament: { select: { id: true, name: true, startsAt: true, finishedAt: true } },
      },
      orderBy: [{ tournament: { finishedAt: 'desc' } }, { place: 'asc' }],
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
