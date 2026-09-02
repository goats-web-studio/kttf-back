import { AppError, ERROR_CODES } from '@kttf/shared/errors';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';

/**
 * Право вести консоль турнира — ТЗ 1, ADR-014, ADR-018.
 *
 * Любая роль в клубе-хозяине: судья турниром не управляет, но счёт вводит
 * именно он. Правило одно на все входы в консоль — ввод счёта по сети, снимок
 * и синхронизация офлайн-очереди: разойдись они, судья, работавший в зале без
 * сети, получил бы отказ на всё введённое за четыре часа.
 */
export async function assertConsoleAccess(
  prisma: PrismaService,
  clubId: string,
  userId: string,
  context: Readonly<Record<string, unknown>>,
): Promise<void> {
  const membership = await prisma.clubMember.findUnique({
    where: { clubId_userId: { clubId, userId } },
    select: { role: true },
  });

  if (membership === null) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not allowed to run this tournament', context);
  }
}
