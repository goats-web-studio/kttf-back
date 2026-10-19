import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { PHONE_PATTERN } from '@kttf/shared/types';
import type {
  AddMemberInput,
  ClubListItemView,
  ClubMemberView,
  ClubView,
  CreateClubInput,
  ListClubsQuery,
  Page,
  UpdateClubInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PlacesService } from '../places/places.service.js';
import { clubFields, toClubView } from './club-view.js';
import { nextTournaments } from './next-tournaments.js';

/**
 * Сколько клубов список упорядочивает в памяти.
 *
 * Порядок «ближайший турнир, затем свежесть страницы» не выражается одним
 * `orderBy`: ближайший турнир — агрегат по другой таблице. Клубов в продукте
 * десятки, их заводит администратор (ADR-049), поэтому список берётся целиком
 * и режется на страницы после сортировки. Потолок — страховка, а не план.
 */
const LIST_SCAN_MAX = 2000;

@Injectable()
export class ClubsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly places: PlacesService,
  ) {}

  /**
   * Каталог клубов — ADR-055, `docs/09` 5.1.
   *
   * Сначала клубы с ближайшим турниром — по его дате, затем по свежести
   * страницы, затем по названию. Свежесть в порядке — это то, что заставляет
   * клуб обновлять страницу. Скрытые администратором клубы в каталог не
   * попадают.
   */
  async list(query: ListClubsQuery): Promise<Page<ClubListItemView>> {
    const where: Prisma.ClubWhereInput = {
      hiddenAt: null,
      ...(query.cityId === undefined ? {} : { cityId: { in: query.cityId } }),
      ...(query.search === undefined
        ? {}
        : { name: { contains: query.search, mode: 'insensitive' as const } }),
      ...(query.amenities === undefined ? {} : { amenities: { hasEvery: query.amenities } }),
    };

    const candidates = await this.prisma.club.findMany({
      where,
      select: { id: true, name: true, profileReviewedAt: true },
      take: LIST_SCAN_MAX,
    });
    const next = await nextTournaments(
      this.prisma,
      candidates.map((club) => club.id),
      new Date(),
    );

    const ordered = candidates
      .filter((club) => query.upcoming !== true || next.has(club.id))
      .sort((a, b) => {
        const nextA = next.get(a.id)?.getTime() ?? Number.POSITIVE_INFINITY;
        const nextB = next.get(b.id)?.getTime() ?? Number.POSITIVE_INFINITY;

        if (nextA !== nextB) return nextA < nextB ? -1 : 1;

        const reviewedA = a.profileReviewedAt?.getTime() ?? 0;
        const reviewedB = b.profileReviewedAt?.getTime() ?? 0;

        if (reviewedA !== reviewedB) return reviewedB - reviewedA;

        return a.name.localeCompare(b.name, 'ru');
      });

    const pageIds = ordered
      .slice(skipOf(query), skipOf(query) + query.limit)
      .map((club) => club.id);
    const rows = await this.prisma.club.findMany({
      where: { id: { in: pageIds } },
      select: clubFields,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    const items = pageIds.flatMap((id) => {
      const row = byId.get(id);

      return row === undefined
        ? []
        : [{ ...toClubView(row), nextTournamentAt: next.get(id)?.toISOString() ?? null }];
    });

    return pageOf(items, ordered.length, query);
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
    await this.places.assertCityAvailable(input.cityId);

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
    const current = await this.findById(id);
    await this.places.assertCityAvailable(input.cityId, current.city.id);

    // Сохранённая страница — свежая страница: отметка «обновлено» ставится сама.
    return toClubView(
      await this.prisma.club.update({
        where: { id },
        data: { ...defined(input), profileReviewedAt: new Date() },
        select: clubFields,
      }),
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

  /**
   * Добавление в состав — ТЗ 1, ADR-043.
   *
   * Человек ищется тем же правилом, что и при входе: строка в формате
   * телефона — телефон, иначе логин. Повторное добавление меняет роль, а не
   * отваливается: для владельца это одно и то же действие — «пусть у него
   * будет эта роль». Но понизить так последнего владельца нельзя, как нельзя
   * и исключить его.
   */
  async addMember(clubId: string, input: AddMemberInput): Promise<ClubMemberView> {
    await this.findById(clubId);

    const identifier = input.identifier.trim();
    const user = await this.prisma.user.findUnique({
      where: PHONE_PATTERN.test(identifier) ? { phone: identifier } : { login: identifier },
      select: { id: true },
    });

    if (user === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'User not found', { identifier });
    }

    const current = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId: user.id } },
      select: { role: true },
    });

    if (current?.role === 'OWNER' && input.role !== 'OWNER') {
      await this.assertNotLastOwner(clubId);
    }

    await this.prisma.clubMember.upsert({
      where: { clubId_userId: { clubId, userId: user.id } },
      create: { clubId, userId: user.id, role: input.role },
      update: { role: input.role },
    });

    const members = await this.listMembers(clubId);
    const member = members.find((candidate) => candidate.userId === user.id);

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
      await this.assertNotLastOwner(clubId);
    }

    await this.prisma.clubMember.delete({ where: { clubId_userId: { clubId, userId } } });
  }

  /** Клуб без владельца некому передать: чинить такое пришлось бы в базе. */
  private async assertNotLastOwner(clubId: string): Promise<void> {
    const owners = await this.prisma.clubMember.count({ where: { clubId, role: 'OWNER' } });

    if (owners <= 1) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot remove the last owner of a club', {
        clubId,
      });
    }
  }
}
