import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  clubCoachAwaits,
  type ClubCoachStatus,
  type ClubCoachView,
  type ClubStaffManageView,
  type InviteClubCoachInput,
  type RequestClubCoachInput,
  type UpdateClubCoachInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import {
  CLUB_COACH_ORDER,
  PUBLIC_COACH,
  clubCoachFields,
  toClubCoachView,
  type ClubCoachRecord,
} from './training-view.js';

/** Пара «клуб — тренер» штаба. */
export interface StaffPair {
  readonly clubId: string;
  readonly coachId: string;
}

/**
 * Подтверждённая тренировка в клубе добавляет тренера в штаб сама
 * (ADR-059, T2). Операции — для транзакции вызывающего: новая связь
 * заводится `ACTIVE`, ждущая ответа становится `ACTIVE`; должность не
 * трогается — её ведёт клуб.
 */
export function staffFromTrainings(
  prisma: Pick<PrismaService, 'clubCoach'>,
  pairs: readonly StaffPair[],
  now: Date = new Date(),
): Prisma.PrismaPromise<unknown>[] {
  const unique = [
    ...new Map(pairs.map((pair) => [`${pair.clubId}:${pair.coachId}`, pair])).values(),
  ];

  if (unique.length === 0) return [];

  return [
    prisma.clubCoach.createMany({
      data: unique.map((pair) => ({
        ...pair,
        status: 'ACTIVE' as const,
        requestedAt: now,
        confirmedAt: now,
      })),
      skipDuplicates: true,
    }),
    ...unique.map((pair) =>
      prisma.clubCoach.updateMany({
        where: { ...pair, status: { not: 'ACTIVE' } },
        data: { status: 'ACTIVE', confirmedAt: now },
      }),
    ),
  ];
}

/** Статус новой связи по стороне, которая её завела. */
const PROPOSED: Readonly<Record<'CLUB' | 'COACH', ClubCoachStatus>> = {
  // Клуб приглашает — ждёт тренер; тренер просится — ждёт клуб.
  CLUB: 'INVITED_BY_CLUB',
  COACH: 'REQUESTED_BY_COACH',
};

/**
 * Тренерский штаб клуба — T2 (ADR-059, решение владельца от 21.10.2026).
 * Заводит любая сторона, вторая подтверждает; встречный запрос — тоже
 * подтверждение. Разорвать может любая сторона; тренировки не трогаются.
 */
@Injectable()
export class ClubStaffService {
  constructor(private readonly prisma: PrismaService) {}

  /** Клуб приглашает тренера — только с опубликованной страницей. */
  async invite(clubId: string, input: InviteClubCoachInput): Promise<ClubCoachView> {
    const coach = await this.prisma.coach.findFirst({
      where: { id: input.coachId, ...PUBLIC_COACH },
      select: { id: true },
    });

    if (coach === null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Coach is unknown or not published', {
        field: 'coachId',
      });
    }

    return this.propose({ clubId, coachId: input.coachId }, 'CLUB', input.position);
  }

  /** Тренер просится в клуб — только в не скрытый. */
  async request(coachId: string, input: RequestClubCoachInput): Promise<ClubCoachView> {
    const club = await this.prisma.club.findFirst({
      where: { id: input.clubId, hiddenAt: null },
      select: { id: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Club is unknown or hidden', {
        field: 'clubId',
      });
    }

    return this.propose({ clubId: input.clubId, coachId }, 'COACH', input.position);
  }

  /** Вторая сторона подтверждает: OWNER или ORGANIZER клуба либо владелец страницы. */
  async confirm(pair: StaffPair, userId: string, now = new Date()): Promise<ClubCoachView> {
    const link = await this.load(pair);
    const sides = await this.sidesOf(link, userId);

    if (!sides.admin && !sides.club && !sides.coach) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the club or the coach answers', {
        ...pair,
      });
    }

    // Администратор — за любую сторону; остальные — только за ту, что ждут.
    const awaited =
      link.status !== 'ACTIVE' &&
      (sides.admin ||
        (sides.club && clubCoachAwaits(link.status, 'CLUB')) ||
        (sides.coach && clubCoachAwaits(link.status, 'COACH')));

    if (!awaited) throw invalid(link.status);

    const { count } = await this.prisma.clubCoach.updateMany({
      where: { ...pair, status: link.status },
      data: { status: 'ACTIVE', confirmedAt: now },
    });

    if (count === 0) throw invalid((await this.load(pair)).status);

    return toClubCoachView(await this.load(pair));
  }

  /** Разорвать — любая сторона или администратор, в любом статусе. */
  async remove(pair: StaffPair, userId: string): Promise<void> {
    const link = await this.load(pair);
    const sides = await this.sidesOf(link, userId);

    if (!sides.admin && !sides.club && !sides.coach) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the club or the coach removes', {
        ...pair,
      });
    }

    await this.prisma.clubCoach.deleteMany({ where: pair });
  }

  /** Должность ведёт клуб. */
  async setPosition(pair: StaffPair, input: UpdateClubCoachInput): Promise<ClubCoachView> {
    await this.load(pair);

    return toClubCoachView(
      await this.prisma.clubCoach.update({
        where: { clubId_coachId: pair },
        data: { position: input.position },
        select: clubCoachFields,
      }),
    );
  }

  /** Штаб на странице клуба: состав с опубликованными страницами тренеров. */
  async forClub(clubId: string): Promise<ClubCoachView[]> {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { hiddenAt: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });
    }

    if (club.hiddenAt !== null) return [];

    const links = await this.prisma.clubCoach.findMany({
      where: { clubId, status: 'ACTIVE', coach: { is: PUBLIC_COACH } },
      select: clubCoachFields,
      orderBy: [...CLUB_COACH_ORDER],
    });

    return links.map(toClubCoachView);
  }

  /** Штаб в кабинете клуба: состав, приглашённые и запросы тренеров — как есть. */
  async manage(clubId: string): Promise<ClubStaffManageView> {
    const links = await this.prisma.clubCoach.findMany({
      where: { clubId },
      select: clubCoachFields,
      orderBy: [...CLUB_COACH_ORDER],
    });
    const pick = (status: ClubCoachStatus) =>
      links.filter((link) => link.status === status).map(toClubCoachView);

    return {
      active: pick('ACTIVE'),
      invited: pick('INVITED_BY_CLUB'),
      requests: pick('REQUESTED_BY_COACH'),
    };
  }

  /**
   * Предложение одной из сторон. Связи нет — заводится и ждёт вторую
   * сторону. Вторая сторона уже просила — встречное предложение и есть
   * согласие. Уже в штабе или уже ждёт ответа — отказ.
   */
  private async propose(
    pair: StaffPair,
    side: 'CLUB' | 'COACH',
    position: string | null | undefined,
  ): Promise<ClubCoachView> {
    const existing = await this.prisma.clubCoach.findUnique({
      where: { clubId_coachId: pair },
      select: { status: true },
    });

    if (existing === null) {
      return toClubCoachView(
        await this.prisma.clubCoach.create({
          data: { ...pair, status: PROPOSED[side], position: position ?? null },
          select: clubCoachFields,
        }),
      );
    }

    if (!clubCoachAwaits(existing.status, side)) throw invalid(existing.status);

    const { count } = await this.prisma.clubCoach.updateMany({
      where: { ...pair, status: existing.status },
      data: {
        status: 'ACTIVE',
        confirmedAt: new Date(),
        ...(position === undefined ? {} : { position }),
      },
    });

    if (count === 0) throw invalid((await this.load(pair)).status);

    return toClubCoachView(await this.load(pair));
  }

  private async sidesOf(
    link: ClubCoachRecord,
    userId: string,
  ): Promise<{ admin: boolean; club: boolean; coach: boolean }> {
    const [user, member] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
      this.prisma.clubMember.findUnique({
        where: { clubId_userId: { clubId: link.clubId, userId } },
        select: { role: true },
      }),
    ]);

    return {
      admin: user?.isAdmin === true,
      club: member?.role === 'OWNER' || member?.role === 'ORGANIZER',
      coach: link.coach.userId === userId,
    };
  }

  private async load(pair: StaffPair): Promise<ClubCoachRecord> {
    const link = await this.prisma.clubCoach.findUnique({
      where: { clubId_coachId: pair },
      select: clubCoachFields,
    });

    if (link === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club coach link not found', { ...pair });
    }

    return link;
  }
}

function invalid(status: ClubCoachStatus): AppError {
  return new AppError(ERROR_CODES.CLUB_COACH_INVALID, 'Link does not wait for this side', {
    status,
  });
}
