import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { LoginThrottle } from '../auth/login-throttle.js';
import { hashPassword } from '../auth/password.js';
import type { AccountDeletionService } from './account-deletion.service.js';
import { AccountRequestsService } from './account-requests.service.js';
import type { AccountRestoreService } from './account-restore.service.js';
import { phoneHash } from './phone-hash.js';

/**
 * Заявки на удаление и восстановление — ADR-095: пароль, одна ожидающая,
 * признак «есть что восстановить» по хешу телефона.
 */

const SECRET = 'test_secret_at_least_32_characters_long';
const PASSWORD = 'parol123';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const USER = 'user-1';
const PHONE = '+77010000001';
const IP = '10.0.0.1';
const CREATED = new Date('2026-11-18T10:00:00Z');

function makePrisma() {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    clubMember: { findMany: vi.fn().mockResolvedValue([]) },
    player: {
      findUnique: vi.fn().mockResolvedValue({ id: 'player-1', confirmedAt: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    playerArchive: { findFirst: vi.fn().mockResolvedValue(null) },
    accountRequest: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));
  prisma.user.findUnique.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Promise.resolve(
      select.passwordHash === true
        ? { passwordHash: PASSWORD_HASH }
        : select.phone === true
          ? { phone: PHONE }
          : { isAdmin: false },
    ),
  );
  prisma.accountRequest.create.mockImplementation(({ data }: { data: { kind: string } }) =>
    Promise.resolve({
      id: 'request-1',
      kind: data.kind,
      status: 'PENDING',
      createdAt: CREATED,
      decidedAt: null,
      answer: null,
    }),
  );

  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const throttle = new LoginThrottle({ JWT_SECRET: SECRET } as Env);
  const deletion = { approve: vi.fn().mockResolvedValue(undefined) };
  const restore = { approve: vi.fn().mockResolvedValue(undefined) };
  const service = new AccountRequestsService(
    prisma as unknown as PrismaService,
    throttle,
    deletion as unknown as AccountDeletionService,
    restore as unknown as AccountRestoreService,
    { JWT_SECRET: SECRET } as Env,
  );

  return { service, throttle, deletion, restore };
}

describe('заявка на удаление', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('с верным паролем заводится и ждёт решения — аккаунт не трогается', async () => {
    const { service, deletion } = makeService(prisma);

    const view = await service.requestDeletion(USER, { password: PASSWORD, reason: 'Ухожу' }, IP);

    expect(view).toMatchObject({ kind: 'DELETE', status: 'PENDING', decidedAt: null });
    expect(prisma.accountRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { kind: 'DELETE', userId: USER, playerId: 'player-1', reason: 'Ухожу' },
      }),
    );
    expect(deletion.approve).not.toHaveBeenCalled();
  });

  it('неверный пароль — WRONG_PASSWORD, попытка засчитана, заявки нет', async () => {
    const { service, throttle } = makeService(prisma);
    const failure = vi.spyOn(throttle, 'recordFailure');

    await expect(service.requestDeletion(USER, { password: 'chuzhoi1' }, IP)).rejects.toMatchObject(
      { code: 'WRONG_PASSWORD' },
    );
    expect(failure).toHaveBeenCalledOnce();
    expect(prisma.accountRequest.create).not.toHaveBeenCalled();
  });

  it('аккаунт без пароля заявку не подаст', async () => {
    prisma.user.findUnique.mockResolvedValue({ passwordHash: null });
    const { service } = makeService(prisma);

    await expect(service.requestDeletion(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
  });

  it('вторая ожидающая — ACCOUNT_REQUEST_PENDING', async () => {
    prisma.accountRequest.count.mockResolvedValue(1);
    const { service } = makeService(prisma);

    await expect(service.requestDeletion(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'ACCOUNT_REQUEST_PENDING',
    });
    expect(prisma.accountRequest.create).not.toHaveBeenCalled();
  });

  it('последний владелец клуба узнаёт об этом сразу', async () => {
    prisma.clubMember.findMany
      .mockResolvedValueOnce([{ clubId: 'club-1' }])
      .mockResolvedValueOnce([]);
    const { service } = makeService(prisma);

    await expect(service.requestDeletion(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETE_BLOCKED',
    });
  });

  it('отозвать нечего — NOT_FOUND', async () => {
    prisma.accountRequest.updateMany.mockResolvedValue({ count: 0 });
    const { service } = makeService(prisma);

    await expect(service.cancelDeletion(USER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('восстановление: заявка и признак', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('архив ищется по хешу телефона; со снимком — restorableWithData', async () => {
    prisma.playerArchive.findFirst.mockResolvedValue({
      playerId: 'archived-1',
      snapshot: { lastName: 'Иванов' },
    });
    const { service } = makeService(prisma);

    const status = await service.status(USER);

    expect(status).toEqual({
      deletion: null,
      restore: null,
      rename: null,
      restorable: true,
      restorableWithData: true,
    });
    expect(prisma.playerArchive.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          phoneHash: phoneHash(SECRET, PHONE),
          player: { deletedAt: { not: null }, userId: null },
        },
      }),
    );
  });

  it('снимок стёрт — восстановить можно, но без личных данных', async () => {
    prisma.playerArchive.findFirst.mockResolvedValue({ playerId: 'archived-1', snapshot: null });
    const { service } = makeService(prisma);

    await expect(service.status(USER)).resolves.toMatchObject({
      restorable: true,
      restorableWithData: false,
    });
  });

  it('архива нет — NOTHING_ARCHIVED', async () => {
    const { service } = makeService(prisma);

    await expect(
      service.requestRestore(USER, { lastName: 'Иванов', firstName: 'Пётр' }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_RESTORE_INVALID',
      details: { reason: 'NOTHING_ARCHIVED' },
    });
  });

  it('подтверждённый профиль — HAS_PROFILE', async () => {
    prisma.playerArchive.findFirst.mockResolvedValue({ playerId: 'archived-1', snapshot: null });
    prisma.player.findUnique.mockResolvedValue({ confirmedAt: CREATED });
    const { service } = makeService(prisma);

    await expect(
      service.requestRestore(USER, { lastName: 'Иванов', firstName: 'Пётр' }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_RESTORE_INVALID',
      details: { reason: 'HAS_PROFILE' },
    });
  });

  it('заявка ссылается на архивный профиль и хранит названное имя', async () => {
    prisma.playerArchive.findFirst.mockResolvedValue({ playerId: 'archived-1', snapshot: null });
    const { service } = makeService(prisma);

    await service.requestRestore(USER, { lastName: 'Иванов', firstName: 'Пётр', comment: 'Это я' });

    expect(prisma.accountRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          kind: 'RESTORE',
          userId: USER,
          playerId: 'archived-1',
          claimedLastName: 'Иванов',
          claimedFirstName: 'Пётр',
          reason: 'Это я',
        },
      }),
    );
  });
});

describe('решение администратора', () => {
  let prisma: ReturnType<typeof makePrisma>;

  const adminRow = {
    id: 'request-1',
    kind: 'RESTORE',
    status: 'PENDING',
    createdAt: CREATED,
    decidedAt: null,
    answer: null,
    reason: null,
    claimedLastName: 'Иванов',
    claimedFirstName: 'Пётр',
    user: { id: USER, login: null, phone: PHONE },
    player: {
      id: 'archived-1',
      lastName: '',
      firstName: '',
      birthYear: 1990,
      rating: { toString: () => '512.50' },
      archive: { snapshot: null },
      _count: { registrations: 7 },
    },
  };

  beforeEach(() => {
    prisma = makePrisma();
    prisma.accountRequest.findUniqueOrThrow.mockResolvedValue(adminRow);
  });

  it('одобрение уходит в путь своего вида', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue({ kind: 'RESTORE' });
    const { service, deletion, restore } = makeService(prisma);

    const view = await service.approve('request-1', 'admin-1');

    expect(restore.approve).toHaveBeenCalledWith('request-1', 'admin-1');
    expect(deletion.approve).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      claimedName: 'Иванов Пётр',
      player: { id: 'archived-1', rating: '512.50', tournaments: 7 },
    });
  });

  it('отказ пишет ответ человеку', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue({ ...adminRow, status: 'PENDING' });
    const { service } = makeService(prisma);

    await service.reject('request-1', 'admin-1', { answer: 'Не подтвердилось' });

    expect(prisma.accountRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({
        status: 'REJECTED',
        answer: 'Не подтвердилось',
        decidedById: 'admin-1',
      }) as unknown,
    });
  });
});

describe('исправление имени — ADR-102', () => {
  const renamed = {
    lastName: 'Халилов',
    firstName: 'Родион',
    birthYear: 2002,
    gender: 'MALE' as const,
  };

  it('анкету без рейтинга человек правит сам — заявка не нужна', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    await expect(service.requestRename(USER, renamed)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('игровой профиль — заявка с именем, каким оно должно стать', async () => {
    const prisma = makePrisma();
    prisma.player.findUnique.mockResolvedValue({ id: 'player-1', confirmedAt: CREATED });
    const { service } = makeService(prisma);

    await service.requestRename(USER, renamed);

    expect(prisma.accountRequest.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        kind: 'RENAME',
        playerId: 'player-1',
        claimedLastName: 'Халилов',
        claimedBirthYear: 2002,
        claimedGender: 'MALE',
      },
    });
  });

  it('одобрение переписывает профиль; дата другого года стирается', async () => {
    const prisma = makePrisma();
    prisma.accountRequest.findUnique
      .mockResolvedValueOnce({ kind: 'RENAME' })
      .mockResolvedValueOnce({
        id: 'request-1',
        kind: 'RENAME',
        status: 'PENDING',
        userId: USER,
        playerId: 'player-1',
      });
    prisma.accountRequest.findUniqueOrThrow.mockResolvedValueOnce({
      claimedLastName: 'Халилов',
      claimedFirstName: 'Родион',
      claimedMiddleName: null,
      claimedBirthYear: 2002,
      claimedGender: 'MALE',
    });
    prisma.player.findUnique.mockResolvedValue({
      id: 'player-1',
      birthDate: new Date('2001-03-03T00:00:00Z'),
      deletedAt: null,
    });
    const { service } = makeService(prisma);

    await service.approve('request-1', 'admin-1').catch(() => undefined);

    expect(prisma.player.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'player-1' },
      data: { lastName: 'Халилов', birthYear: 2002, gender: 'MALE', birthDate: null },
    });
    expect(prisma.accountRequest.update.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'APPROVED', decidedById: 'admin-1' },
    });
  });
});
