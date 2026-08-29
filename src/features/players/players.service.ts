import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { type Page, pageOf, skipOf } from '../../common/pagination.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { CreatePlayerInput, ListPlayersQuery, UpdatePlayerInput } from './players.schemas.js';
import type { PlayerView } from './players.types.js';

const playerFields = {
  id: true,
  userId: true,
  lastName: true,
  firstName: true,
  middleName: true,
  birthYear: true,
  gender: true,
  city: true,
  photoUrl: true,
  clubId: true,
  rating: true,
  ratedMatches: true,
  isProvisional: true,
  createdAt: true,
} as const;

@Injectable()
export class PlayersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListPlayersQuery): Promise<Page<PlayerView>> {
    const where = {
      ...(query.city === undefined ? {} : { city: query.city }),
      ...(query.clubId === undefined ? {} : { clubId: query.clubId }),
      ...(query.search === undefined
        ? {}
        : {
            // Поиск идёт по фамилии и имени раздельно: составное поле в базе
            // не хранится, а искать по нему люди будут и так, и так.
            OR: [
              { lastName: { contains: query.search, mode: 'insensitive' as const } },
              { firstName: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.player.findMany({
        where,
        select: playerFields,
        // По рейтингу вниз: список игроков читают как таблицу силы.
        orderBy: [{ rating: 'desc' }, { lastName: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.player.count({ where }),
    ]);

    return pageOf(rows.map(toPlayerView), total, query);
  }

  async findById(id: string): Promise<PlayerView> {
    const player = await this.prisma.player.findUnique({ where: { id }, select: playerFields });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });
    }

    return toPlayerView(player);
  }

  /**
   * Заведение игрока — ТС 7.2.
   *
   * Контракт описывает этот маршрут как «создание организатором», но другого
   * способа завести профиль в нём нет, а ТЗ 2.2 требует профиль при
   * регистрации. Поэтому маршрут закрывает оба случая, и какой из них — решает
   * наличие профиля у вызывающего. Расхождение записано как ОВ-14.
   *
   * 1. У вызывающего профиля ещё нет — заводится его собственный, `userId`
   *    проставляется. Это регистрация по ТЗ 2.2
   * 2. Профиль есть — заводится чужой, без аккаунта, и тогда вызывающий обязан
   *    быть владельцем или организатором указанного клуба. `userId` остаётся
   *    пустым: это штатное состояние по комментарию к модели, связывание
   *    произойдёт, когда человек войдёт по своему телефону
   *
   * Рейтинг не задаётся: он проекция журнала (ТС 1.4), а вопрос о стартовом
   * значении открыт (ОВ-2). До его решения действует умолчание схемы.
   */
  async create(input: CreatePlayerInput, actorId: string): Promise<PlayerView> {
    await this.assertClubExists(input.clubId);

    const own = await this.prisma.player.findUnique({
      where: { userId: actorId },
      select: { id: true },
    });

    if (own !== null) {
      if (input.clubId === undefined) {
        throw new AppError(
          ERROR_CODES.FORBIDDEN,
          'Creating a player for someone else requires a club',
        );
      }

      await this.assertClubStaff(input.clubId, actorId);
    }

    return toPlayerView(
      await this.prisma.player.create({
        data: { ...defined(input), ...(own === null ? { userId: actorId } : {}) },
        select: playerFields,
      }),
    );
  }

  async update(id: string, input: UpdatePlayerInput): Promise<PlayerView> {
    await this.findById(id);
    await this.assertClubExists(input.clubId);

    return toPlayerView(
      await this.prisma.player.update({
        where: { id },
        data: defined(input),
        select: playerFields,
      }),
    );
  }

  /**
   * Кто вправе править профиль: сам игрок или организатор его клуба.
   *
   * Проверка живёт в сервисе, а не в guard'е: она зависит от клуба, который
   * записан у игрока, а не от параметра маршрута. Guard'у пришлось бы читать
   * ту же строку из базы, и проверка раздвоилась бы.
   */
  async assertCanEdit(playerId: string, userId: string): Promise<void> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { userId: true, clubId: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id: playerId });
    }

    if (player.userId === userId) return;

    if (player.clubId !== null && (await this.isClubStaff(player.clubId, userId))) return;

    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not allowed to edit this player', { id: playerId });
  }

  /**
   * Владелец или организатор клуба.
   *
   * Судья не в счёт: по ТЗ 1 он ведёт конкретный турнир, управление клубом в
   * его доступ не входит.
   */
  private async isClubStaff(clubId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } },
      select: { role: true },
    });

    return membership !== null && membership.role !== 'REFEREE';
  }

  private async assertClubStaff(clubId: string, userId: string): Promise<void> {
    if (!(await this.isClubStaff(clubId, userId))) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Insufficient club role', { clubId });
    }
  }

  /** Ссылка на несуществующий клуб иначе упала бы отказом внешнего ключа. */
  private async assertClubExists(clubId: string | undefined): Promise<void> {
    if (clubId === undefined) return;

    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { clubId });
    }
  }
}

interface PlayerRecord {
  id: string;
  userId: string | null;
  lastName: string;
  firstName: string;
  middleName: string | null;
  birthYear: number;
  gender: string;
  city: string;
  photoUrl: string | null;
  clubId: string | null;
  rating: { toString: () => string };
  ratedMatches: number;
  isProvisional: boolean;
  createdAt: Date;
}

function toPlayerView(player: PlayerRecord): PlayerView {
  return {
    id: player.id,
    userId: player.userId,
    lastName: player.lastName,
    firstName: player.firstName,
    middleName: player.middleName,
    birthYear: player.birthYear,
    gender: player.gender,
    city: player.city,
    photoUrl: player.photoUrl,
    clubId: player.clubId,
    // Рейтинг приходит из Decimal и уезжает строкой. Через number он потерял
    // бы точность — а бриф ставит корректность рейтинга приоритетом №1.
    rating: player.rating.toString(),
    ratedMatches: player.ratedMatches,
    isProvisional: player.isProvisional,
    createdAt: player.createdAt.toISOString(),
  };
}
