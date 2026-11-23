import { Prisma } from '../../generated/prisma/client.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { AdminPlayersService, adminPlayersWhere } from './admin-players.service.js';

/**
 * Профили игроков у администратора — ADR-103: все живые, и анкеты тоже;
 * подтверждение анкеты без клуба — тем же событием INITIAL, что у
 * организатора (ADR-072).
 */

const ADMIN = 'admin-1';

const row = {
  id: 'sheet-1',
  lastName: 'Ким',
  firstName: 'Артём',
  middleName: null,
  birthYear: 2000,
  gender: 'MALE',
  city: { id: 'city-1', name: 'Алматы' },
  club: null,
  rating: new Prisma.Decimal(425),
  confirmedAt: new Date(),
  user: { id: 'user-1', login: 'kim', phone: '+77010000001' },
  createdAt: new Date('2026-11-01T10:00:00Z'),
  _count: { registrations: 4 },
};

function makePrisma() {
  const prisma = {
    $transaction: vi.fn(),
    player: {
      findUnique: vi.fn().mockResolvedValue({ deletedAt: null }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ratingEvent: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };

  prisma.$transaction.mockImplementation((run: (tx: typeof prisma) => unknown) => run(prisma));

  return prisma;
}

describe('поиск профилей', () => {
  it('только живые', () => {
    expect(adminPlayersWhere({})).toEqual({ deletedAt: null });
  });

  it('фильтры', () => {
    expect(adminPlayersWhere({ filter: 'unconfirmed' })).toEqual({
      deletedAt: null,
      confirmedAt: null,
    });
    expect(adminPlayersWhere({ filter: 'noAccount' })).toEqual({ deletedAt: null, userId: null });
    expect(adminPlayersWhere({ filter: 'withAccount' })).toEqual({
      deletedAt: null,
      userId: { not: null },
    });
  });

  it('«Фамилия Имя» одной строкой — каждое слово в любом из полей имени', () => {
    const where = adminPlayersWhere({ search: 'Ким Артём' });

    expect(where.AND).toHaveLength(2);
    expect(JSON.stringify(where.AND)).toContain('"lastName":{"contains":"Артём"');
  });
});

describe('подтверждение анкеты', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('ставит рейтинг событием INITIAL и пишет в журнал', async () => {
    const service = new AdminPlayersService(prisma as unknown as PrismaService);

    const item = await service.confirm('sheet-1', { startRating: 425 }, ADMIN);

    expect(prisma.player.updateMany).toHaveBeenCalledWith({
      where: { id: 'sheet-1', confirmedAt: null },
      data: { confirmedAt: expect.any(Date) as Date, rating: 425 },
    });
    expect(prisma.ratingEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        playerId: 'sheet-1',
        type: 'INITIAL',
        ratingAfter: 425,
      }) as object,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: ADMIN,
        action: 'player.confirm',
        entityType: 'Player',
        entityId: 'sheet-1',
      }) as object,
    });
    expect(item).toMatchObject({ confirmed: true, rating: '425', tournaments: 4 });
  });

  it('уже подтверждённый — отказ, рейтинг не трогается', async () => {
    prisma.player.updateMany.mockResolvedValue({ count: 0 });
    prisma.player.findUnique.mockResolvedValue({ id: 'sheet-1', deletedAt: null });
    const service = new AdminPlayersService(prisma as unknown as PrismaService);

    await expect(service.confirm('sheet-1', { startRating: 425 }, ADMIN)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.ratingEvent.create).not.toHaveBeenCalled();
  });

  it('удалённый — NOT_FOUND', async () => {
    prisma.player.findUnique.mockResolvedValue({ deletedAt: new Date() });
    const service = new AdminPlayersService(prisma as unknown as PrismaService);

    await expect(service.confirm('sheet-1', { startRating: 425 }, ADMIN)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
