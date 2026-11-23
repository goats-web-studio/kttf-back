import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { verifyPassword } from '../auth/password.js';
import type { TokenService } from '../auth/token.service.js';
import { AdminUsersService, adminUsersWhere, generatePassword } from './admin-users.service.js';

/**
 * Управление аккаунтами — ADR-103: поиск, сброс пароля, блокировка, права,
 * роли в клубах, привязка профиля. Каждое действие — в журнал.
 */

const ADMIN = 'admin-1';
const USER = 'user-1';
const CREATED = new Date('2026-11-01T10:00:00Z');

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER,
    login: 'aslan',
    phone: '+77010000001',
    email: null,
    isAdmin: false,
    blockedAt: null,
    blockedReason: null,
    createdAt: CREATED,
    lastSeenAt: null,
    player: null,
    _count: { clubRoles: 0 },
    phoneVerified: true,
    locale: 'RU',
    telegramId: null,
    city: null,
    privacyConsentAt: null,
    passwordHash: 'scrypt$hash',
    clubRoles: [],
    ...overrides,
  };
}

const sheet = (overrides: Record<string, unknown> = {}) => ({
  id: 'sheet-1',
  userId: USER,
  confirmedAt: null,
  deletedAt: null,
  birthYear: 2000,
  birthDate: null,
  birthYearOnly: true,
  coachPlayerId: null,
  coachName: null,
  coachVisibility: 'ALL',
  coachPage: null,
  middleName: null,
  photoUrl: null,
  clubId: null,
  playingHand: null,
  grip: null,
  blade: null,
  rubberForehand: null,
  rubberBackhand: null,
  bladeProductId: null,
  rubberForehandProductId: null,
  rubberBackhandProductId: null,
  bio: null,
  ...overrides,
});

function makePrisma() {
  const prisma = {
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn().mockResolvedValue(userRow()),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue({}),
    },
    session: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    club: { findUnique: vi.fn().mockResolvedValue({ id: 'club-1' }) },
    clubMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
      upsert: vi.fn().mockResolvedValue({ id: 'member-1' }),
      delete: vi.fn().mockResolvedValue({}),
    },
    player: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    coach: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    coachTenure: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    registration: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    duel: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    duelResponse: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const tokens = { revokeUser: vi.fn(), restoreUser: vi.fn() };
  const service = new AdminUsersService(
    prisma as unknown as PrismaService,
    tokens as unknown as TokenService,
  );

  return { service, tokens };
}

function auditCall(prisma: ReturnType<typeof makePrisma>) {
  return prisma.auditLog.create.mock.calls[0]?.[0] as {
    data: {
      action: string;
      entityType: string;
      entityId: string;
      before?: unknown;
      after?: unknown;
    };
  };
}

describe('поиск аккаунтов', () => {
  it('без поиска и фильтра — все', () => {
    expect(adminUsersWhere({})).toEqual({});
  });

  it('фильтры', () => {
    expect(adminUsersWhere({ filter: 'admins' })).toEqual({ isAdmin: true });
    expect(adminUsersWhere({ filter: 'blocked' })).toEqual({ blockedAt: { not: null } });
    expect(adminUsersWhere({ filter: 'noPlayer' })).toEqual({ player: { is: null } });
    expect(adminUsersWhere({ filter: 'clubStaff' })).toEqual({ clubRoles: { some: {} } });
  });

  it('текст ищется в логине, почте и имени профиля, но не в телефоне', () => {
    const where = adminUsersWhere({ search: 'Ким', filter: 'admins' });

    expect(where.isAdmin).toBe(true);
    expect(where.OR).toEqual([
      { login: { contains: 'Ким', mode: 'insensitive' } },
      { email: { contains: 'Ким', mode: 'insensitive' } },
      {
        player: {
          is: {
            AND: [
              {
                OR: [
                  { lastName: { contains: 'Ким', mode: 'insensitive' } },
                  { firstName: { contains: 'Ким', mode: 'insensitive' } },
                  { middleName: { contains: 'Ким', mode: 'insensitive' } },
                ],
              },
            ],
          },
        },
      },
    ]);
  });

  it('номер ищется по цифрам', () => {
    const where = adminUsersWhere({ search: '+7 (701) 000' });

    expect(where.OR).toContainEqual({ phone: { contains: '7701000' } });
  });

  it('цифра в логине телефон не ищет', () => {
    const where = adminUsersWhere({ search: 'aslan1' });

    expect(JSON.stringify(where)).not.toContain('phone');
  });
});

describe('сброс пароля', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('придуманный сервером: хеш меняется, сессии закрываются, пароль в ответе', async () => {
    const { service } = makeService(prisma);

    const { password } = await service.resetPassword(USER, {}, ADMIN);

    expect(password).toMatch(/^[a-z2-9]{10}$/);
    const update = prisma.user.update.mock.calls[0]?.[0] as { data: { passwordHash: string } };
    expect(verifyPassword(password, update.data.passwordHash)).toBe(true);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    const audit = auditCall(prisma);
    expect(audit.data).toMatchObject({ action: 'user.password.reset', entityId: USER });
    // Ни пароля, ни хеша в журнале.
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(JSON.stringify(audit)).not.toContain('scrypt');
  });

  it('заданный администратором возвращается как есть', async () => {
    const { service } = makeService(prisma);

    await expect(service.resetPassword(USER, { password: 'novyj-parol' }, ADMIN)).resolves.toEqual({
      password: 'novyj-parol',
    });
  });

  it('нет аккаунта — NOT_FOUND', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.resetPassword(USER, {}, ADMIN)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('пароль читаемый: без похожих знаков', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(generatePassword()).not.toMatch(/[01ilo]/);
    }
  });
});

describe('блокировка', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('ставит причину, закрывает сессии и отзывает токены', async () => {
    const { service, tokens } = makeService(prisma);

    await service.block(USER, { reason: 'Спам' }, ADMIN);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { blockedAt: expect.any(Date) as Date, blockedReason: 'Спам', blockedById: ADMIN },
    });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(tokens.revokeUser).toHaveBeenCalledWith(USER);
    expect(auditCall(prisma).data).toMatchObject({ action: 'user.block', entityType: 'User' });
  });

  it('себя — SELF', async () => {
    const { service } = makeService(prisma);

    await expect(service.block(ADMIN, { reason: 'x' }, ADMIN)).rejects.toMatchObject({
      code: 'ADMIN_ACTION_INVALID',
      details: { reason: 'SELF' },
    });
  });

  it('последнего администратора — LAST_ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue(userRow({ isAdmin: true }));
    prisma.user.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await expect(service.block(USER, { reason: 'x' }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'LAST_ADMIN' },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('разблокировка снимает причину и отзыв токенов', async () => {
    prisma.user.findUnique.mockResolvedValue(
      userRow({ blockedAt: new Date(), blockedReason: 'Спам' }),
    );
    const { service, tokens } = makeService(prisma);

    await service.unblock(USER, ADMIN);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { blockedAt: null, blockedReason: null, blockedById: null },
    });
    expect(tokens.restoreUser).toHaveBeenCalledWith(USER);
    expect(auditCall(prisma).data.action).toBe('user.unblock');
  });

  it('разблокировать незаблокированного — ничего не пишет', async () => {
    const { service } = makeService(prisma);

    await service.unblock(USER, ADMIN);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('права администратора', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('выдаёт и пишет в журнал', async () => {
    const { service } = makeService(prisma);

    await service.setAdmin(USER, { isAdmin: true }, ADMIN);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { isAdmin: true },
    });
    expect(auditCall(prisma).data).toMatchObject({
      action: 'user.admin.grant',
      before: { isAdmin: false },
      after: { isAdmin: true },
    });
  });

  it('с себя не снять — SELF', async () => {
    prisma.user.findUnique.mockResolvedValue(userRow({ id: ADMIN, isAdmin: true }));
    const { service } = makeService(prisma);

    await expect(service.setAdmin(ADMIN, { isAdmin: false }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'SELF' },
    });
  });

  it('с последнего не снять — LAST_ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue(userRow({ isAdmin: true }));
    prisma.user.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await expect(service.setAdmin(USER, { isAdmin: false }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'LAST_ADMIN' },
    });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { isAdmin: true, blockedAt: null, NOT: { id: USER } },
    });
  });
});

describe('правка аккаунта', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('занятый логин — LOGIN_TAKEN', async () => {
    prisma.user.findFirst.mockResolvedValue({ login: 'busy', phone: '+77019999999', email: null });
    const { service } = makeService(prisma);

    await expect(service.update(USER, { login: 'busy' }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'LOGIN_TAKEN' },
    });
  });

  it('занятый телефон — PHONE_TAKEN', async () => {
    prisma.user.findFirst.mockResolvedValue({ login: 'x', phone: '+77019999999', email: null });
    const { service } = makeService(prisma);

    await expect(
      service.update(USER, { login: 'free', phone: '+77019999999' }, ADMIN),
    ).rejects.toMatchObject({ details: { reason: 'PHONE_TAKEN' } });
  });

  it('новый телефон не подтверждён', async () => {
    const { service } = makeService(prisma);

    await service.update(USER, { phone: '+77019999999' }, ADMIN);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { phone: '+77019999999', phoneVerified: false },
    });
    expect(auditCall(prisma).data).toMatchObject({
      action: 'user.update',
      before: { phone: '+77010000001' },
      after: { phone: '+77019999999' },
    });
  });
});

describe('роли в клубах', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('выдаёт роль и пишет строку состава в журнал', async () => {
    const { service } = makeService(prisma);

    await service.setClubRole(USER, { clubId: 'club-1', role: 'ORGANIZER' }, ADMIN);

    expect(prisma.clubMember.upsert).toHaveBeenCalledOnce();
    expect(auditCall(prisma).data).toMatchObject({
      action: 'club.role.set',
      entityType: 'ClubMember',
      entityId: 'member-1',
      after: { clubId: 'club-1', userId: USER, role: 'ORGANIZER' },
    });
  });

  it('несуществующий клуб — NOT_FOUND', async () => {
    prisma.club.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(
      service.setClubRole(USER, { clubId: 'club-1', role: 'OWNER' }, ADMIN),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('последнего владельца не разжаловать — LAST_OWNER', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ id: 'member-1', role: 'OWNER' });
    prisma.clubMember.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await expect(
      service.setClubRole(USER, { clubId: 'club-1', role: 'REFEREE' }, ADMIN),
    ).rejects.toMatchObject({ details: { reason: 'LAST_OWNER' } });
    expect(prisma.clubMember.upsert).not.toHaveBeenCalled();
  });

  it('последнего владельца не убрать — LAST_OWNER', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ id: 'member-1', role: 'OWNER' });
    prisma.clubMember.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await expect(service.removeClubRole(USER, 'club-1', ADMIN)).rejects.toMatchObject({
      details: { reason: 'LAST_OWNER' },
    });
    expect(prisma.clubMember.delete).not.toHaveBeenCalled();
  });

  it('владельца при втором владельце убрать можно', async () => {
    prisma.clubMember.findUnique.mockResolvedValue({ id: 'member-1', role: 'OWNER' });
    const { service } = makeService(prisma);

    await service.removeClubRole(USER, 'club-1', ADMIN);

    expect(prisma.clubMember.delete).toHaveBeenCalledWith({ where: { id: 'member-1' } });
    expect(auditCall(prisma).data).toMatchObject({
      action: 'club.role.remove',
      before: { clubId: 'club-1', userId: USER, role: 'OWNER' },
    });
  });
});

describe('привязка игрового профиля', () => {
  let prisma: ReturnType<typeof makePrisma>;
  const target = sheet({ id: 'player-7', userId: null, confirmedAt: new Date() });

  beforeEach(() => {
    prisma = makePrisma();
  });

  /** Первый поиск — целевой профиль, второй — свой профиль аккаунта. */
  function lookups(own: object | null, found: object = target) {
    prisma.player.findUnique.mockImplementation(({ where }: { where: { id?: string } }) =>
      Promise.resolve(where.id === undefined ? own : found),
    );
  }

  it('аккаунт без профиля — просто привязывает', async () => {
    lookups(null);
    const { service } = makeService(prisma);

    await service.linkPlayer(USER, { playerId: 'player-7' }, ADMIN);

    expect(prisma.player.updateMany).toHaveBeenCalledWith({
      where: { id: 'player-7', userId: null, deletedAt: null },
      data: { userId: USER },
    });
    expect(prisma.player.delete).not.toHaveBeenCalled();
    expect(auditCall(prisma).data).toMatchObject({
      action: 'player.link',
      entityType: 'User',
      after: { playerId: 'player-7' },
    });
  });

  it('своя анкета без рейтинга вливается в профиль', async () => {
    lookups(sheet({ bio: 'Играю с детства' }));
    const { service } = makeService(prisma);

    await service.linkPlayer(USER, { playerId: 'player-7' }, ADMIN);

    expect(prisma.player.delete).toHaveBeenCalledWith({ where: { id: 'sheet-1' } });
    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: 'player-7' },
      data: { bio: 'Играю с детства' },
    });
    expect(auditCall(prisma).data.after).toMatchObject({ mergedSheetId: 'sheet-1' });
  });

  it('у аккаунта уже подтверждённый профиль — HAS_PLAYER', async () => {
    lookups(sheet({ confirmedAt: new Date() }));
    const { service } = makeService(prisma);

    await expect(service.linkPlayer(USER, { playerId: 'player-7' }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'HAS_PLAYER' },
    });
    expect(prisma.player.updateMany).not.toHaveBeenCalled();
  });

  it('у профиля уже другой аккаунт — PLAYER_TAKEN', async () => {
    lookups(null, { ...target, userId: 'user-2' });
    const { service } = makeService(prisma);

    await expect(service.linkPlayer(USER, { playerId: 'player-7' }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'PLAYER_TAKEN' },
    });
  });

  it('профиль заняли между чтением и записью — PLAYER_TAKEN', async () => {
    lookups(null);
    prisma.player.updateMany.mockResolvedValue({ count: 0 });
    const { service } = makeService(prisma);

    await expect(service.linkPlayer(USER, { playerId: 'player-7' }, ADMIN)).rejects.toMatchObject({
      details: { reason: 'PLAYER_TAKEN' },
    });
  });

  it('удалённый профиль — NOT_FOUND', async () => {
    lookups(null, { ...target, deletedAt: new Date() });
    const { service } = makeService(prisma);

    await expect(service.linkPlayer(USER, { playerId: 'player-7' }, ADMIN)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('отвязка оставляет профиль без аккаунта', async () => {
    prisma.player.findUnique.mockResolvedValue({ id: 'player-7' });
    const { service } = makeService(prisma);

    await service.unlinkPlayer(USER, ADMIN);

    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: 'player-7' },
      data: { userId: null },
    });
    expect(auditCall(prisma).data).toMatchObject({
      action: 'player.unlink',
      before: { playerId: 'player-7' },
    });
  });
});

describe('карточка аккаунта', () => {
  it('сессии, пароль, роли и журнал с логином действовавшего', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(
      userRow({
        clubRoles: [{ clubId: 'club-1', role: 'OWNER', club: { name: 'Спин' } }],
        _count: { clubRoles: 1 },
      }),
    );
    prisma.session.count.mockResolvedValue(3);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'audit-1',
        actorId: ADMIN,
        action: 'user.block',
        entityType: 'User',
        entityId: USER,
        before: null,
        after: { blocked: true },
        createdAt: CREATED,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: ADMIN, login: 'boss' }]);
    const { service } = makeService(prisma);

    const view = await service.view(USER);

    expect(view).toMatchObject({
      sessions: 3,
      hasPassword: true,
      clubRoles: 1,
      roles: [{ clubId: 'club-1', clubName: 'Спин', role: 'OWNER' }],
      audit: [{ id: 'audit-1', actor: { id: ADMIN, login: 'boss' } }],
    });
    expect(view).not.toHaveProperty('passwordHash');
  });
});
