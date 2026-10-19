import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CLUB_SUMMARY_DAYS,
  CLUB_SUMMARY_PODIUMS,
  type ClubSummaryView,
  type ClubView,
  type SetClubHoursInput,
  type SetClubPricesInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { OCCUPYING_STATUSES } from '../tournaments/tournaments.select.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';
import { clubFields, toClubView } from './club-view.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Страница клуба — ADR-055: часы, цены, свежесть, скрытие и живые данные.
 *
 * Часы и цены правятся целиком: форма в кабинете отправляет неделю и прайс
 * разом, а сервер заменяет строки одной транзакцией. Правка по строке
 * потребовала бы идентификаторов, порядка и слияния — ради списка из
 * десятка строк это лишнее.
 */
@Injectable()
export class ClubPageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tournaments: TournamentsService,
  ) {}

  async setHours(clubId: string, input: SetClubHoursInput): Promise<ClubView> {
    await this.assertExists(clubId);

    const [, , club] = await this.prisma.$transaction([
      this.prisma.clubHours.deleteMany({ where: { clubId } }),
      this.prisma.clubHours.createMany({
        data: input.hours.map((interval) => ({ clubId, ...interval })),
      }),
      this.touch(clubId),
    ]);

    return toClubView(club);
  }

  async setPrices(clubId: string, input: SetClubPricesInput): Promise<ClubView> {
    await this.assertExists(clubId);

    const [, , club] = await this.prisma.$transaction([
      this.prisma.clubPrice.deleteMany({ where: { clubId } }),
      this.prisma.clubPrice.createMany({
        data: input.prices.map((price, index) => ({
          clubId,
          kind: price.kind,
          title: price.title,
          priceKzt: price.priceKzt,
          unit: price.unit,
          note: price.note ?? null,
          sortOrder: index,
        })),
      }),
      this.touch(clubId),
    ]);

    return toClubView(club);
  }

  /** «Всё актуально»: клуб проверил страницу и ничего не менял. */
  async markReviewed(clubId: string): Promise<ClubView> {
    await this.assertExists(clubId);

    return toClubView(await this.touch(clubId));
  }

  /** Скрыть из каталога или вернуть — администратор (ADR-055, модерация). */
  async setHidden(clubId: string, hidden: boolean): Promise<ClubView> {
    await this.assertExists(clubId);

    return toClubView(
      await this.prisma.club.update({
        where: { id: clubId },
        data: { hiddenAt: hidden ? new Date() : null },
        select: clubFields,
      }),
    );
  }

  /**
   * Живые данные клуба — то, что у RTTF заполняется вручную (ADR-055,
   * решение 1).
   *
   * Встреча считается по времени окончания: турнир, начатый месяц назад
   * и доигранный вчера, — это вчерашние встречи. Встречи без отметки
   * окончания (внесённые задним числом) в окно не попадают — честнее
   * недосчитать, чем приписать их сегодняшнему дню.
   */
  async summary(clubId: string, now: Date = new Date()): Promise<ClubSummaryView> {
    await this.assertExists(clubId);

    const since = new Date(now.getTime() - CLUB_SUMMARY_DAYS * DAY_MS);
    const recentMatch = {
      tournament: { clubId },
      status: 'FINISHED' as const,
      finishedAt: { gte: since },
    };

    const [sides, tournamentsHeld, finished] = await Promise.all([
      this.prisma.match.findMany({
        where: recentMatch,
        select: { playerAId: true, playerBId: true },
      }),
      this.prisma.tournament.count({ where: { clubId, status: { in: ['FINISHED', 'RATED'] } } }),
      this.prisma.tournament.findMany({
        where: { clubId, status: { in: ['FINISHED', 'RATED'] } },
        orderBy: { startsAt: 'desc' },
        take: CLUB_SUMMARY_PODIUMS,
        select: { id: true },
      }),
    ]);

    // Турниры, завершённые до ADR-048, мест не записали — досчитываются здесь.
    await this.tournaments.ensurePlaces(finished.map((tournament) => tournament.id));

    const podiums = await this.prisma.tournament.findMany({
      where: { id: { in: finished.map((tournament) => tournament.id) } },
      orderBy: { startsAt: 'desc' },
      select: {
        id: true,
        name: true,
        startsAt: true,
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

    const players = new Set<string>();

    for (const side of sides) {
      if (side.playerAId !== null) players.add(side.playerAId);
      if (side.playerBId !== null) players.add(side.playerBId);
    }

    return {
      matchesRecent: sides.length,
      activePlayersRecent: players.size,
      tournamentsHeld,
      podiums: podiums.map((tournament) => ({
        tournamentId: tournament.id,
        name: tournament.name,
        startsAt: tournament.startsAt.toISOString(),
        participants: tournament._count.registrations,
        places: tournament.registrations.flatMap((registration) =>
          registration.place === null
            ? []
            : [
                {
                  place: registration.place,
                  placeTo: registration.placeTo,
                  playerId: registration.player.id,
                  name: `${registration.player.lastName} ${registration.player.firstName}`,
                },
              ],
        ),
      })),
    };
  }

  private touch(clubId: string) {
    return this.prisma.club.update({
      where: { id: clubId },
      data: { profileReviewedAt: new Date() },
      select: clubFields,
    });
  }

  private async assertExists(clubId: string): Promise<void> {
    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });
    }
  }
}
