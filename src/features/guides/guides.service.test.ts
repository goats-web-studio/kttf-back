import { AppError } from '@kttf/shared/errors';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { GuidesService } from './guides.service.js';

function serviceWith({ isAdmin = false, staff = 0 } = {}) {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ isAdmin }) },
    clubMember: { count: vi.fn().mockResolvedValue(staff) },
  };
  return { prisma, service: new GuidesService(prisma as unknown as PrismaService) };
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'OTHER';
  }
}

describe('руководства на сайте — ADR-144', () => {
  it('игроку — всем, на языке интерфейса, со скриншотами на нём же', async () => {
    const { service } = serviceWith();
    const guide = await service.guide('player', 'kk');

    expect(guide).toMatchObject({ kind: 'player', locale: 'kk', shots: 'kk' });
    expect(guide.markdown).toContain('## ');
  });

  it('язык без своих скриншотов берёт английские', async () => {
    const { service } = serviceWith();

    expect(await service.guide('player', 'ja')).toMatchObject({ locale: 'ja', shots: 'en' });
  });

  it('неизвестный язык — английский текст', async () => {
    const { service } = serviceWith();

    expect(await service.guide('player', 'xx')).toMatchObject({ locale: 'en', shots: 'en' });
    expect(await service.guide('player', undefined)).toMatchObject({ locale: 'en' });
  });

  it('организатору — только владельцам и организаторам клубов', async () => {
    const { prisma, service } = serviceWith({ staff: 0 });

    expect(await refusal(service.guide('organizer', 'ru', 'user-1'))).toBe('FORBIDDEN');
    expect(prisma.clubMember.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', role: { in: ['OWNER', 'ORGANIZER'] } },
    });
  });

  it('без входа — отказ, а не текст', async () => {
    const { service } = serviceWith({ staff: 1 });

    expect(await refusal(service.guide('organizer', 'ru'))).toBe('UNAUTHORIZED');
  });

  it('организатор клуба и администратор читают', async () => {
    expect(
      (await serviceWith({ staff: 1 }).service.guide('organizer', 'ru', 'user-1')).locale,
    ).toBe('ru');
    expect(
      (await serviceWith({ isAdmin: true }).service.guide('organizer', 'en', 'user-1')).locale,
    ).toBe('en');
  });
});
