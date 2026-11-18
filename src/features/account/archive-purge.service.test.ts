import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../generated/prisma/client.js';
import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { StorageService } from '../files/storage.service.js';
import { ArchivePurgeService } from './archive-purge.service.js';

/**
 * Срок архива — ADR-095, п. 4: снимок и фото стираются, хеш телефона и
 * ссылка на профиль остаются.
 */

const NOW = new Date('2026-12-20T00:00:00Z');

function make(rows: { playerId: string; photoKey: string | null }[]) {
  const prisma = {
    playerArchive: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: rows.length }),
    },
  };
  const storage = { remove: vi.fn().mockResolvedValue(undefined) };
  const service = new ArchivePurgeService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    { NODE_ENV: 'test' } as Env,
  );

  return { prisma, storage, service };
}

describe('чистка архива', () => {
  it('просроченное: снимок стёрт, фото удалено из хранилища, хеш остаётся', async () => {
    const { prisma, storage, service } = make([
      { playerId: 'p-1', photoKey: 'players/p1.jpg' },
      { playerId: 'p-2', photoKey: null },
    ]);

    await expect(service.purge(NOW)).resolves.toBe(2);

    const where = (prisma.playerArchive.findMany.mock.calls[0]?.[0] as { where: unknown }).where;
    expect(where).toMatchObject({ purgeAt: { lt: NOW } });
    expect(storage.remove).toHaveBeenCalledWith(['players/p1.jpg']);
    expect(prisma.playerArchive.updateMany).toHaveBeenCalledWith({
      where: { playerId: { in: ['p-1', 'p-2'] } },
      data: { snapshot: Prisma.DbNull, photoKey: null },
    });
  });

  it('сбой хранилища: снимок всё равно стёрт, ключ фото остаётся для повтора', async () => {
    const { prisma, storage, service } = make([{ playerId: 'p-1', photoKey: 'players/p1.jpg' }]);
    storage.remove.mockRejectedValue(new Error('S3 down'));

    await service.purge(NOW);

    expect(prisma.playerArchive.updateMany).toHaveBeenCalledWith({
      where: { playerId: { in: ['p-1'] } },
      data: { snapshot: Prisma.DbNull },
    });
  });

  it('нечего чистить — ничего не трогает', async () => {
    const { prisma, storage, service } = make([]);

    await expect(service.purge(NOW)).resolves.toBe(0);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.playerArchive.updateMany).not.toHaveBeenCalled();
  });

  it('в тестах таймер не заводится', () => {
    const { prisma, service } = make([]);

    service.onModuleInit();
    service.onModuleDestroy();

    expect(prisma.playerArchive.findMany).not.toHaveBeenCalled();
  });
});
