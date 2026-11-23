import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { type ClubRole, ClubRoleGuard } from './club-role.guard.js';

/**
 * Охрана ролей клуба — ТС 8.3. Администратор платформы проходит в любой
 * клуб (ADR-103): он супервизор и разбирает просьбы владельцев.
 */

function makeGuard(options: {
  roles: ClubRole[] | undefined;
  membership: { role: ClubRole } | null;
  isAdmin?: boolean;
}) {
  const prisma = {
    clubMember: { findUnique: vi.fn().mockResolvedValue(options.membership) },
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: options.isAdmin ?? false }) },
  };
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(options.roles) };
  const guard = new ClubRoleGuard(
    reflector as unknown as Reflector,
    prisma as unknown as PrismaService,
  );
  const request = { userId: 'user-1', params: { id: 'club-1' } };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { guard, prisma, context };
}

describe('ClubRoleGuard', () => {
  it('маршрут без ролей не трогает', async () => {
    const { guard, prisma, context } = makeGuard({ roles: undefined, membership: null });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.clubMember.findUnique).not.toHaveBeenCalled();
  });

  it('пропускает нужную роль, администратора не спрашивает', async () => {
    const { guard, prisma, context } = makeGuard({
      roles: ['OWNER', 'ORGANIZER'],
      membership: { role: 'ORGANIZER' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('чужому клубу — FORBIDDEN', async () => {
    const { guard, context } = makeGuard({ roles: ['OWNER'], membership: { role: 'REFEREE' } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('администратор платформы проходит в любой клуб — ADR-103', async () => {
    const { guard, prisma, context } = makeGuard({
      roles: ['OWNER'],
      membership: null,
      isAdmin: true,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { isAdmin: true },
    });
  });
});
