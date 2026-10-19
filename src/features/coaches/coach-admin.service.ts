import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  CoachApplicationView,
  CoachView,
  ListCoachApplicationsQuery,
  Page,
  SetCoachHiddenInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { countStudents } from './coach-students.js';
import { coachFields, toApplicationView } from './coach-view.js';
import { CoachesService, statusInvalid } from './coaches.service.js';

/**
 * Разбор заявок тренеров и постмодерация — администратор платформы
 * (ADR-059, `docs/11` 4.5). Заявка — статус самой страницы, поэтому
 * администратор видит ровно то, что опубликует.
 */
@Injectable()
export class CoachAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coaches: CoachesService,
  ) {}

  /** Свежие отправленные сверху; ни разу не отправленные — в конце. */
  async list(query: ListCoachApplicationsQuery): Promise<Page<CoachApplicationView>> {
    const where = query.status === undefined ? {} : { status: query.status };
    const [rows, total] = await Promise.all([
      this.prisma.coach.findMany({
        where,
        select: coachFields,
        orderBy: [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.coach.count({ where }),
    ]);
    const students = await countStudents(
      this.prisma,
      rows.map((coach) => coach.playerId),
    );

    return pageOf(
      rows.map((coach) => toApplicationView(coach, students.get(coach.playerId) ?? 0)),
      total,
      query,
    );
  }

  /** Одобрить — только заявку на проверке. */
  async approve(id: string, now = new Date()): Promise<CoachApplicationView> {
    await this.review(id, { status: 'APPROVED', reviewedAt: now, rejectReason: null });

    return this.findOne(id);
  }

  /** Отклонить с причиной: тренер увидит её в кабинете и поправит страницу. */
  async reject(id: string, reason: string, now = new Date()): Promise<CoachApplicationView> {
    await this.review(id, { status: 'REJECTED', reviewedAt: now, rejectReason: reason });

    return this.findOne(id);
  }

  /** Скрыть страницу или вернуть. Снятие стирает и причину. */
  async setHidden(id: string, input: SetCoachHiddenInput): Promise<CoachApplicationView> {
    const { count } = await this.prisma.coach.updateMany({
      where: { id },
      data: input.hidden
        ? { hiddenAt: new Date(), hiddenReason: input.reason ?? null }
        : { hiddenAt: null, hiddenReason: null },
    });

    if (count === 0) throw notFound(id);

    return this.findOne(id);
  }

  /** «Проверено KTTF» у документа — администратор сверил его по скану. */
  async verifyCredential(
    coachId: string,
    credentialId: string,
    verified: boolean,
  ): Promise<CoachView> {
    const { count } = await this.prisma.coachCredential.updateMany({
      where: { id: credentialId, coachId },
      data: { verifiedAt: verified ? new Date() : null },
    });

    if (count === 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Credential not found', { credentialId });
    }

    return this.coaches.findById(coachId);
  }

  /**
   * Решение по заявке. Условие на статус — в самом обновлении: два
   * администратора, нажавшие одновременно, не перепишут решение друг друга.
   */
  private async review(
    id: string,
    data: { status: 'APPROVED' | 'REJECTED'; reviewedAt: Date; rejectReason: string | null },
  ): Promise<void> {
    const { count } = await this.prisma.coach.updateMany({
      where: { id, status: 'PENDING' },
      data,
    });

    if (count > 0) return;

    const coach = await this.prisma.coach.findUnique({ where: { id }, select: { status: true } });

    throw coach === null ? notFound(id) : statusInvalid(coach.status);
  }

  private async findOne(id: string): Promise<CoachApplicationView> {
    const coach = await this.prisma.coach.findUnique({ where: { id }, select: coachFields });

    if (coach === null) throw notFound(id);

    const students = await countStudents(this.prisma, [coach.playerId]);

    return toApplicationView(coach, students.get(coach.playerId) ?? 0);
  }
}

function notFound(id: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { id });
}
