import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { isCoachPublic, type CoachPlan } from '@kttf/shared/types';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Страница тренера в объёме, нужном контенту: тариф, владелец, публичность. */
export interface CoachPage {
  readonly plan: CoachPlan;
  readonly userId: string;
  readonly public: boolean;
}

export async function coachPage(prisma: PrismaService, coachId: string): Promise<CoachPage> {
  const coach = await prisma.coach.findUnique({
    where: { id: coachId },
    select: { plan: true, userId: true, status: true, hiddenAt: true },
  });

  if (coach === null) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { id: coachId });
  }

  return {
    plan: coach.plan,
    userId: coach.userId,
    public: isCoachPublic({ status: coach.status, hidden: coach.hiddenAt !== null }),
  };
}

/**
 * Публичные записи и галерея — только у опубликованной страницы (ADR-059).
 * Владелец и администратор видят их и у неопубликованной: так выглядит
 * страница после одобрения. Остальным такой страницы нет.
 */
export async function assertCoachVisible(
  prisma: PrismaService,
  coachId: string,
  viewerId: string | undefined,
): Promise<void> {
  const page = await coachPage(prisma, coachId);

  if (page.public || viewerId === page.userId) return;

  if (viewerId !== undefined) {
    const viewer = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { isAdmin: true },
    });

    if (viewer?.isAdmin === true) return;
  }

  throw new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { id: coachId });
}
