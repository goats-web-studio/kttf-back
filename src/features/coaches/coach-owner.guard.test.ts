import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { CoachOwnerGuard } from './coach-owner.guard.js';

const COACH_ID = '11111111-1111-4111-8111-111111111111';

function contextOf(userId: string | undefined): ExecutionContext {
  const request = { userId, params: { id: COACH_ID } };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makePrisma() {
  return {
    coach: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-owner' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) },
  };
}

let prisma: ReturnType<typeof makePrisma>;
let guard: CoachOwnerGuard;

beforeEach(() => {
  prisma = makePrisma();
  guard = new CoachOwnerGuard(prisma as unknown as PrismaService);
});

describe('владелец страницы тренера', () => {
  it('владелец проходит', async () => {
    await expect(guard.canActivate(contextOf('user-owner'))).resolves.toBe(true);
  });

  it('чужой — FORBIDDEN', async () => {
    await expect(guard.canActivate(contextOf('user-stranger'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('несуществующая страница — тот же FORBIDDEN, что и чужая', async () => {
    prisma.coach.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(contextOf('user-stranger'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('администратор правит любую страницу', async () => {
    prisma.user.findUnique.mockResolvedValue({ isAdmin: true });

    await expect(guard.canActivate(contextOf('user-admin'))).resolves.toBe(true);
  });

  it('без пользователя — UNAUTHORIZED', async () => {
    await expect(guard.canActivate(contextOf(undefined))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
