import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { LoginThrottle } from '../auth/login-throttle.js';
import { hashPassword } from '../auth/password.js';
import { TokenService } from '../auth/token.service.js';
import type { StorageService } from '../files/storage.service.js';
import { AccountDeletionService } from './account-deletion.service.js';

/**
 * Удаление аккаунта — ADR-092.
 *
 * Главное: личное стёрто, спортивная история осталась, аккаунт после этого
 * не войдёт, а телефон свободен (строка `User` удалена целиком).
 */

const SECRET = 'test_secret_at_least_32_characters_long';
const PASSWORD = 'parol123';
const USER = 'user-1';
const PLAYER = 'player-1';
const IP = '10.0.0.1';

const ENV = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: SECRET,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
} as const;

function makePrisma() {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: USER }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      delete: vi.fn().mockResolvedValue({}),
    },
    clubMember: { findMany: vi.fn().mockResolvedValue([]) },
    player: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    coach: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    forumPost: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    forumTopic: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    duel: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    duelResponse: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    trialRequest: { findMany: vi.fn().mockResolvedValue([]) },
    training: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    follow: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    coachTenure: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    registration: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  // Первый вызов — сверка пароля, второй — проверка «последний администратор».
  prisma.user.findUnique.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Promise.resolve(
      select.passwordHash === true ? { passwordHash: hashPassword(PASSWORD) } : { isAdmin: false },
    ),
  );

  // Первый вызов — свой игрок по userId, второй — счётчики истории.
  prisma.player.findUnique.mockImplementation(({ where }: { where: { userId?: string } }) =>
    Promise.resolve(
      where.userId === undefined
        ? { _count: { registrations: 3, ratingEvents: 12, duelsAuthored: 0, duelsOpposed: 0 } }
        : { id: PLAYER, photoUrl: '/api/v1/files/players/p1.jpg' },
    ),
  );

  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const tokens = new TokenService(ENV, new JwtService({ secret: SECRET }));
  const throttle = new LoginThrottle({ JWT_SECRET: SECRET } as Env);
  const storage = { remove: vi.fn().mockResolvedValue(undefined) };
  const service = new AccountDeletionService(
    prisma as unknown as PrismaService,
    tokens,
    throttle,
    storage as unknown as StorageService,
  );

  return { service, tokens, throttle, storage };
}

describe('удаление аккаунта', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('неверный пароль — WRONG_PASSWORD, ничего не стирается', async () => {
    const { service, throttle } = makeService(prisma);
    const failure = vi.spyOn(throttle, 'recordFailure');

    await expect(service.deleteAccount(USER, { password: 'chuzhoi1' }, IP)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
    expect(failure).toHaveBeenCalledOnce();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('аккаунт без пароля так не удалить', async () => {
    prisma.user.findUnique.mockResolvedValue({ passwordHash: null });
    const { service } = makeService(prisma);

    await expect(service.deleteAccount(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
  });

  it('пользователя уже нет — UNAUTHORIZED', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { service } = makeService(prisma);

    await expect(service.deleteAccount(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('единственный владелец клуба — отказ с перечнем клубов', async () => {
    prisma.clubMember.findMany
      .mockResolvedValueOnce([{ clubId: 'club-1' }, { clubId: 'club-2' }])
      .mockResolvedValueOnce([{ clubId: 'club-2' }]);
    const { service } = makeService(prisma);

    await expect(service.deleteAccount(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETE_BLOCKED',
      details: { reason: 'LAST_CLUB_OWNER', clubIds: ['club-1'] },
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('последний администратор — отказ', async () => {
    prisma.user.findUnique.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Promise.resolve(
        select.passwordHash === true ? { passwordHash: hashPassword(PASSWORD) } : { isAdmin: true },
      ),
    );
    prisma.user.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await expect(service.deleteAccount(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETE_BLOCKED',
      details: { reason: 'LAST_ADMIN' },
    });
  });

  it('игрок с историей обезличивается, рейтинг и записи не трогаются', async () => {
    const { service } = makeService(prisma);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    const call = prisma.player.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: PLAYER });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect(call.data).toMatchObject({
      userId: null,
      lastName: '',
      firstName: '',
      middleName: null,
      birthDate: null,
      photoUrl: null,
      clubId: null,
      bio: null,
    });
    expect(call.data).not.toHaveProperty('rating');
    expect(prisma.player.delete).not.toHaveBeenCalled();
  });

  it('игрок без истории удаляется целиком', async () => {
    prisma.player.findUnique.mockImplementation(({ where }: { where: { userId?: string } }) =>
      Promise.resolve(
        where.userId === undefined
          ? { _count: { registrations: 0, ratingEvents: 0, duelsAuthored: 0, duelsOpposed: 0 } }
          : { id: PLAYER, photoUrl: null },
      ),
    );
    const { service } = makeService(prisma);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    expect(prisma.player.delete).toHaveBeenCalledWith({ where: { id: PLAYER } });
    expect(prisma.player.update).not.toHaveBeenCalled();
  });

  it('страница тренера удаляется, а тренировки клуба остаются за клубом', async () => {
    prisma.coach.findMany.mockResolvedValue([
      {
        id: 'coach-1',
        photoUrl: '/api/v1/files/coaches/c1.webp',
        coverUrl: null,
        posts: [],
        media: [],
        credentials: [{ fileKey: '/api/v1/files/coach-docs/d1.webp' }],
      },
    ]);
    const { service, storage } = makeService(prisma);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    expect(prisma.training.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { author: 'CLUB', coachId: { in: ['coach-1'] } } }),
    );
    expect(prisma.coach.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['coach-1'] } } });
    expect(prisma.training.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.coach.deleteMany.mock.invocationCallOrder[0] ?? 0,
    );
    const keys = storage.remove.mock.calls[0]?.[0] as string[];
    expect(keys).toEqual(
      expect.arrayContaining(['players/p1.jpg', 'coaches/c1.webp', 'coach-docs/d1.webp']),
    );
  });

  it('несыгранные дуэли отменяются, а сыгранные остаются', async () => {
    prisma.duel.findMany.mockImplementation(({ where }: { where: { status?: unknown } }) =>
      Promise.resolve(
        where.status === undefined ? [{ id: 'duel-1' }, { id: 'duel-2' }] : [{ id: 'duel-1' }],
      ),
    );
    const { service } = makeService(prisma);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    const calls = prisma.duel.updateMany.mock.calls.map(
      (args) => args[0] as { where: unknown; data: { status?: string } },
    );
    const cancel = calls.find((args) => args.data.status === 'CANCELLED');
    expect(cancel?.where).toEqual({ id: { in: ['duel-1'] } });
    expect(prisma.duel.updateMany).toHaveBeenCalledWith({
      where: { authorId: PLAYER },
      data: { note: null, authorContact: null },
    });
  });

  it('сообщения форума стираются в заглушку, цитаты из них — тоже', async () => {
    prisma.forumPost.findMany.mockResolvedValue([
      { id: 'post-1', images: [{ url: '/api/v1/files/forum/f1.webp', width: 1, height: 1 }] },
    ]);
    const { service, storage } = makeService(prisma);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    expect(prisma.forumPost.updateMany).toHaveBeenCalledWith({
      where: { authorId: USER },
      data: { body: '', images: [], quoteText: null },
    });
    expect(prisma.forumPost.updateMany).toHaveBeenCalledWith({
      where: { quotePostId: { in: ['post-1'] } },
      data: { quoteText: null },
    });
    expect(storage.remove.mock.calls[0]?.[0]).toContain('forum/f1.webp');
  });

  it('журнал хранит только идентификаторы, строка пользователя удаляется последней', async () => {
    const { service } = makeService(prisma);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    const audit = JSON.stringify(prisma.auditLog.create.mock.calls[0]?.[0]);
    expect(audit).toContain('account.deleted');
    expect(audit).not.toContain('+7');
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: USER } });
    expect(prisma.user.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.auditLog.create.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('после удаления токен не проходит', async () => {
    const { service, tokens } = makeService(prisma);
    const token = tokens.issueAccessToken(USER);

    await service.deleteAccount(USER, { password: PASSWORD }, IP);

    expect(tokens.verifyAccessToken(token)).toBeNull();
  });

  it('сбой хранилища удаление не отменяет', async () => {
    const { service, storage } = makeService(prisma);
    storage.remove.mockRejectedValue(new Error('S3 down'));

    await expect(service.deleteAccount(USER, { password: PASSWORD }, IP)).resolves.toBeUndefined();
    expect(prisma.user.delete).toHaveBeenCalled();
  });

  it('пользователь исчез под блокировкой — UNAUTHORIZED', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const { service } = makeService(prisma);

    await expect(service.deleteAccount(USER, { password: PASSWORD }, IP)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});
