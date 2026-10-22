import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  TRIAL_REQUESTS_PER_DAY,
  trainingBookingTarget,
  type AnswerTrialRequestInput,
  type CreateTrialRequestInput,
  type IncomingTrialRequestView,
  type ListTrialRequestsQuery,
  type Page,
  type TrialRequestView,
  type TrialRequestsCount,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { clubDate } from '../clubs/club-stats.service.js';
import { isTrainingPublic, toTrainingView, trainingFields } from '../coaches/training-view.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  incomingTrialFields,
  requesterFields,
  requesterName,
  targetOf,
  toIncomingTrialRequestView,
  toTrialRequestView,
  trialFields,
  type IncomingTrialRecord,
  type TrialRecord,
} from './trial-request-view.js';

/** Ящик заявок: страница тренера или клуб. */
export interface TrialInbox {
  readonly kind: 'COACH' | 'CLUB';
  readonly id: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Кто в клубе принимает заявки — те же роли, что ведут его страницу. */
const CLUB_INBOX_ROLES = ['OWNER', 'ORGANIZER'] as const;

/**
 * Заявка на пробную тренировку с сайта — T3 (ADR-059, `docs/11` 3.3.3).
 *
 * Адресат — тот, кто записывает на тренировку (`trainingBookingTarget`),
 * снимком на момент отправки. Новая заявка, отзыв и ответ пишутся одной
 * транзакцией с уведомлением второй стороне; новая — ещё и со строкой
 * «заявки с сайта» в статистике адресата.
 */
@Injectable()
export class TrialRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    trainingId: string,
    userId: string,
    input: CreateTrialRequestInput,
    now = new Date(),
  ): Promise<TrialRequestView> {
    const training = await this.prisma.training.findUnique({
      where: { id: trainingId },
      select: trainingFields,
    });

    // Непубличная тренировка для отправителя не существует — как в «Подробнее».
    if (training === null || !isTrainingPublic(training)) throw trainingNotFound(trainingId);

    // Адресат считается по тому же виду, что видит посетитель на странице.
    const target = trainingBookingTarget(toTrainingView(training, false));

    if (target === null) throw trainingNotFound(trainingId);

    const inbox: TrialInbox =
      target.kind === 'COACH'
        ? { kind: 'COACH', id: target.coach.id }
        : { kind: 'CLUB', id: target.club.id };
    const recipients = await this.inboxUsers(inbox);

    if (recipients.includes(userId)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot send a trial request to yourself', {
        trainingId,
      });
    }

    const [open, recent, user] = await Promise.all([
      this.prisma.trialRequest.findFirst({
        where: { trainingId, userId, status: 'NEW' },
        select: { id: true },
      }),
      this.prisma.trialRequest.count({
        where: { userId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: requesterFields }),
    ]);

    if (user === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User not found');
    }

    if (open !== null) {
      throw new AppError(ERROR_CODES.TRIAL_REQUEST_EXISTS, 'Trial request already waits', {
        id: open.id,
      });
    }

    if (recent >= TRIAL_REQUESTS_PER_DAY) {
      throw new AppError(ERROR_CODES.TRIAL_REQUEST_LIMIT, 'Too many trial requests today', {
        max: TRIAL_REQUESTS_PER_DAY,
      });
    }

    const date = clubDate(now);
    const created = await this.prisma.$transaction(async (tx) => {
      // Двойное нажатие «Отправить»: заявки одного человека идут по очереди,
      // и вторая видит первую. Частичный уникальный индекс схема Prisma не
      // выражает — следующая миграция его бы сняла.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const duplicate = await tx.trialRequest.findFirst({
        where: { trainingId, userId, status: 'NEW' },
        select: { id: true },
      });

      if (duplicate !== null) {
        throw new AppError(ERROR_CODES.TRIAL_REQUEST_EXISTS, 'Trial request already waits', {
          id: duplicate.id,
        });
      }

      const record = await tx.trialRequest.create({
        data: {
          trainingId,
          userId,
          targetKind: inbox.kind,
          coachId: inbox.kind === 'COACH' ? inbox.id : null,
          clubId: inbox.kind === 'CLUB' ? inbox.id : null,
          forWhom: input.forWhom,
          childAge: input.childAge ?? null,
          preferredTime: input.preferredTime ?? null,
          comment: input.comment ?? null,
          source: input.source,
          createdAt: now,
        },
        select: trialFields,
      });

      if (inbox.kind === 'COACH') {
        await tx.coachStatDaily.upsert({
          where: { coachId_date_source: { coachId: inbox.id, date, source: input.source } },
          create: { coachId: inbox.id, date, source: input.source, trialRequests: 1 },
          update: { trialRequests: { increment: 1 } },
        });
      } else {
        await tx.clubStatDaily.upsert({
          where: { clubId_date_source: { clubId: inbox.id, date, source: input.source } },
          create: { clubId: inbox.id, date, source: input.source, trialRequests: 1 },
          update: { trialRequests: { increment: 1 } },
        });
      }

      await this.notifications.create(tx, recipients, 'TRIAL_REQUEST_NEW', {
        trialRequestId: record.id,
        trainingTitle: record.training.title,
        requesterName: requesterName(user),
        inbox: inboxRef(record),
      });

      return record;
    });

    return toTrialRequestView(created);
  }

  /** «Мои заявки», новые первыми. */
  async listMine(userId: string, query: ListTrialRequestsQuery): Promise<Page<TrialRequestView>> {
    const where: Prisma.TrialRequestWhereInput = {
      userId,
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.trialRequest.findMany({
        where,
        select: trialFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.trialRequest.count({ where }),
    ]);

    return pageOf(rows.map(toTrialRequestView), total, query);
  }

  /** Отзыв — только отправителем и только новой. Адресату уходит уведомление. */
  async cancel(id: string, userId: string): Promise<TrialRequestView> {
    const record = await this.load(id);

    if (record.userId !== userId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the sender cancels', { id });
    }

    const recipients = await this.inboxUsers(inboxOf(record));

    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, record, { status: 'CANCELLED' });
      await this.notifications.create(tx, recipients, 'TRIAL_REQUEST_CANCELLED', {
        trialRequestId: record.id,
        trainingTitle: record.training.title,
        requesterName: requesterName(record.user),
        inbox: inboxRef(record),
      });
    });

    return toTrialRequestView(await this.load(id));
  }

  /** Ответ адресата — тренера или OWNER и ORGANIZER клуба — на новую заявку. */
  async answer(
    id: string,
    userId: string,
    input: AnswerTrialRequestInput,
    now = new Date(),
  ): Promise<IncomingTrialRequestView> {
    const record = await this.load(id);
    const recipients = await this.inboxUsers(inboxOf(record));

    if (!recipients.includes(userId)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the addressee answers', { id });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, record, {
        status: input.status,
        reply: input.reply ?? null,
        answeredAt: now,
        answeredById: userId,
      });
      await this.notifications.create(tx, [record.userId], 'TRIAL_REQUEST_ANSWERED', {
        trialRequestId: record.id,
        trainingTitle: record.training.title,
        status: input.status,
        targetName: targetOf(record).name,
      });
    });

    return toIncomingTrialRequestView(await this.load(id));
  }

  /** Входящие тренера или клуба, новые первыми. */
  async incoming(
    inbox: TrialInbox,
    userId: string,
    query: ListTrialRequestsQuery,
  ): Promise<Page<IncomingTrialRequestView>> {
    await this.assertInbox(inbox, userId);

    const where: Prisma.TrialRequestWhereInput = {
      ...inboxWhere(inbox),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.trialRequest.findMany({
        where,
        select: incomingTrialFields,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.trialRequest.count({ where }),
    ]);

    return pageOf(rows.map(toIncomingTrialRequestView), total, query);
  }

  /** Число новых — метка на вкладке «Заявки» кабинета. */
  async count(inbox: TrialInbox, userId: string): Promise<TrialRequestsCount> {
    await this.assertInbox(inbox, userId);

    return {
      new: await this.prisma.trialRequest.count({
        where: { ...inboxWhere(inbox), status: 'NEW' },
      }),
    };
  }

  /**
   * Кто принимает заявки ящика: владелец страницы тренера или OWNER и
   * ORGANIZER клуба. Им же уходят уведомления.
   */
  private async inboxUsers(inbox: TrialInbox): Promise<string[]> {
    if (inbox.kind === 'COACH') {
      const coach = await this.prisma.coach.findUnique({
        where: { id: inbox.id },
        select: { userId: true },
      });

      return coach === null ? [] : [coach.userId];
    }

    const members = await this.prisma.clubMember.findMany({
      where: { clubId: inbox.id, role: { in: [...CLUB_INBOX_ROLES] } },
      select: { userId: true },
    });

    return members.map((member) => member.userId);
  }

  /**
   * Читать ящик — его адресат или администратор платформы. Один отказ и для
   * чужого ящика, и для несуществующего, как у `CoachOwnerGuard`.
   */
  private async assertInbox(inbox: TrialInbox, userId: string): Promise<void> {
    const [recipients, user] = await Promise.all([
      this.inboxUsers(inbox),
      this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
    ]);

    if (recipients.includes(userId) || user?.isAdmin === true) return;

    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not your trial requests', {
      kind: inbox.kind,
      id: inbox.id,
    });
  }

  /**
   * Смена статуса новой заявки. Условие на статус — в самом обновлении: отзыв
   * и ответ одновременно не перепишут друг друга.
   */
  private async move(
    tx: Prisma.TransactionClient,
    record: TrialRecord,
    data: Prisma.TrialRequestUncheckedUpdateManyInput,
  ): Promise<void> {
    if (record.status === 'NEW') {
      const updated = await tx.trialRequest.updateMany({
        where: { id: record.id, status: 'NEW' },
        data,
      });

      if (updated.count > 0) return;
    }

    const fresh = await tx.trialRequest.findUnique({
      where: { id: record.id },
      select: { status: true },
    });

    throw new AppError(ERROR_CODES.TRIAL_REQUEST_INVALID, 'Trial request is not new', {
      status: fresh?.status ?? record.status,
    });
  }

  private async load(id: string): Promise<IncomingTrialRecord> {
    const record = await this.prisma.trialRequest.findUnique({
      where: { id },
      select: incomingTrialFields,
    });

    if (record === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Trial request not found', { id });
    }

    return record;
  }
}

function inboxOf(record: TrialRecord): TrialInbox {
  const target = targetOf(record);

  return { kind: target.kind, id: target.id };
}

/** Ссылка на ящик в уведомлении: тренер своей страницей или клуб. */
function inboxRef(record: TrialRecord): { kind: 'COACH' | 'CLUB'; id: string; name: string } {
  const target = targetOf(record);

  return { kind: target.kind, id: target.id, name: target.name };
}

function inboxWhere(inbox: TrialInbox): Prisma.TrialRequestWhereInput {
  return inbox.kind === 'COACH' ? { coachId: inbox.id } : { clubId: inbox.id };
}

function trainingNotFound(id: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Training not found', { id });
}
