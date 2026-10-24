import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { DUEL_CONFIRM_HOURS } from '@kttf/shared/rating';
import {
  DUEL_ACTIVE_STATUSES,
  DUEL_CHALLENGES_PER_DAY,
  DUEL_OPEN_MAX,
  DUEL_RESPONSES_PER_DAY,
  type CreateDuelInput,
  type DisputeDuelInput,
  type DuelBestOf,
  type DuelItemView,
  type DuelReasonInput,
  type DuelStatus,
  type DuelView,
  type ListDuelsQuery,
  type ListMyDuelsQuery,
  type Page,
  type ReportDuelInput,
  type RespondDuelInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DuelRatingService } from './duel-rating.service.js';
import { SEEKING_STATUSES, assertScore, assertSlotTime, invalidState } from './duel-rules.js';
import {
  ANONYMOUS_VIEWER,
  confirmByOf,
  startableAtOf,
  duelFields,
  playerName,
  ratingChangeFields,
  responseFields,
  toDuelItem,
  toDuelView,
  type DuelRecord,
  type DuelViewer,
  type SideRecord,
} from './duel-view.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Tx = Prisma.TransactionClient;

/** Тот, кто действует: аккаунт с профилем игрока и имя для уведомлений. */
export interface DuelActor {
  readonly userId: string;
  readonly playerId: string;
  readonly name: string;
  /** Телефон аккаунта — контакт по умолчанию (ADR-068). */
  readonly phone: string;
}

/** Отклик в объёме, нужном для действий над ним. */
const responseActionFields = {
  id: true,
  duelId: true,
  playerId: true,
  slotId: true,
  proposedStartsAt: true,
  proposedEndsAt: true,
  status: true,
  contact: true,
  slot: { select: { startsAt: true, endsAt: true } },
  player: { select: { userId: true, lastName: true, firstName: true } },
} as const satisfies Prisma.DuelResponseSelect;

type ResponseAction = Prisma.DuelResponseGetPayload<{ select: typeof responseActionFields }>;

/**
 * Дуэли и спарринги — ADR-065, `docs/13`.
 *
 * Каждое действие — одна транзакция: смена состояния, отклики, рейтинг и
 * уведомления второй стороне либо случаются вместе, либо не случаются.
 * Переход состояния — условное обновление (`claim`): два одновременных
 * действия над одной дуэлью не перепишут друг друга, второе получит
 * `DUEL_INVALID_STATE`.
 *
 * Сроки (`EXPIRED`, `UNCONFIRMED`) переводятся лениво, в начале каждого
 * чтения и действия (`settleStale`): планировщика в приложении нет, а
 * два условных `UPDATE` по индексу дешевле, чем ещё один процесс.
 */
@Injectable()
export class DuelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly rating: DuelRatingService,
  ) {}

  // ---------------------------------------------------------------- сроки

  /**
   * Ленивые переходы по времени — `docs/13` §3.2:
   *
   * - публикация и вызов, у которых прошли все варианты автора и нет
   *   нового отклика со своим временем впереди, — `EXPIRED`;
   * - счёт, не подтверждённый за 48 часов, — `UNCONFIRMED`: сыграно, рейтинг
   *   не менялся.
   */
  async settleStale(now = new Date()): Promise<void> {
    await this.prisma.duel.updateMany({
      where: {
        status: { in: [...SEEKING_STATUSES] },
        slotsUntil: { lte: now },
        responses: { none: { status: 'NEW', proposedEndsAt: { gt: now } } },
      },
      data: { status: 'EXPIRED', closedAt: now },
    });
    await this.prisma.duel.updateMany({
      where: { status: 'REPORTED', reportedAt: { lte: confirmDeadline(now) } },
      data: { status: 'UNCONFIRMED', closedAt: now },
    });
  }

  // ---------------------------------------------------------------- чтение

  /**
   * Доска: открытые публикации, ещё не прошедшие (ближайшие первыми), или
   * недавно сыгранные рейтинговые (свежие первыми). Вызовы на доску не
   * попадают — это дело двоих.
   */
  async list(
    query: ListDuelsQuery,
    userId?: string,
    now = new Date(),
  ): Promise<Page<DuelItemView>> {
    await this.settleStale(now);

    const viewer = await this.viewer(userId);
    const filters: Prisma.DuelWhereInput = {
      ...(query.cityId === undefined ? {} : { cityId: query.cityId }),
      ...(query.clubId === undefined ? {} : { clubId: query.clubId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.rated === undefined ? {} : { rated: query.rated }),
    };
    const open = query.scope === 'open';
    const where: Prisma.DuelWhereInput = open
      ? { ...filters, status: 'OPEN', slotsUntil: { gt: now } }
      : { ...filters, status: 'COMPLETED', rated: true, annulledAt: null };
    const orderBy: Prisma.DuelOrderByWithRelationInput[] = open
      ? [{ playAt: 'asc' }, { id: 'asc' }]
      : [{ confirmedAt: 'desc' }, { id: 'desc' }];

    const [rows, total] = await Promise.all([
      this.prisma.duel.findMany({
        where,
        select: duelFields,
        orderBy,
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.duel.count({ where }),
    ]);

    return pageOf(await this.items(rows, viewer), total, query);
  }

  /** Страница предложения. */
  async view(id: string, userId?: string, now = new Date()): Promise<DuelView> {
    await this.settleStale(now);

    return this.render(id, await this.viewer(userId), now);
  }

  /**
   * «Мои дуэли»: где я автор, соперник или откликнулся. `active` — ещё не
   * решено (ближайшие первыми), `history` — остальное (свежие первыми).
   * Прошедший нерейтинговый спарринг уходит в историю: счёта у него нет, и
   * ждать от него больше нечего.
   */
  async listMine(
    userId: string,
    query: ListMyDuelsQuery,
    now = new Date(),
  ): Promise<Page<DuelItemView>> {
    await this.settleStale(now);

    const viewer = await this.viewer(userId);
    const me = viewer.playerId;

    if (me === null) return pageOf([], 0, query);

    const finishedSparring: Prisma.DuelWhereInput = {
      rated: false,
      status: 'SCHEDULED',
      endsAt: { lte: now },
    };
    const where: Prisma.DuelWhereInput =
      query.scope === 'active'
        ? {
            status: { in: [...DUEL_ACTIVE_STATUSES] },
            NOT: finishedSparring,
            // Отклонённый отклик — уже не «моя» активная дуэль.
            OR: [
              { authorId: me },
              { opponentId: me },
              { responses: { some: { playerId: me, status: 'NEW' } } },
            ],
          }
        : {
            AND: [
              { OR: [{ status: { notIn: [...DUEL_ACTIVE_STATUSES] } }, finishedSparring] },
              {
                OR: [
                  { authorId: me },
                  { opponentId: me },
                  { responses: { some: { playerId: me } } },
                ],
              },
            ],
          };
    const orderBy: Prisma.DuelOrderByWithRelationInput[] =
      query.scope === 'active'
        ? [{ playAt: 'asc' }, { id: 'asc' }]
        : [{ playAt: 'desc' }, { id: 'desc' }];

    const [rows, total] = await Promise.all([
      this.prisma.duel.findMany({
        where,
        select: duelFields,
        orderBy,
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.duel.count({ where }),
    ]);

    return pageOf(await this.items(rows, viewer), total, query);
  }

  // ---------------------------------------------------------------- предложение

  /**
   * Новое предложение: вызов (`opponentId`) или публикация. Пределы
   * считаются по базе внутри транзакции под замком на автора: двойное
   * нажатие «Опубликовать» не обойдёт предел.
   */
  async create(userId: string, input: CreateDuelInput, now = new Date()): Promise<DuelView> {
    await this.settleStale(now);

    const author = await this.actor(userId);
    const opponent =
      input.opponentId === undefined ? null : await this.opponent(author, input.opponentId);
    const slots = [...input.slots]
      .map((slot) => ({ startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt) }))
      .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());

    for (const [index, slot] of slots.entries()) assertSlotTime(slot.startsAt, now, index);

    const cityId = await this.venueCity(input);
    const first = slots[0];

    if (first === undefined) throw invalidTime('slots');

    const slotsUntil = new Date(Math.max(...slots.map((slot) => slot.endsAt.getTime())));

    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'duel:' + author.playerId}))`;
      await this.assertCreateLimit(tx, author.playerId, opponent !== null, now);

      const duel = await tx.duel.create({
        data: {
          kind: input.kind,
          rated: input.rated,
          bestOf: input.bestOf ?? null,
          status: opponent === null ? 'OPEN' : 'CHALLENGE',
          authorId: author.playerId,
          challenge: opponent !== null,
          opponentId: opponent?.id ?? null,
          clubId: input.clubId ?? null,
          venueName: input.venueName ?? null,
          venueAddress: input.venueAddress ?? null,
          cityId,
          note: input.note ?? null,
          // Контакт по умолчанию — телефон аккаунта, как предлагает форма.
          authorContact: input.contact ?? author.phone,
          slotsFrom: first.startsAt,
          slotsUntil,
          playAt: first.startsAt,
          createdAt: now,
          slots: { create: slots },
        },
        select: { id: true },
      });

      if (opponent !== null && opponent.userId !== null) {
        await this.notifications.create(tx, [opponent.userId], 'DUEL_CHALLENGE', {
          duelId: duel.id,
          kind: input.kind,
          playerName: author.name,
          rated: input.rated,
        });
      }

      return duel.id;
    });

    return this.render(id, author, now);
  }

  // ---------------------------------------------------------------- отклик

  /**
   * Отклик на публикацию или ответ вызванного. Вызванный, выбравший вариант
   * автора, — согласие: дуэль назначена сразу (у рейтинговой — после
   * проверки частоты). Остальное ждёт решения автора.
   */
  async respond(
    duelId: string,
    userId: string,
    input: RespondDuelInput,
    now = new Date(),
  ): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const duel = await this.load(duelId);

    if (duel.authorId === me.playerId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Cannot respond to own duel', { id: duelId });
    }

    if (!isSeeking(duel.status)) throw invalidState(duel.status);

    if (duel.status === 'CHALLENGE' && duel.opponentId !== me.playerId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the challenged player answers', {
        id: duelId,
      });
    }

    const slot = input.slotId === undefined ? null : findSlot(duel, input.slotId);

    if (slot !== null && slot.endsAt.getTime() <= now.getTime()) throw invalidTime('slotId');

    const proposed =
      input.proposed === undefined
        ? null
        : { startsAt: new Date(input.proposed.startsAt), endsAt: new Date(input.proposed.endsAt) };

    if (proposed !== null) assertSlotTime(proposed.startsAt, now);

    // Вызванный выбрал вариант автора — это согласие, а не предложение.
    const agreed = duel.status === 'CHALLENGE' ? slot : null;
    const authorUser = duel.author.userId;

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'duel:' + me.playerId}))`;
      await this.assertCanRespond(tx, duelId, me.playerId, now);

      if (agreed !== null) {
        if (duel.rated) {
          await this.rating.assertSchedulable(
            tx,
            duelId,
            duel.authorId,
            me.playerId,
            agreed.startsAt,
          );
        }

        await claimDuel(tx, duelId, ['CHALLENGE'], {
          status: 'SCHEDULED',
          startsAt: agreed.startsAt,
          endsAt: agreed.endsAt,
          playAt: agreed.startsAt,
          agreedAt: now,
          opponentContact: input.contact ?? me.phone,
        });
      }

      const response = await tx.duelResponse.create({
        data: {
          duelId,
          playerId: me.playerId,
          slotId: slot?.id ?? null,
          proposedStartsAt: proposed?.startsAt ?? null,
          proposedEndsAt: proposed?.endsAt ?? null,
          message: input.message ?? null,
          contact: input.contact ?? me.phone,
          status: agreed === null ? 'NEW' : 'ACCEPTED',
          answeredAt: agreed === null ? null : now,
          createdAt: now,
        },
        select: { id: true },
      });

      if (authorUser !== null) {
        if (agreed !== null) {
          await this.notifications.create(tx, [authorUser], 'DUEL_SCHEDULED', {
            duelId,
            kind: duel.kind,
            playerName: me.name,
            startsAt: agreed.startsAt.toISOString(),
          });
        } else {
          await this.notifications.create(tx, [authorUser], 'DUEL_RESPONSE', {
            duelId,
            kind: duel.kind,
            playerName: me.name,
            responseId: response.id,
          });
        }
      }

      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.render(duelId, me, now);
  }

  /** Отозвать свой новый отклик. */
  async withdraw(responseId: string, userId: string, now = new Date()): Promise<DuelView> {
    const me = await this.actor(userId);
    const response = await this.loadResponse(responseId);

    if (response.playerId !== me.playerId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the responder withdraws', { id: responseId });
    }

    await this.prisma.$transaction(async (tx) => {
      await moveResponse(tx, response, { status: 'WITHDRAWN', answeredAt: now });
      await this.notifications.settleDuelResponse(tx, responseId, now);
    });

    return this.render(response.duelId, me, now);
  }

  /**
   * Автор принимает отклик: соперник и время согласованы, остальные новые
   * отклики отклонены с уведомлением «соперник найден» (`TAKEN`).
   */
  async accept(responseId: string, userId: string, now = new Date()): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const response = await this.loadResponse(responseId);
    const duel = await this.load(response.duelId);

    assertAuthor(duel, me);

    if (response.status !== 'NEW') throw invalidState(response.status, { responseId });

    if (!isSeeking(duel.status)) throw invalidState(duel.status);

    const time = timeOf(response);

    if (time.endsAt.getTime() <= now.getTime()) throw invalidTime('responseId');

    await this.prisma.$transaction(async (tx) => {
      if (duel.rated) {
        await this.rating.assertSchedulable(
          tx,
          duel.id,
          duel.authorId,
          response.playerId,
          time.startsAt,
        );
      }

      await claimDuel(tx, duel.id, [...SEEKING_STATUSES], {
        status: 'SCHEDULED',
        opponentId: response.playerId,
        opponentContact: response.contact,
        agreedAt: now,
        startsAt: time.startsAt,
        endsAt: time.endsAt,
        playAt: time.startsAt,
      });
      await moveResponse(tx, response, { status: 'ACCEPTED', answeredAt: now });

      const others = await tx.duelResponse.findMany({
        where: { duelId: duel.id, status: 'NEW', id: { not: response.id } },
        select: { id: true, player: { select: { userId: true } } },
      });

      if (others.length > 0) {
        await tx.duelResponse.updateMany({
          where: { id: { in: others.map((other) => other.id) }, status: 'NEW' },
          data: { status: 'DECLINED', answeredAt: now },
        });
        await this.notifications.create(tx, userIdsOf(others), 'DUEL_DECLINED', {
          duelId: duel.id,
          kind: duel.kind,
          playerName: me.name,
          reason: 'TAKEN',
        });
      }

      if (response.player.userId !== null) {
        await this.notifications.create(tx, [response.player.userId], 'DUEL_SCHEDULED', {
          duelId: duel.id,
          kind: duel.kind,
          playerName: me.name,
          startsAt: time.startsAt.toISOString(),
        });
      }

      await this.notifications.settleDuel(tx, userId, duel.id, now);
    });

    return this.render(duel.id, me, now);
  }

  /**
   * Автор отклоняет отклик. Предложение остаётся открытым: вызванный, чьё
   * время не подошло, может выбрать вариант автора или предложить другое.
   */
  async declineResponse(responseId: string, userId: string, now = new Date()): Promise<DuelView> {
    const me = await this.actor(userId);
    const response = await this.loadResponse(responseId);
    const duel = await this.load(response.duelId);

    assertAuthor(duel, me);

    await this.prisma.$transaction(async (tx) => {
      await moveResponse(tx, response, { status: 'DECLINED', answeredAt: now });

      if (response.player.userId !== null) {
        await this.notifications.create(tx, [response.player.userId], 'DUEL_DECLINED', {
          duelId: duel.id,
          kind: duel.kind,
          playerName: me.name,
          reason: 'REJECTED',
        });
      }

      await this.notifications.settleDuelResponse(tx, responseId, now);
    });

    return this.render(duel.id, me, now);
  }

  // ---------------------------------------------------------------- отказ и отмена

  /** Вызванный отказывается от вызова. */
  async decline(
    duelId: string,
    userId: string,
    input: DuelReasonInput,
    now = new Date(),
  ): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const duel = await this.load(duelId);

    if (!duel.challenge || duel.opponentId !== me.playerId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the challenged player declines', {
        id: duelId,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(tx, duelId, ['CHALLENGE'], {
        status: 'DECLINED',
        closeReason: input.reason ?? null,
        closedAt: now,
      });
      // Своё время, предложенное раньше, больше не в силе.
      await tx.duelResponse.updateMany({
        where: { duelId, playerId: me.playerId, status: 'NEW' },
        data: { status: 'WITHDRAWN', answeredAt: now },
      });

      if (duel.author.userId !== null) {
        await this.notifications.create(tx, [duel.author.userId], 'DUEL_DECLINED', {
          duelId,
          kind: duel.kind,
          playerName: me.name,
          reason: 'DECLINED',
        });
      }

      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.render(duelId, me, now);
  }

  /**
   * Отмена до счёта: автор — пока ищет соперника или игра назначена,
   * соперник — когда назначена. Второму участнику и ждущим откликам —
   * уведомление.
   */
  async cancel(
    duelId: string,
    userId: string,
    input: DuelReasonInput,
    now = new Date(),
  ): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const duel = await this.load(duelId);
    const isAuthor = duel.authorId === me.playerId;
    const isOpponent = duel.opponentId === me.playerId;

    if (!isAuthor && !isOpponent) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only a participant cancels', { id: duelId });
    }

    const from: DuelStatus[] = isAuthor ? ['OPEN', 'CHALLENGE', 'SCHEDULED'] : ['SCHEDULED'];

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(tx, duelId, from, {
        status: 'CANCELLED',
        closeReason: input.reason ?? null,
        closedAt: now,
      });

      const waiting = await tx.duelResponse.findMany({
        where: { duelId, status: 'NEW' },
        select: { id: true, player: { select: { userId: true } } },
      });

      if (waiting.length > 0) {
        await tx.duelResponse.updateMany({
          where: { id: { in: waiting.map((response) => response.id) }, status: 'NEW' },
          data: { status: 'DECLINED', answeredAt: now },
        });
      }

      const other = isAuthor ? duel.opponent : duel.author;

      await this.notifications.create(
        tx,
        [...userIdsOf(waiting), ...(other?.userId ? [other.userId] : [])].filter(
          (id) => id !== userId,
        ),
        'DUEL_CANCELLED',
        { duelId, kind: duel.kind, playerName: me.name, reason: input.reason ?? null },
      );
      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.render(duelId, me, now);
  }

  // ---------------------------------------------------------------- счёт

  /**
   * Счёт вносит любой из двоих, с часа до начала согласованного времени
   * (ADR-068). Ручной ввод открыт и при начатом табло: кто табло не вёл,
   * вносит итог сразу.
   */
  async report(
    duelId: string,
    userId: string,
    input: ReportDuelInput,
    now = new Date(),
  ): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const duel = await this.load(duelId);

    if (duel.authorId !== me.playerId && duel.opponentId !== me.playerId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only a participant reports', { id: duelId });
    }

    if (duel.status !== 'SCHEDULED') throw invalidState(duel.status);

    const other = otherSide(duel, me.playerId);

    // Нерейтинговый спарринг кончается назначением: счёта у него нет.
    if (!duel.rated || duel.bestOf === null) throw invalidState(duel.status, { rated: false });

    if (duel.startsAt === null || now.getTime() < startableAtOf(duel.startsAt).getTime()) {
      throw new AppError(ERROR_CODES.DUEL_TIME_INVALID, 'Result before the game can start', {
        startableAt: duel.startsAt === null ? null : startableAtOf(duel.startsAt).toISOString(),
      });
    }

    assertScore(duel.bestOf as DuelBestOf, input, [me.playerId, other.id]);
    await this.submitResult(duel, me, other, input, now);

    return this.render(duelId, me, now);
  }

  /**
   * Счёт — на подтверждение второму: ручной ввод и «Завершить» по табло.
   * Переход — только из назначенной, условием в самом обновлении.
   */
  async submitResult(
    duel: DuelRecord,
    me: DuelActor,
    other: SideRecord,
    input: ReportDuelInput,
    now: Date,
    extra: Prisma.DuelWhereInput = {},
  ): Promise<void> {
    const duelId = duel.id;

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(
        tx,
        duelId,
        ['SCHEDULED'],
        {
          status: 'REPORTED',
          winnerId: input.winnerId,
          winnerSets: input.winnerSets,
          loserSets: input.loserSets,
          reportedById: me.playerId,
          reportedAt: now,
          // Перенос, который не успели принять, после счёта не нужен.
          ...CLEAR_RESCHEDULE,
        },
        extra,
      );

      if (other.userId !== null) {
        const otherWon = input.winnerId === other.id;

        await this.notifications.create(tx, [other.userId], 'DUEL_RESULT', {
          duelId,
          kind: duel.kind,
          playerName: me.name,
          setsFor: otherWon ? input.winnerSets : input.loserSets,
          setsAgainst: otherWon ? input.loserSets : input.winnerSets,
          confirmBy: confirmByOf(now).toISOString(),
        });
      }

      await this.notifications.settleDuel(tx, me.userId, duelId, now);
    });
  }

  /**
   * Второй участник подтверждает счёт: дуэль сыграна и — в той же
   * транзакции — обсчитана, если предел частоты позволяет.
   */
  async confirm(duelId: string, userId: string, now = new Date()): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const duel = await this.load(duelId);
    const reporter = this.counterpart(duel, me);
    const result = resultOf(duel);

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(
        tx,
        duelId,
        ['REPORTED'],
        { status: 'COMPLETED', confirmedAt: now },
        // Срок мог истечь между чтением и подтверждением.
        { reportedAt: { gt: confirmDeadline(now) } },
      );

      const deltas = await this.rating.apply(tx, duel, result, userId);

      if (reporter.userId !== null) {
        await this.notifications.create(tx, [reporter.userId], 'DUEL_COMPLETED', {
          duelId,
          kind: duel.kind,
          playerName: me.name,
          delta: deltas?.get(reporter.id) ?? null,
        });
      }

      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.render(duelId, me, now);
  }

  /** Второй участник не согласен — спор уходит администратору. */
  async dispute(
    duelId: string,
    userId: string,
    input: DisputeDuelInput,
    now = new Date(),
  ): Promise<DuelView> {
    await this.settleStale(now);

    const me = await this.actor(userId);
    const duel = await this.load(duelId);
    const reporter = this.counterpart(duel, me);

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(
        tx,
        duelId,
        ['REPORTED'],
        { status: 'DISPUTED', disputeComment: input.comment, disputedAt: now },
        { reportedAt: { gt: confirmDeadline(now) } },
      );

      if (reporter.userId !== null) {
        await this.notifications.create(tx, [reporter.userId], 'DUEL_DISPUTED', {
          duelId,
          kind: duel.kind,
          playerName: me.name,
        });
      }

      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.render(duelId, me, now);
  }

  // ---------------------------------------------------------------- общее

  /** Строки списка с начислением: одним запросом журнала на страницу. */
  private async items(rows: readonly DuelRecord[], viewer: DuelViewer): Promise<DuelItemView[]> {
    const changes =
      rows.length === 0
        ? []
        : await this.prisma.ratingEvent.findMany({
            where: { duelId: { in: rows.map((row) => row.id) }, type: 'MATCH' },
            select: { ...ratingChangeFields, duelId: true },
            orderBy: { playerId: 'asc' },
          });

    return rows.map((row) =>
      toDuelItem(
        row,
        viewer,
        changes.filter((change) => change.duelId === row.id),
      ),
    );
  }

  /** Дуэль глазами смотрящего: отклики, начисление, доступные действия. */
  async render(id: string, viewer: DuelViewer, now: Date): Promise<DuelView> {
    const [record, responses, changes] = await Promise.all([
      this.load(id),
      this.prisma.duelResponse.findMany({
        where: { duelId: id },
        select: responseFields,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.ratingEvent.findMany({
        where: { duelId: id, type: 'MATCH' },
        select: ratingChangeFields,
        orderBy: { playerId: 'asc' },
      }),
    ]);

    return toDuelView(record, viewer, responses, changes, now);
  }

  async viewer(userId: string | undefined): Promise<DuelViewer> {
    if (userId === undefined) return ANONYMOUS_VIEWER;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { player: { select: { id: true } } },
    });

    return { userId, playerId: user?.player?.id ?? null };
  }

  async load(id: string): Promise<DuelRecord> {
    const record = await this.prisma.duel.findUnique({ where: { id }, select: duelFields });

    if (record === null) throw new AppError(ERROR_CODES.NOT_FOUND, 'Duel not found', { id });

    return record;
  }

  /** Предлагать и откликаться — только с профилем игрока. */
  async actor(userId: string): Promise<DuelActor> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phone: true,
        player: { select: { id: true, lastName: true, firstName: true, confirmedAt: true } },
      },
    });

    if (user === null) throw new AppError(ERROR_CODES.UNAUTHORIZED, 'User not found');

    if (user.player === null) {
      throw new AppError(ERROR_CODES.DUEL_PROFILE_REQUIRED, 'Duels require a player profile');
    }

    // Дуэль — с рейтингом в строке и, у рейтинговой, в журнале: анкете без
    // рейтинга (ADR-072) показывать и считать нечего.
    if (user.player.confirmedAt === null) {
      throw new AppError(ERROR_CODES.PLAYER_NOT_CONFIRMED, 'Duels require a rated profile', {
        playerId: user.player.id,
      });
    }

    return {
      userId,
      playerId: user.player.id,
      name: playerName(user.player),
      phone: user.phone,
    };
  }

  /** Вызвать можно игрока с аккаунтом и не себя. */
  private async opponent(
    author: DuelActor,
    opponentId: string,
  ): Promise<{ id: string; userId: string | null }> {
    if (opponentId === author.playerId) {
      throw new AppError(ERROR_CODES.DUEL_OPPONENT_INVALID, 'Cannot challenge yourself', {
        reason: 'SELF',
      });
    }

    const player = await this.prisma.player.findUnique({
      where: { id: opponentId },
      select: { id: true, userId: true, confirmedAt: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id: opponentId });
    }

    if (player.confirmedAt === null) {
      throw new AppError(ERROR_CODES.PLAYER_NOT_CONFIRMED, 'Opponent has no rated profile', {
        playerId: opponentId,
      });
    }

    if (player.userId === null) {
      throw new AppError(ERROR_CODES.DUEL_OPPONENT_INVALID, 'Opponent has no account', {
        reason: 'NO_ACCOUNT',
      });
    }

    if (player.userId === author.userId) {
      throw new AppError(ERROR_CODES.DUEL_OPPONENT_INVALID, 'Cannot challenge yourself', {
        reason: 'SELF',
      });
    }

    return player;
  }

  /** Город места: у клуба — город клуба, у своего зала — выбранный. */
  private async venueCity(input: CreateDuelInput): Promise<string> {
    if (input.clubId !== undefined) {
      const club = await this.prisma.club.findUnique({
        where: { id: input.clubId },
        select: { cityId: true, hiddenAt: true },
      });

      // Скрытый клуб в справочнике не предлагается — для дуэли его нет.
      if (club?.hiddenAt !== null) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: input.clubId });
      }

      return club.cityId;
    }

    const city =
      input.cityId === undefined
        ? null
        : await this.prisma.city.findFirst({
            where: { id: input.cityId, isActive: true, country: { isActive: true } },
            select: { id: true },
          });

    if (city === null) {
      throw new AppError(ERROR_CODES.CITY_UNAVAILABLE, 'City is unknown or hidden', {
        cityId: input.cityId ?? null,
      });
    }

    return city.id;
  }

  /** Пределы предложений — по базе (ADR-056): открытых публикаций и вызовов за сутки. */
  private async assertCreateLimit(
    tx: Tx,
    playerId: string,
    challenge: boolean,
    now: Date,
  ): Promise<void> {
    if (challenge) {
      const count = await tx.duel.count({
        where: {
          authorId: playerId,
          challenge: true,
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      });

      if (count >= DUEL_CHALLENGES_PER_DAY) throw limit('CHALLENGES', DUEL_CHALLENGES_PER_DAY);

      return;
    }

    const open = await tx.duel.count({
      where: { authorId: playerId, challenge: false, status: 'OPEN' },
    });

    if (open >= DUEL_OPEN_MAX) throw limit('OPEN', DUEL_OPEN_MAX);
  }

  /** Один открытый отклик на предложение и не больше двадцати за сутки. */
  private async assertCanRespond(
    tx: Tx,
    duelId: string,
    playerId: string,
    now: Date,
  ): Promise<void> {
    const [open, recent, fresh] = await Promise.all([
      tx.duelResponse.findFirst({
        where: { duelId, playerId, status: 'NEW' },
        select: { id: true },
      }),
      tx.duelResponse.count({
        where: { playerId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
      }),
      tx.duel.findUnique({ where: { id: duelId }, select: { status: true } }),
    ]);

    if (open !== null) {
      throw new AppError(ERROR_CODES.DUEL_RESPONSE_EXISTS, 'Response already waits', {
        id: open.id,
      });
    }

    if (recent >= DUEL_RESPONSES_PER_DAY) throw limit('RESPONSES', DUEL_RESPONSES_PER_DAY);

    // Пока шли проверки, автор мог принять другого или отменить.
    if (fresh === null || !isSeeking(fresh.status)) throw invalidState(fresh?.status ?? 'OPEN');
  }

  /**
   * Тот, кто подтверждает или оспаривает: участник, но не внёсший счёт.
   * Возвращает внёсшего — ему уходит уведомление.
   */
  private counterpart(duel: DuelRecord, me: DuelActor): SideRecord {
    const reporter = otherSide(duel, me.playerId);

    if (duel.status !== 'REPORTED') throw invalidState(duel.status);

    if (duel.reportedById !== reporter.id) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the other participant answers the result', {
        id: duel.id,
      });
    }

    return reporter;
  }

  private async loadResponse(id: string): Promise<ResponseAction> {
    const record = await this.prisma.duelResponse.findUnique({
      where: { id },
      select: responseActionFields,
    });

    if (record === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Duel response not found', { id });
    }

    return record;
  }
}

// ---------------------------------------------------------------- помощники

/** Снять предложение переноса. */
export const CLEAR_RESCHEDULE = {
  rescheduleStartsAt: null,
  rescheduleEndsAt: null,
  rescheduleById: null,
  rescheduleMessage: null,
  rescheduleAt: null,
} as const satisfies Prisma.DuelUncheckedUpdateManyInput;

function isSeeking(status: DuelStatus): boolean {
  return (SEEKING_STATUSES as readonly DuelStatus[]).includes(status);
}

function confirmDeadline(now: Date): Date {
  return new Date(now.getTime() - DUEL_CONFIRM_HOURS * HOUR_MS);
}

function limit(kind: 'OPEN' | 'CHALLENGES' | 'RESPONSES', max: number): AppError {
  return new AppError(ERROR_CODES.DUEL_LIMIT, 'Duel limit reached', { kind, limit: max });
}

function invalidTime(field: string): AppError {
  return new AppError(ERROR_CODES.DUEL_TIME_INVALID, 'Time is over', { field });
}

function assertAuthor(duel: DuelRecord, me: DuelActor): void {
  if (duel.authorId !== me.playerId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the author answers responses', {
      id: duel.id,
    });
  }
}

/** Второй участник глазами первого. Не участник — отказ. */
export function otherSide(duel: DuelRecord, playerId: string): SideRecord {
  if (duel.opponent !== null && duel.authorId === playerId) return duel.opponent;

  if (duel.opponentId === playerId) return duel.author;

  throw new AppError(ERROR_CODES.FORBIDDEN, 'Only a participant can do this', { id: duel.id });
}

/** Внесённый счёт дуэли — для начисления. */
export function resultOf(duel: DuelRecord): ReportDuelInput {
  if (duel.winnerId === null || duel.winnerSets === null || duel.loserSets === null) {
    throw invalidState(duel.status);
  }

  return { winnerId: duel.winnerId, winnerSets: duel.winnerSets, loserSets: duel.loserSets };
}

function findSlot(duel: DuelRecord, slotId: string): { id: string; startsAt: Date; endsAt: Date } {
  const slot = duel.slots.find((candidate) => candidate.id === slotId);

  if (slot === undefined) {
    throw new AppError(ERROR_CODES.NOT_FOUND, 'Duel slot not found', { id: slotId });
  }

  return slot;
}

/** Время отклика: выбранный вариант автора или предложенное своё. */
function timeOf(response: ResponseAction): { startsAt: Date; endsAt: Date } {
  if (response.slot !== null) return response.slot;

  if (response.proposedStartsAt !== null && response.proposedEndsAt !== null) {
    return { startsAt: response.proposedStartsAt, endsAt: response.proposedEndsAt };
  }

  // Вариант автора удалён вместе с дуэлью — сюда не попасть, но время обязано быть.
  throw invalidState(response.status, { responseId: response.id });
}

function userIdsOf(rows: readonly { player: { userId: string | null } }[]): string[] {
  return rows.flatMap((row) => (row.player.userId === null ? [] : [row.player.userId]));
}

/**
 * Переход состояния — условием в самом обновлении: два одновременных
 * действия над одной дуэлью не перепишут друг друга.
 */
export async function claimDuel(
  tx: Tx,
  id: string,
  from: readonly DuelStatus[],
  data: Prisma.DuelUncheckedUpdateManyInput,
  extra: Prisma.DuelWhereInput = {},
): Promise<void> {
  const updated = await tx.duel.updateMany({
    where: { ...extra, id, status: { in: [...from] } },
    data,
  });

  if (updated.count > 0) return;

  const fresh = await tx.duel.findUnique({ where: { id }, select: { status: true } });

  throw invalidState(fresh?.status ?? 'CANCELLED');
}

/** Смена статуса нового отклика — тоже условием в обновлении. */
async function moveResponse(
  tx: Tx,
  response: ResponseAction,
  data: Prisma.DuelResponseUncheckedUpdateManyInput,
): Promise<void> {
  if (response.status === 'NEW') {
    const updated = await tx.duelResponse.updateMany({
      where: { id: response.id, status: 'NEW' },
      data,
    });

    if (updated.count > 0) return;
  }

  const fresh = await tx.duelResponse.findUnique({
    where: { id: response.id },
    select: { status: true },
  });

  throw invalidState(fresh?.status ?? response.status, { responseId: response.id });
}
