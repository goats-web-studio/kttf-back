import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../infra/config/env.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { SessionCleanupService } from './session-cleanup.service.js';

/** Уборка истёкших сессий — ADR-131. */

function make(deleteMany = vi.fn().mockResolvedValue({ count: 3 })) {
  const service = new SessionCleanupService(
    { session: { deleteMany } } as unknown as PrismaService,
    { NODE_ENV: 'test' } as Env,
  );

  return { service, deleteMany };
}

describe('уборка истёкших сессий — ADR-131', () => {
  it('удаляет только сессии, чей срок раньше текущего момента', async () => {
    const { service, deleteMany } = make();
    const now = new Date('2026-11-27T10:00:00.000Z');

    expect(await service.purge(now)).toBe(3);
    // Живая сессия (срок позже now) под условие не попадает.
    expect(deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });

  it('в тестах фоновая задача не запускается', () => {
    const { service, deleteMany } = make();

    service.onModuleInit();
    service.onModuleDestroy();

    expect(deleteMany).not.toHaveBeenCalled();
  });
});
