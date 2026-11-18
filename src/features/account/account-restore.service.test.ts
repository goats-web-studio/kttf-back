import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { AccountRestoreService } from './account-restore.service.js';
import { phoneHash } from './phone-hash.js';

/**
 * Одобрение восстановления — ADR-095, п. 5: профиль возвращается аккаунту,
 * личные поля — из снимка, пока он жив, иначе названное в заявке имя.
 */

const SECRET = 'test_secret_at_least_32_characters_long';
const USER = 'user-2';
const ADMIN = 'admin-1';
const ARCHIVED = 'archived-1';
const REQUEST = 'request-1';
const PHONE = '+77010000001';
const NOW = new Date('2026-11-25T10:00:00Z');

const SNAPSHOT = {
  lastName: 'Иванов',
  firstName: 'Пётр',
  middleName: 'Сергеевич',
  birthDate: '1990-05-04',
  birthYearOnly: false,
  photoUrl: '/api/v1/files/players/p1.jpg',
  clubId: 'club-9',
  playingHand: 'RIGHT',
  grip: 'SHAKEHAND',
  blade: 'Viscaria',
  rubberForehand: null,
  rubberBackhand: null,
  bio: 'Играю с детства',
  bladeProductId: 'product-gone',
  rubberForehandProductId: null,
  rubberBackhandProductId: null,
  coachPlayerId: null,
  coachName: 'Сидоров',
  coachVisibility: 'ALL',
};

const merge = {
  id: 'own-1',
  userId: USER,
  confirmedAt: null as Date | null,
  deletedAt: null,
  birthYear: 1990,
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
  bio: 'Новая анкета',
};

function makePrisma() {
  const updated = { count: 0 };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    accountRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: REQUEST,
        kind: 'RESTORE',
        status: 'PENDING',
        userId: USER,
        playerId: ARCHIVED,
        claimedLastName: 'Иванов',
        claimedFirstName: 'Петя',
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ phone: PHONE }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    player: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...merge, id: ARCHIVED, userId: null }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue(updated),
      delete: vi.fn().mockResolvedValue({}),
    },
    club: { findUnique: vi.fn().mockResolvedValue({ id: 'club-9' }) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    playerArchive: { delete: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    coach: { updateMany: vi.fn().mockResolvedValue(updated) },
    coachTenure: { updateMany: vi.fn().mockResolvedValue(updated) },
    registration: { updateMany: vi.fn().mockResolvedValue(updated) },
    duel: { updateMany: vi.fn().mockResolvedValue(updated) },
    duelResponse: { updateMany: vi.fn().mockResolvedValue(updated) },
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));
  withState(prisma, { snapshot: SNAPSHOT, own: null });

  return prisma;
}

function withState(
  prisma: ReturnType<typeof makePrisma>,
  state: {
    snapshot: unknown;
    own: typeof merge | null;
    target?: Partial<{ userId: string | null; deletedAt: Date | null }>;
  },
): void {
  prisma.player.findUnique.mockImplementation(({ where }: { where: { userId?: string } }) =>
    Promise.resolve(
      where.userId === undefined
        ? {
            id: ARCHIVED,
            userId: null,
            deletedAt: new Date('2026-11-18T10:00:00Z'),
            archive: { phoneHash: phoneHash(SECRET, PHONE), snapshot: state.snapshot },
            ...state.target,
          }
        : state.own,
    ),
  );
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new AccountRestoreService(
    prisma as unknown as PrismaService,
    {
      JWT_SECRET: SECRET,
    } as Env,
  );
}

describe('одобрение восстановления', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('профиль возвращается аккаунту с личными полями из снимка', async () => {
    await makeService(prisma).approve(REQUEST, ADMIN, NOW);

    const restore = prisma.player.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(restore.where).toEqual({ id: ARCHIVED });
    expect(restore.data).toMatchObject({
      deletedAt: null,
      lastName: 'Иванов',
      firstName: 'Пётр',
      middleName: 'Сергеевич',
      birthDate: new Date('1990-05-04'),
      photoUrl: '/api/v1/files/players/p1.jpg',
      clubId: 'club-9',
      coachName: 'Сидоров',
      // Товара каталога больше нет — висячая ссылка не возвращается.
      bladeProductId: null,
    });
    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: ARCHIVED },
      data: { userId: USER },
      select: { cityId: true },
    });
    // Город аккаунта — из вернувшегося профиля, если своего нет (ADR-093).
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER, cityId: null } }),
    );
    expect(prisma.playerArchive.delete).toHaveBeenCalledWith({ where: { playerId: ARCHIVED } });
    expect(prisma.accountRequest.update).toHaveBeenCalledWith({
      where: { id: REQUEST },
      data: { status: 'APPROVED', decidedAt: NOW, decidedById: ADMIN },
    });
    const audit = JSON.stringify(prisma.auditLog.create.mock.calls[0]?.[0]);
    expect(audit).toContain('account.restored');
    expect(audit).not.toContain('Иванов');
  });

  it('снимок стёрт — профиль называется именем из заявки', async () => {
    withState(prisma, { snapshot: null, own: null });

    await makeService(prisma).approve(REQUEST, ADMIN, NOW);

    expect(prisma.player.update.mock.calls[0]?.[0]).toEqual({
      where: { id: ARCHIVED },
      data: { lastName: 'Иванов', firstName: 'Петя', deletedAt: null },
    });
  });

  it('у аккаунта подтверждённый профиль — HAS_PROFILE, ничего не меняется', async () => {
    withState(prisma, { snapshot: SNAPSHOT, own: { ...merge, confirmedAt: NOW } });

    await expect(makeService(prisma).approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTORE_INVALID',
      details: { reason: 'HAS_PROFILE' },
    });
    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(prisma.playerArchive.delete).not.toHaveBeenCalled();
  });

  it('профиль уже вернули — PROFILE_TAKEN', async () => {
    withState(prisma, {
      snapshot: SNAPSHOT,
      own: null,
      target: { userId: 'someone', deletedAt: null },
    });

    await expect(makeService(prisma).approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTORE_INVALID',
      details: { reason: 'PROFILE_TAKEN' },
    });
  });

  it('номер аккаунта не совпал с архивом — NOTHING_ARCHIVED', async () => {
    prisma.user.findUnique.mockResolvedValue({ phone: '+77019999999' });

    await expect(makeService(prisma).approve(REQUEST, ADMIN, NOW)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTORE_INVALID',
      details: { reason: 'NOTHING_ARCHIVED' },
    });
  });

  it('неподтверждённая анкета заменяется архивным профилем', async () => {
    withState(prisma, { snapshot: SNAPSHOT, own: merge });

    await makeService(prisma).approve(REQUEST, ADMIN, NOW);

    expect(prisma.player.delete).toHaveBeenCalledWith({ where: { id: 'own-1' } });
    // Анкета освобождает аккаунт раньше, чем архивный профиль его получит.
    const link = prisma.player.update.mock.calls.findIndex(
      (args) => (args[0] as { data: { userId?: string } }).data.userId === USER,
    );
    expect(prisma.player.delete.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.player.update.mock.invocationCallOrder[link] ?? 0,
    );
  });
});
