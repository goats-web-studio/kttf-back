import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { type Page, pageOf, skipOf } from '../../common/pagination.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type {
  AddMemberInput,
  CreateClubInput,
  ListClubsQuery,
  UpdateClubInput,
} from './clubs.schemas.js';
import type { ClubMemberView, ClubView } from './clubs.types.js';

/**
 * Поля клуба в ответах.
 *
 * `balance` и `tariffId` сюда не входят намеренно: финансы клуба — отдельный
 * эндпоинт 7.4 с отдельными правами, и вытекать они через публичную карточку
 * не должны.
 */
const clubFields = {
  id: true,
  name: true,
  shortName: true,
  city: true,
  address: true,
  lat: true,
  lng: true,
  tableCount: true,
  phone: true,
  whatsapp: true,
  instagram: true,
  logoUrl: true,
  description: true,
  createdAt: true,
} as const;

@Injectable()
export class ClubsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListClubsQuery): Promise<Page<ClubView>> {
    const where = {
      ...(query.city === undefined ? {} : { city: query.city }),
      ...(query.search === undefined
        ? {}
        : { name: { contains: query.search, mode: 'insensitive' as const } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.club.findMany({
        where,
        select: clubFields,
        orderBy: { name: 'asc' },
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.club.count({ where }),
    ]);

    return pageOf(rows.map(toClubView), total, query);
  }

  async findById(id: string): Promise<ClubView> {
    const club = await this.prisma.club.findUnique({ where: { id }, select: clubFields });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id });
    }

    return toClubView(club);
  }

  /**
   * Создание клуба.
   *
   * Создатель сразу становится владельцем: иначе клуб появляется без единого
   * человека, который может им управлять, и назначить владельца некому. Кто
   * вправе создавать клуб, ТЗ не оговаривает — сейчас это любой пользователь
   * с подтверждённым телефоном. Записано как ОВ-13.
   */
  async create(input: CreateClubInput, ownerId: string): Promise<ClubView> {
    const club = await this.prisma.$transaction(async (tx) => {
      const created = await tx.club.create({ data: defined(input), select: clubFields });

      await tx.clubMember.create({
        data: { clubId: created.id, userId: ownerId, role: 'OWNER' },
      });

      return created;
    });

    return toClubView(club);
  }

  async update(id: string, input: UpdateClubInput): Promise<ClubView> {
    await this.findById(id);

    return toClubView(
      await this.prisma.club.update({ where: { id }, data: defined(input), select: clubFields }),
    );
  }

  /** Состав с ролями — ТЗ 3.2, публичная часть страницы клуба. */
  async listMembers(clubId: string): Promise<readonly ClubMemberView[]> {
    await this.findById(clubId);

    const members = await this.prisma.clubMember.findMany({
      where: { clubId },
      select: {
        userId: true,
        role: true,
        user: { select: { player: { select: { id: true, lastName: true, firstName: true } } } },
      },
      orderBy: { role: 'asc' },
    });

    return members.map((member) => ({
      userId: member.userId,
      role: member.role,
      playerId: member.user.player?.id ?? null,
      // Имени может не быть: аккаунт есть, профиль игрока ещё не заполнен.
      name:
        member.user.player === null
          ? null
          : `${member.user.player.lastName} ${member.user.player.firstName}`,
    }));
  }

  async addMember(clubId: string, input: AddMemberInput): Promise<ClubMemberView> {
    await this.findById(clubId);

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });

    if (user === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found', { userId: input.userId });
    }

    // Повторное добавление меняет роль, а не отваливается: с точки зрения
    // владельца это одно и то же действие — «пусть у него будет эта роль».
    await this.prisma.clubMember.upsert({
      where: { clubId_userId: { clubId, userId: input.userId } },
      create: { clubId, userId: input.userId, role: input.role },
      update: { role: input.role },
    });

    const members = await this.listMembers(clubId);
    const member = members.find((candidate) => candidate.userId === input.userId);

    if (member === undefined) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Member vanished right after upsert');
    }

    return member;
  }

  /**
   * Исключение из состава.
   *
   * Последнего владельца исключить нельзя: клуб остался бы без человека,
   * который может назначить нового, и починить это можно было бы только руками
   * в базе.
   */
  async removeMember(clubId: string, userId: string): Promise<void> {
    await this.findById(clubId);

    const member = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } },
      select: { role: true },
    });

    if (member === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Member not found', { clubId, userId });
    }

    if (member.role === 'OWNER') {
      const owners = await this.prisma.clubMember.count({ where: { clubId, role: 'OWNER' } });

      if (owners <= 1) {
        throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot remove the last owner of a club', {
          clubId,
        });
      }
    }

    await this.prisma.clubMember.delete({ where: { clubId_userId: { clubId, userId } } });
  }
}

interface ClubRecord {
  id: string;
  name: string;
  shortName: string | null;
  city: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  tableCount: number;
  phone: string | null;
  whatsapp: string | null;
  instagram: string | null;
  logoUrl: string | null;
  description: string | null;
  createdAt: Date;
}

function toClubView(club: ClubRecord): ClubView {
  return { ...club, createdAt: club.createdAt.toISOString() };
}
