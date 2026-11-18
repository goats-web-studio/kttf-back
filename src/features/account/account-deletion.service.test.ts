import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { TokenService } from '../auth/token.service.js';
import type { StorageService } from '../files/storage.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { phoneHash } from './phone-hash.js';

/**
 * Одобрение заявки на удаление — ADR-092, ADR-095.
 *
 * Главное: личное стёрто, но снимок его лёг в архив вместе с хешем телефона,
 * фото осталось в хранилище, спортивная история осталась, аккаунт после
 * этого не войдёт, а телефон свободен (строка `User` удалена целиком).
 */

const SECRET = 'test_secret_at_least_32_characters_long';
const USER = 'user-1';
const ADMIN = 'admin-1';
const PLAYER = 'player-1';
const REQUEST = 'request-1';
const PHONE = '+77010000001';
const NOW = new Date('2026-11-18T10:00:00Z');

const ENV = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: SECRET,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
} as const;

const OWN_PLAYER = {
  id: PLAYER,
  lastName: 'Иванов',
  firstName: 'Пётр',
  middleName: 'Сергеевич',
  birthDate: new Date('1990-05-04T00:00:00Z'),
  birthYearOnly: false,
  photoUrl: '/api/v1/files/players/p1.jpg',
  clubId: 'club-9',
  playingHand: 'RIGHT',
  grip: 'SHAKEHAND',
  blade: 'Viscaria',
  rubberForehand: null,
  rubberBackhand: null,
  bio: 'Играю с детства',
  bladeProductId: null,
  rubberForehandProductId: null,
  rubberBackhandProductId: null,
  coachPlayerId: null,
  coachName: 'Сидоров',
  coachVisibility: 'ALL',
};

function makePrisma() {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: USER, phone: PHONE }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(),
    accountRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: REQUEST,
        kind: 'DELETE',
        status: 'PENDING',
        userId: USER,
        playerId: PLAYER,
        claimedLastName: null,
        claimedFirstName: null,
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    playerArchive: { upsert: vi.fn().mockResolvedValue({}) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ isAdmin: false }),
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
  withHistory(prisma, true);

  return prisma;
}

/** Первый вызов — свой игрок по userId, второй — счётчики истории. */
function withHistory(prisma: ReturnType<typeof makePrisma>, history: boolean): void {
  const count = history ? 3 : 0;

  prisma.player.findUnique.mockImplementation(({ where }: { where: { userId?: string } }) =>
    Promise.resolve(
      where.userId === undefined
        ? {
            _count: {
              registrations: count,
              ratingEvents: count,
              duelsAuthored: 0,
              duelsOpposed: 0,
            },
          }
        : OWN_PLAYER,
    ),
  );
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const tokens = new TokenService(ENV, new JwtService({ secret: SECRET }));
  const storage = { remove: vi.fn().mockResolvedValue(undefined) };
  const service = new AccountDeletionService(
    prisma as unknown as PrismaService,
    tokens,
    storage as unknown as StorageService,
    ENV,
  );

  return { service, tokens, storage };
}

describe('одобрение заявки на удаление', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('решённую заявку второй раз не одобрить', async () => {
    prisma.accountRequest.findUnique.mockResolvedValue({ kind: 'DELETE', status: 'APPROVED' });
    const { service } = makeService(prisma);

    await expect(service.approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('единственный владелец клуба — отказ с перечнем клубов', async () => {
    prisma.clubMember.findMany
      .mockResolvedValueOnce([{ clubId: 'club-1' }, { clubId: 'club-2' }])
      .mockResolvedValueOnce([{ clubId: 'club-2' }]);
    const { service } = makeService(prisma);

    await expect(service.approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETE_BLOCKED',
      details: { reason: 'LAST_CLUB_OWNER', clubIds: ['club-1'] },
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('последний администратор — отказ', async () => {
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });
    prisma.user.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await expect(service.approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETE_BLOCKED',
      details: { reason: 'LAST_ADMIN' },
    });
  });

  it('архив: снимок личных полей, хеш телефона, срок 30 дней, фото остаётся', async () => {
    const { service, storage } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    const archive = prisma.playerArchive.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
    };
    expect(archive.create).toMatchObject({
      playerId: PLAYER,
      phoneHash: phoneHash(SECRET, PHONE),
      photoKey: 'players/p1.jpg',
      purgeAt: new Date('2026-12-18T10:00:00Z'),
      snapshot: {
        lastName: 'Иванов',
        firstName: 'Пётр',
        middleName: 'Сергеевич',
        birthDate: '1990-05-04',
        photoUrl: '/api/v1/files/players/p1.jpg',
        clubId: 'club-9',
        bio: 'Играю с детства',
        coachName: 'Сидоров',
      },
    });
    // Сам номер в архив не попадает.
    expect(JSON.stringify(archive)).not.toContain(PHONE);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('игрок с историей обезличивается, рейтинг и записи не трогаются', async () => {
    const { service } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    const call = prisma.player.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: PLAYER });
    expect(call.data.deletedAt).toEqual(NOW);
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

  it('игрок без истории удаляется целиком, без архива, фото — из хранилища', async () => {
    withHistory(prisma, false);
    const { service, storage } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    expect(prisma.player.delete).toHaveBeenCalledWith({ where: { id: PLAYER } });
    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(prisma.playerArchive.upsert).not.toHaveBeenCalled();
    expect(storage.remove.mock.calls[0]?.[0]).toContain('players/p1.jpg');
  });

  it('заявка одобрена администратором, прочие заявки человека отменены', async () => {
    const { service } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    expect(prisma.accountRequest.update).toHaveBeenCalledWith({
      where: { id: REQUEST },
      data: { status: 'APPROVED', decidedAt: NOW, decidedById: ADMIN },
    });
    expect(prisma.accountRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, status: 'PENDING', NOT: { id: REQUEST } },
      data: { status: 'CANCELLED', decidedAt: NOW },
    });
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

    await service.approve(REQUEST, ADMIN, NOW);

    expect(prisma.training.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { author: 'CLUB', coachId: { in: ['coach-1'] } } }),
    );
    expect(prisma.coach.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['coach-1'] } } });
    const keys = storage.remove.mock.calls[0]?.[0] as string[];
    expect(keys).toEqual(expect.arrayContaining(['coaches/c1.webp', 'coach-docs/d1.webp']));
    expect(keys).not.toContain('players/p1.jpg');
  });

  it('несыгранные дуэли отменяются, а сыгранные остаются', async () => {
    prisma.duel.findMany.mockImplementation(({ where }: { where: { status?: unknown } }) =>
      Promise.resolve(
        where.status === undefined ? [{ id: 'duel-1' }, { id: 'duel-2' }] : [{ id: 'duel-1' }],
      ),
    );
    const { service } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    const calls = prisma.duel.updateMany.mock.calls.map(
      (args) => args[0] as { where: unknown; data: { status?: string } },
    );
    const cancel = calls.find((args) => args.data.status === 'CANCELLED');
    expect(cancel?.where).toEqual({ id: { in: ['duel-1'] } });
  });

  it('сообщения форума стираются в заглушку, цитаты из них — тоже', async () => {
    prisma.forumPost.findMany.mockResolvedValue([
      { id: 'post-1', images: [{ url: '/api/v1/files/forum/f1.webp', width: 1, height: 1 }] },
    ]);
    const { service, storage } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    expect(prisma.forumPost.updateMany).toHaveBeenCalledWith({
      where: { authorId: USER },
      data: { body: '', images: [], quoteText: null },
    });
    expect(storage.remove.mock.calls[0]?.[0]).toContain('forum/f1.webp');
  });

  it('журнал: только идентификаторы, автор — администратор; строка пользователя последней', async () => {
    const { service } = makeService(prisma);

    await service.approve(REQUEST, ADMIN, NOW);

    const audit = prisma.auditLog.create.mock.calls[0]?.[0] as {
      data: { actorId: string; action: string };
    };
    expect(audit.data).toMatchObject({ actorId: ADMIN, action: 'account.deleted' });
    expect(JSON.stringify(audit)).not.toContain(PHONE);
    expect(JSON.stringify(audit)).not.toContain('Иванов');
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: USER } });
    expect(prisma.user.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.auditLog.create.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('после одобрения токен удалённого не проходит', async () => {
    const { service, tokens } = makeService(prisma);
    const token = tokens.issueAccessToken(USER);

    await service.approve(REQUEST, ADMIN, NOW);

    expect(tokens.verifyAccessToken(token)).toBeNull();
  });

  it('сбой хранилища удаление не отменяет', async () => {
    withHistory(prisma, false);
    const { service, storage } = makeService(prisma);
    storage.remove.mockRejectedValue(new Error('S3 down'));

    await expect(service.approve(REQUEST, ADMIN, NOW)).resolves.toBeUndefined();
    expect(prisma.user.delete).toHaveBeenCalled();
  });

  it('аккаунт исчез под блокировкой — NOT_FOUND', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const { service } = makeService(prisma);

    await expect(service.approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});
