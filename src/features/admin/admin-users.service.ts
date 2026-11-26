import { randomInt } from 'node:crypto';

import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  AdminBlockUserInput,
  AdminLinkPlayerInput,
  AdminResetPasswordInput,
  AdminResetPasswordResult,
  AdminSetAdminInput,
  AdminSetClubRoleInput,
  AdminUpdateUserInput,
  AdminUserListItem,
  AdminUsersQuery,
  AdminUserView,
  Page,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { hashPassword } from '../auth/password.js';
import { TokenService } from '../auth/token.service.js';
import { isDeletedPlayer, LIVE_PLAYER } from '../players/deleted-player.js';
import { mergeFields, mergeInto, nameWords } from '../players/players.service.js';
import { toAuditEntries, writeAudit } from './audit.js';

/** Сколько последних записей журнала показывает карточка аккаунта. */
const USER_AUDIT_LIMIT = 30;

/**
 * Алфавит придуманного пароля: без 0/O, 1/l/I — пароль диктуют по телефону
 * или переписывают с экрана, и похожие знаки там путают.
 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GENERATED_PASSWORD_LENGTH = 10;

const listFields = {
  id: true,
  login: true,
  phone: true,
  email: true,
  isAdmin: true,
  blockedAt: true,
  createdAt: true,
  lastSeenAt: true,
  player: {
    select: {
      id: true,
      lastName: true,
      firstName: true,
      birthYear: true,
      rating: true,
      confirmedAt: true,
    },
  },
  _count: { select: { clubRoles: true } },
} as const satisfies Prisma.UserSelect;

const viewFields = {
  ...listFields,
  phoneVerified: true,
  locale: true,
  telegramId: true,
  city: { select: { id: true, name: true } },
  privacyConsentAt: true,
  blockedReason: true,
  // Только чтобы сказать «пароль задан»: наружу хеш не уходит.
  passwordHash: true,
  clubRoles: {
    select: { clubId: true, role: true, club: { select: { name: true } } },
    orderBy: { club: { name: 'asc' } },
  },
} as const satisfies Prisma.UserSelect;

type ListRecord = Prisma.UserGetPayload<{ select: typeof listFields }>;
type ViewRecord = Prisma.UserGetPayload<{ select: typeof viewFields }>;

type AdminInvalidReason =
  | 'SELF'
  | 'LAST_ADMIN'
  | 'LOGIN_TAKEN'
  | 'PHONE_TAKEN'
  | 'EMAIL_TAKEN'
  | 'PLAYER_TAKEN'
  | 'HAS_PLAYER'
  | 'LAST_OWNER';

export function adminInvalid(reason: AdminInvalidReason): AppError {
  return new AppError(ERROR_CODES.ADMIN_ACTION_INVALID, 'Admin action is not allowed', {
    reason,
  });
}

/**
 * Поиск и фильтр списка аккаунтов — ADR-103.
 *
 * Телефон ищется по цифрам, и только когда в строке нет ничего, кроме
 * телефонных знаков: иначе «aslan1» нашёл бы всех, у кого в номере есть
 * единица. Имя — по игровому профилю, как в списке игроков: «Ким Артём» и
 * «Артём Ким» находят одного человека.
 */
export function adminUsersWhere(
  query: Pick<AdminUsersQuery, 'search' | 'filter'>,
): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = filterWhere(query.filter);
  const search = query.search?.trim();

  if (search === undefined || search.length === 0) return where;

  const digits = search.replace(/\D/g, '');
  const phoneLike = /^[\d\s()+-]+$/.test(search) && digits.length >= 3;

  return {
    ...where,
    OR: [
      { login: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      ...(phoneLike ? [{ phone: { contains: digits } }] : []),
      { player: { is: { AND: nameWords(search) } } },
    ],
  };
}

function filterWhere(filter: AdminUsersQuery['filter']): Prisma.UserWhereInput {
  switch (filter) {
    case 'admins':
      return { isAdmin: true };
    case 'blocked':
      return { blockedAt: { not: null } };
    case 'noPlayer':
      return { player: { is: null } };
    case 'clubStaff':
      return { clubRoles: { some: {} } };
    case 'all':
    case undefined:
      return {};
  }
}

/** Пароль, который администратор передаст человеку: случайный и читаемый. */
export function generatePassword(): string {
  return Array.from({ length: GENERATED_PASSWORD_LENGTH }, () =>
    PASSWORD_ALPHABET.charAt(randomInt(PASSWORD_ALPHABET.length)),
  ).join('');
}

/**
 * Аккаунты глазами администратора платформы — ADR-103.
 *
 * Супервизор правит то, что человек сам поправить не может: логин, телефон,
 * пароль, роли, привязку к игровому профилю. Каждое действие — в журнал.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async list(query: AdminUsersQuery): Promise<Page<AdminUserListItem>> {
    const where = adminUsersWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: listFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return pageOf(rows.map(toListItem), total, query);
  }

  async view(id: string, now = new Date()): Promise<AdminUserView> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: viewFields });

    if (user === null) throw userNotFound(id);

    const [sessions, rows] = await Promise.all([
      this.prisma.session.count({ where: { userId: id, expiresAt: { gt: now } } }),
      this.prisma.auditLog.findMany({
        where: {
          OR: [
            { entityType: 'User', entityId: id },
            ...(user.player === null ? [] : [{ entityType: 'Player', entityId: user.player.id }]),
            // Роль в клубе — запись о строке состава; чей это состав, видно
            // по `userId` внутри было/стало.
            {
              entityType: 'ClubMember',
              OR: [
                { after: { path: ['userId'], equals: id } },
                { before: { path: ['userId'], equals: id } },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: USER_AUDIT_LIMIT,
      }),
    ]);

    return toView(user, sessions, await toAuditEntries(this.prisma, rows));
  }

  /**
   * Логин, телефон, почта. Занятое другим аккаунтом называется прямо:
   * администратору это не утечка, а подсказка, кого искать.
   */
  async update(id: string, input: AdminUpdateUserInput, adminId: string): Promise<AdminUserView> {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { login: true, phone: true, email: true },
    });

    if (current === null) throw userNotFound(id);

    const conflicts: Prisma.UserWhereInput[] = [];

    if (input.login !== undefined) conflicts.push({ login: input.login });
    if (input.phone !== undefined) conflicts.push({ phone: input.phone });
    if (input.email !== undefined && input.email !== null) conflicts.push({ email: input.email });

    if (conflicts.length > 0) {
      const taken = await this.prisma.user.findFirst({
        where: { OR: conflicts, NOT: { id } },
        select: { login: true, phone: true, email: true },
      });

      if (taken !== null) {
        if (input.login !== undefined && taken.login === input.login) {
          throw adminInvalid('LOGIN_TAKEN');
        }

        throw adminInvalid(taken.phone === input.phone ? 'PHONE_TAKEN' : 'EMAIL_TAKEN');
      }
    }

    const data: Prisma.UserUpdateInput = {};
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};

    if (input.login !== undefined && input.login !== current.login) {
      data.login = input.login;
      before.login = current.login;
      after.login = input.login;
    }

    if (input.phone !== undefined && input.phone !== current.phone) {
      // Новый номер никто не подтверждал (ADR-034): владение им — со слов
      // человека, а не по коду.
      data.phone = input.phone;
      data.phoneVerified = false;
      before.phone = current.phone;
      after.phone = input.phone;
    }

    if (input.email !== undefined && input.email !== current.email) {
      data.email = input.email;
      before.email = current.email;
      after.email = input.email;
    }

    if (Object.keys(after).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data });
        await writeAudit(tx, {
          actorId: adminId,
          action: 'user.update',
          entityType: 'User',
          entityId: id,
          before,
          after,
        });
      });
    }

    return this.view(id);
  }

  /**
   * Новый пароль — ADR-103. Сессии закрываются все: сброс просят и тогда,
   * когда старый пароль узнали чужие. Access-токены не отзываются: они живут
   * 15 минут, а отзыв по аккаунту отверг бы и токен самого человека, который
   * сразу вошёл с новым паролем.
   */
  async resetPassword(
    id: string,
    input: AdminResetPasswordInput,
    adminId: string,
  ): Promise<AdminResetPasswordResult> {
    await this.assertUser(id);

    const password = input.password ?? generatePassword();
    // Хеш до транзакции: держать её открытой, пока он считается, незачем.
    const passwordHash = await hashPassword(password);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: id } });
      // Ни пароля, ни хеша — только чей он: свой или придуманный сервером.
      await writeAudit(tx, {
        actorId: adminId,
        action: 'user.password.reset',
        entityType: 'User',
        entityId: id,
        after: { generated: input.password === undefined },
      });
    });

    return { password };
  }

  /**
   * Блокировка — ADR-103. Сессии закрываются, access-токены отзываются:
   * заблокированный выходит сразу, а не через 15 минут.
   */
  async block(id: string, input: AdminBlockUserInput, adminId: string): Promise<AdminUserView> {
    if (id === adminId) throw adminInvalid('SELF');

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { isAdmin: true, blockedAt: true, blockedReason: true },
    });

    if (user === null) throw userNotFound(id);

    if (user.isAdmin) await this.assertOtherAdmins(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { blockedAt: new Date(), blockedReason: input.reason, blockedById: adminId },
      });
      await tx.session.deleteMany({ where: { userId: id } });
      await writeAudit(tx, {
        actorId: adminId,
        action: 'user.block',
        entityType: 'User',
        entityId: id,
        before: { blocked: user.blockedAt !== null, reason: user.blockedReason },
        after: { blocked: true, reason: input.reason },
      });
    });

    this.tokens.revokeUser(id);

    return this.view(id);
  }

  async unblock(id: string, adminId: string): Promise<AdminUserView> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { blockedAt: true, blockedReason: true },
    });

    if (user === null) throw userNotFound(id);

    if (user.blockedAt !== null) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id },
          data: { blockedAt: null, blockedReason: null, blockedById: null },
        });
        await writeAudit(tx, {
          actorId: adminId,
          action: 'user.unblock',
          entityType: 'User',
          entityId: id,
          before: { blocked: true, reason: user.blockedReason },
          after: { blocked: false },
        });
      });

      this.tokens.restoreUser(id);
    }

    return this.view(id);
  }

  /**
   * Права администратора — ADR-103. Снять их с себя нельзя: так платформа
   * остаётся без того, кто вернёт права обратно. Последнего — тоже.
   */
  async setAdmin(id: string, input: AdminSetAdminInput, adminId: string): Promise<AdminUserView> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { isAdmin: true } });

    if (user === null) throw userNotFound(id);

    if (user.isAdmin !== input.isAdmin) {
      if (!input.isAdmin) {
        if (id === adminId) throw adminInvalid('SELF');

        await this.assertOtherAdmins(id);
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { isAdmin: input.isAdmin } });
        await writeAudit(tx, {
          actorId: adminId,
          action: input.isAdmin ? 'user.admin.grant' : 'user.admin.revoke',
          entityType: 'User',
          entityId: id,
          before: { isAdmin: user.isAdmin },
          after: { isAdmin: input.isAdmin },
        });
      });
    }

    return this.view(id);
  }

  /**
   * «Выйти на всех устройствах» — ADR-103. Только сессии: access-токены
   * истекут сами за 15 минут, отзыв по аккаунту отверг бы и новый вход.
   */
  async revokeSessions(id: string, adminId: string): Promise<void> {
    await this.assertUser(id);

    await this.prisma.$transaction(async (tx) => {
      const closed = await tx.session.deleteMany({ where: { userId: id } });
      await writeAudit(tx, {
        actorId: adminId,
        action: 'user.sessions.revoke',
        entityType: 'User',
        entityId: id,
        after: { sessions: closed.count },
      });
    });
  }

  /** Роль в клубе: выдать или сменить. Последнего владельца не разжаловать. */
  async setClubRole(
    id: string,
    input: AdminSetClubRoleInput,
    adminId: string,
  ): Promise<AdminUserView> {
    await this.assertUser(id);

    const club = await this.prisma.club.findUnique({
      where: { id: input.clubId },
      select: { id: true, name: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: input.clubId });
    }

    await this.prisma.$transaction(async (tx) => {
      const key = { clubId_userId: { clubId: input.clubId, userId: id } };
      const current = await tx.clubMember.findUnique({ where: key, select: { role: true } });

      if (current?.role === input.role) return;

      if (current?.role === 'OWNER') await assertOtherOwner(tx, input.clubId, id);

      const member = await tx.clubMember.upsert({
        where: key,
        create: { clubId: input.clubId, userId: id, role: input.role },
        update: { role: input.role },
        select: { id: true },
      });

      await writeAudit(tx, {
        actorId: adminId,
        action: 'club.role.set',
        entityType: 'ClubMember',
        entityId: member.id,
        ...(current === null
          ? {}
          : { before: { clubId: input.clubId, club: club.name, userId: id, role: current.role } }),
        after: { clubId: input.clubId, club: club.name, userId: id, role: input.role },
      });
    });

    return this.view(id);
  }

  async removeClubRole(id: string, clubId: string, adminId: string): Promise<AdminUserView> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.clubMember.findUnique({
        where: { clubId_userId: { clubId, userId: id } },
        select: { id: true, role: true, club: { select: { name: true } } },
      });

      if (current === null) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Club role not found', { clubId, userId: id });
      }

      if (current.role === 'OWNER') await assertOtherOwner(tx, clubId, id);

      await tx.clubMember.delete({ where: { id: current.id } });
      await writeAudit(tx, {
        actorId: adminId,
        action: 'club.role.remove',
        entityType: 'ClubMember',
        entityId: current.id,
        before: { clubId, club: current.club.name, userId: id, role: current.role },
      });
    });

    return this.view(id);
  }

  /**
   * Привязать игровой профиль к аккаунту — ADR-103, как «Это я» (ADR-072),
   * но решает администратор. Своя анкета без рейтинга вливается в профиль
   * (`mergeInto`); подтверждённый профиль у аккаунта уже есть — отказ: два
   * рейтинга одного человека сливать вслепую нельзя.
   *
   * В журнал — по аккаунту: отвязка тоже пишется туда, а профиль после неё
   * с аккаунтом уже не связан, и карточка аккаунта её бы не нашла.
   */
  async linkPlayer(
    id: string,
    input: AdminLinkPlayerInput,
    adminId: string,
  ): Promise<AdminUserView> {
    await this.assertUser(id);

    await this.prisma.$transaction(async (tx) => {
      const target = await tx.player.findUnique({
        where: { id: input.playerId },
        select: mergeFields,
      });

      if (target === null || isDeletedPlayer(target)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id: input.playerId });
      }

      if (target.userId === id) return;

      if (target.userId !== null) throw adminInvalid('PLAYER_TAKEN');

      const own = await tx.player.findUnique({ where: { userId: id }, select: mergeFields });

      if (own !== null) {
        if (own.confirmedAt !== null) throw adminInvalid('HAS_PLAYER');

        await mergeInto(tx, own, target);
      }

      // Условие на пустоту: между чтением и записью профиль мог занять
      // и сам человек через «Это я».
      const linked = await tx.player.updateMany({
        where: { id: target.id, userId: null, ...LIVE_PLAYER },
        data: { userId: id },
      });

      if (linked.count === 0) throw adminInvalid('PLAYER_TAKEN');

      await writeAudit(tx, {
        actorId: adminId,
        action: 'player.link',
        entityType: 'User',
        entityId: id,
        before: { playerId: own?.id ?? null },
        after: { playerId: target.id, ...(own === null ? {} : { mergedSheetId: own.id }) },
      });
    });

    return this.view(id);
  }

  /** Отвязать: профиль со всей историей остаётся, аккаунт — без профиля. */
  async unlinkPlayer(id: string, adminId: string): Promise<AdminUserView> {
    await this.assertUser(id);

    await this.prisma.$transaction(async (tx) => {
      const player = await tx.player.findUnique({ where: { userId: id }, select: { id: true } });

      if (player === null) return;

      await tx.player.update({ where: { id: player.id }, data: { userId: null } });
      await writeAudit(tx, {
        actorId: adminId,
        action: 'player.unlink',
        entityType: 'User',
        entityId: id,
        before: { playerId: player.id },
        after: { playerId: null },
      });
    });

    return this.view(id);
  }

  private async assertUser(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });

    if (user === null) throw userNotFound(id);
  }

  /**
   * Платформа не остаётся без администратора: считаются только те, кто
   * может войти, — заблокированный права не применит.
   */
  private async assertOtherAdmins(id: string): Promise<void> {
    const others = await this.prisma.user.count({
      where: { isAdmin: true, blockedAt: null, NOT: { id } },
    });

    if (others === 0) throw adminInvalid('LAST_ADMIN');
  }
}

/** Клуб без владельца некому вести: состав и страницу правит владелец (ТЗ 1). */
async function assertOtherOwner(
  tx: Prisma.TransactionClient,
  clubId: string,
  userId: string,
): Promise<void> {
  const others = await tx.clubMember.count({
    where: { clubId, role: 'OWNER', NOT: { userId } },
  });

  if (others === 0) throw adminInvalid('LAST_OWNER');
}

function userNotFound(id: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'User not found', { id });
}

function toListItem(user: ListRecord): AdminUserListItem {
  return {
    id: user.id,
    login: user.login,
    phone: user.phone,
    email: user.email,
    isAdmin: user.isAdmin,
    blockedAt: user.blockedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    player:
      user.player === null
        ? null
        : {
            id: user.player.id,
            lastName: user.player.lastName,
            firstName: user.player.firstName,
            birthYear: user.player.birthYear,
            rating: user.player.rating.toString(),
            confirmed: user.player.confirmedAt !== null,
          },
    clubRoles: user._count.clubRoles,
  };
}

function toView(user: ViewRecord, sessions: number, audit: AdminUserView['audit']): AdminUserView {
  return {
    ...toListItem(user),
    phoneVerified: user.phoneVerified,
    locale: user.locale,
    telegramId: user.telegramId,
    city: user.city,
    privacyConsentAt: user.privacyConsentAt?.toISOString() ?? null,
    blockedReason: user.blockedReason,
    sessions,
    hasPassword: user.passwordHash !== null,
    roles: user.clubRoles.map((member) => ({
      clubId: member.clubId,
      clubName: member.club.name,
      role: member.role,
    })),
    audit,
  };
}
