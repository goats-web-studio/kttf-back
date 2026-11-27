import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { GuideKind, GuideView } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { GUIDES, type GuideLocale } from './guides.content.js';

/** Нет перевода на язык интерфейса — английский: его читают все. */
const FALLBACK: GuideLocale = 'en';

/** Скриншоты сняты на трёх языках; остальным — английские. */
const SHOTS: Readonly<Record<GuideLocale, GuideView['shots']>> = {
  kk: 'kk',
  ru: 'ru',
  en: 'en',
  zh: 'en',
  ja: 'en',
  ko: 'en',
};

/**
 * Руководства на сайте — ADR-144.
 *
 * Текст лежит в коде (`guides.content.ts`, собирается из исходников
 * руководств): он меняется вместе с интерфейсом, который описывает, и
 * выходит с той же выкладкой.
 */
@Injectable()
export class GuidesService {
  constructor(private readonly prisma: PrismaService) {}

  async guide(kind: GuideKind, locale: string | undefined, userId?: string): Promise<GuideView> {
    if (kind === 'organizer') await this.assertOrganizer(userId);

    const wanted = (locale ?? '').toLowerCase();
    const texts = GUIDES[kind];
    const chosen: GuideLocale =
      isGuideLocale(wanted) && texts[wanted] !== undefined ? wanted : FALLBACK;

    return { kind, locale: chosen, shots: SHOTS[chosen], markdown: texts[chosen] ?? '' };
  }

  /**
   * Руководство организатора — владельцам и организаторам клубов и
   * администраторам KTTF. Судье хватает консоли, игроку — своего
   * руководства.
   */
  private async assertOrganizer(userId: string | undefined): Promise<void> {
    if (userId === undefined) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Sign in to read the organizer guide');
    }

    const [user, staff] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
      this.prisma.clubMember.count({ where: { userId, role: { in: ['OWNER', 'ORGANIZER'] } } }),
    ]);

    if (user?.isAdmin !== true && staff === 0) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'The organizer guide is for club staff', {
        reason: 'NOT_ORGANIZER',
      });
    }
  }
}

function isGuideLocale(value: string): value is GuideLocale {
  return value in SHOTS;
}
