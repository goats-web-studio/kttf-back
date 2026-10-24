import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  setsToWin,
  type DuelBestOf,
  type DuelContactInput,
  type DuelSetInput,
  type DuelUndoSetInput,
  type DuelView,
  type RescheduleDuelInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DuelRatingService } from './duel-rating.service.js';
import { assertSlotTime, invalidState } from './duel-rules.js';
import { boardWinner, startableAtOf, type DuelRecord } from './duel-view.js';
import {
  CLEAR_RESCHEDULE,
  DuelsService,
  claimDuel,
  otherSide,
  type DuelActor,
} from './duels.service.js';

/**
 * Матч дуэли — ADR-068, `docs/13` §3.7: старт и табло по партиям, перенос
 * времени, контакты. Всё — участникам назначенной игры; правила состояний
 * и рейтинга — общие с `DuelsService`, счёт по табло уходит на подтверждение
 * тем же путём, что и внесённый вручную.
 */
@Injectable()
export class DuelMatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly rating: DuelRatingService,
    private readonly duels: DuelsService,
  ) {}

  // ---------------------------------------------------------------- табло

  /** «Начать матч» — участник рейтинговой назначенной игры, с часа до начала. */
  async start(duelId: string, userId: string, now = new Date()): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);

    if (duel.status !== 'SCHEDULED') throw invalidState(duel.status);

    // Нерейтинговый спарринг табло не ведёт: счёта у него нет.
    if (!duel.rated) throw invalidState(duel.status, { rated: false });

    if (duel.startedAt !== null) throw invalidState(duel.status, { started: true });

    const startableAt = duel.startsAt === null ? null : startableAtOf(duel.startsAt);

    if (startableAt === null || now.getTime() < startableAt.getTime()) {
      throw new AppError(ERROR_CODES.DUEL_TIME_INVALID, 'Match cannot start yet', {
        startableAt: startableAt?.toISOString() ?? null,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // Играют в прежнее время — предложенный перенос больше не нужен.
      await claimDuel(
        tx,
        duelId,
        ['SCHEDULED'],
        { startedAt: now, ...CLEAR_RESCHEDULE },
        { startedAt: null },
      );
      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.duels.render(duelId, me, now);
  }

  /**
   * Партия на табло. `index` — сколько партий видел отправитель: то же
   * нажатие с двух телефонов запишется один раз, второе получит отказ.
   */
  async addSet(
    duelId: string,
    userId: string,
    input: DuelSetInput,
    now = new Date(),
  ): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);
    const need = this.assertBoard(duel);

    if (input.index !== duel.sets.length) {
      throw invalidState(duel.status, { sets: duel.sets.length });
    }

    // Победитель — один из двоих; партия сверх формата — счёт уже решён.
    if (![duel.authorId, duel.opponentId].includes(input.winnerId) || boardWinner(duel) !== null) {
      throw new AppError(ERROR_CODES.DUEL_SCORE_INVALID, 'Set does not fit the match', {
        setsToWin: need,
      });
    }

    await this.moveSets(duel, [...duel.sets, input.winnerId]);

    return this.duels.render(duelId, me, now);
  }

  /** Отмена последней партии; `index` — сколько записано сейчас. */
  async undoSet(
    duelId: string,
    userId: string,
    input: DuelUndoSetInput,
    now = new Date(),
  ): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);

    this.assertBoard(duel);

    if (input.index !== duel.sets.length || duel.sets.length === 0) {
      throw invalidState(duel.status, { sets: duel.sets.length });
    }

    await this.moveSets(duel, duel.sets.slice(0, -1));

    return this.duels.render(duelId, me, now);
  }

  /**
   * «Завершить и отправить сопернику»: счёт по табло — на подтверждение,
   * как внесённый вручную. Табло не должно было измениться с прочтения.
   */
  async finish(duelId: string, userId: string, now = new Date()): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);
    const need = this.assertBoard(duel);
    const winnerId = boardWinner(duel);

    if (winnerId === null) {
      throw new AppError(ERROR_CODES.DUEL_SCORE_INVALID, 'Nobody has won the match yet', {
        setsToWin: need,
      });
    }

    await this.duels.submitResult(
      duel,
      me,
      otherSide(duel, me.playerId),
      {
        winnerId,
        winnerSets: need,
        loserSets: duel.sets.filter((id) => id !== winnerId).length,
      },
      now,
      { sets: { equals: duel.sets } },
    );

    return this.duels.render(duelId, me, now);
  }

  // ---------------------------------------------------------------- перенос

  /** Предложить новое время; новое предложение заменяет прежнее. */
  async propose(
    duelId: string,
    userId: string,
    input: RescheduleDuelInput,
    now = new Date(),
  ): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);

    this.assertReschedulable(duel);

    const startsAt = new Date(input.slot.startsAt);
    const endsAt = new Date(input.slot.endsAt);

    assertSlotTime(startsAt, now);

    const other = otherSide(duel, me.playerId);

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(
        tx,
        duelId,
        ['SCHEDULED'],
        {
          rescheduleStartsAt: startsAt,
          rescheduleEndsAt: endsAt,
          rescheduleById: me.playerId,
          rescheduleMessage: input.message ?? null,
          rescheduleAt: now,
        },
        { startedAt: null },
      );

      if (other.userId !== null) {
        await this.notifications.create(tx, [other.userId], 'DUEL_RESCHEDULE', {
          duelId,
          kind: duel.kind,
          playerName: me.name,
          startsAt: startsAt.toISOString(),
          action: 'PROPOSED',
        });
      }

      await this.notifications.settleDuel(tx, userId, duelId, now);
    });

    return this.duels.render(duelId, me, now);
  }

  /**
   * Второй принимает перенос: время меняется, напоминание — заново.
   * Рейтинговую на новое время снова проверяет предел частоты.
   */
  async acceptReschedule(duelId: string, userId: string, now = new Date()): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);
    const proposal = this.proposal(duel, me, 'answer');

    if (proposal.startsAt.getTime() <= now.getTime()) {
      throw new AppError(ERROR_CODES.DUEL_TIME_INVALID, 'Proposed time has passed', {
        startsAt: proposal.startsAt.toISOString(),
      });
    }

    await this.prisma.$transaction(async (tx) => {
      if (duel.rated && duel.opponentId !== null) {
        await this.rating.assertSchedulable(
          tx,
          duelId,
          duel.authorId,
          duel.opponentId,
          proposal.startsAt,
        );
      }

      await claimDuel(
        tx,
        duelId,
        ['SCHEDULED'],
        {
          startsAt: proposal.startsAt,
          endsAt: proposal.endsAt,
          playAt: proposal.startsAt,
          agreedAt: now,
          reminderSentAt: null,
          ...CLEAR_RESCHEDULE,
        },
        this.sameProposal(proposal),
      );
      await this.answered(tx, duel, me, proposal, 'ACCEPTED', now);
    });

    return this.duels.render(duelId, me, now);
  }

  /** Второй отказывает: действует прежнее время. */
  async declineReschedule(duelId: string, userId: string, now = new Date()): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);
    const proposal = this.proposal(duel, me, 'answer');

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(tx, duelId, ['SCHEDULED'], CLEAR_RESCHEDULE, this.sameProposal(proposal));
      await this.answered(tx, duel, me, proposal, 'DECLINED', now);
    });

    return this.duels.render(duelId, me, now);
  }

  /** Предложивший отзывает свой перенос. */
  async withdrawReschedule(duelId: string, userId: string, now = new Date()): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);
    const proposal = this.proposal(duel, me, 'own');

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(tx, duelId, ['SCHEDULED'], CLEAR_RESCHEDULE, this.sameProposal(proposal));
    });

    return this.duels.render(duelId, me, now);
  }

  // ---------------------------------------------------------------- контакт

  /** Свой контакт — с создания и дальше; `null` — убрать. */
  async contact(
    duelId: string,
    userId: string,
    input: DuelContactInput,
    now = new Date(),
  ): Promise<DuelView> {
    const { me, duel } = await this.participant(duelId, userId, now);

    await this.prisma.duel.update({
      where: { id: duelId },
      data:
        duel.authorId === me.playerId
          ? { authorContact: input.contact }
          : { opponentContact: input.contact },
      select: { id: true },
    });

    return this.duels.render(duelId, me, now);
  }

  // ---------------------------------------------------------------- общее

  /** Действует только участник: автор или соперник. */
  private async participant(
    duelId: string,
    userId: string,
    now: Date,
  ): Promise<{ me: DuelActor; duel: DuelRecord }> {
    await this.duels.settleStale(now);

    const me = await this.duels.actor(userId);
    const duel = await this.duels.load(duelId);

    if (duel.authorId !== me.playerId && duel.opponentId !== me.playerId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only a participant manages the match', {
        id: duelId,
      });
    }

    return { me, duel };
  }

  /** Табло ведётся: назначенная рейтинговая, матч начат. Возвращает `setsToWin`. */
  private assertBoard(duel: DuelRecord): number {
    if (duel.status !== 'SCHEDULED' || duel.bestOf === null) throw invalidState(duel.status);

    if (duel.startedAt === null) throw invalidState(duel.status, { started: false });

    return setsToWin(duel.bestOf as DuelBestOf);
  }

  /** Перенос — пока игра назначена и не начата. */
  private assertReschedulable(duel: DuelRecord): void {
    if (duel.status !== 'SCHEDULED') throw invalidState(duel.status);

    if (duel.startedAt !== null) throw invalidState(duel.status, { started: true });
  }

  /**
   * Предложенный перенос: отвечает второй (`answer`), отзывает предложивший
   * (`own`). Нет предложения — не к состоянию.
   */
  private proposal(duel: DuelRecord, me: DuelActor, role: 'answer' | 'own'): Proposal {
    this.assertReschedulable(duel);

    const { rescheduleStartsAt, rescheduleEndsAt, rescheduleById } = duel;

    if (rescheduleStartsAt === null || rescheduleEndsAt === null || rescheduleById === null) {
      throw invalidState(duel.status, { reschedule: null });
    }

    const mine = rescheduleById === me.playerId;

    if (role === 'answer' ? mine : !mine) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        role === 'answer' ? 'Cannot answer own proposal' : 'Only the proposer withdraws',
        { id: duel.id },
      );
    }

    return { startsAt: rescheduleStartsAt, endsAt: rescheduleEndsAt, proposedById: rescheduleById };
  }

  /** Ответ — на то самое предложение: новое, пришедшее между чтением и ответом, не тронется. */
  private sameProposal(proposal: Proposal): Prisma.DuelWhereInput {
    return {
      startedAt: null,
      rescheduleById: proposal.proposedById,
      rescheduleStartsAt: proposal.startsAt,
    };
  }

  /** Предложившему — ответ на его перенос. */
  private async answered(
    tx: Prisma.TransactionClient,
    duel: DuelRecord,
    me: DuelActor,
    proposal: Proposal,
    action: 'ACCEPTED' | 'DECLINED',
    now: Date,
  ): Promise<void> {
    const proposer = otherSide(duel, me.playerId);

    if (proposer.userId !== null) {
      await this.notifications.create(tx, [proposer.userId], 'DUEL_RESCHEDULE', {
        duelId: duel.id,
        kind: duel.kind,
        playerName: me.name,
        startsAt: proposal.startsAt.toISOString(),
        action,
      });
    }

    await this.notifications.settleDuel(tx, me.userId, duel.id, now);
  }

  /** Партии табло — условием на прежний список: два нажатия не запишут одно дважды. */
  private async moveSets(duel: DuelRecord, next: string[]): Promise<void> {
    const updated = await this.prisma.duel.updateMany({
      where: {
        id: duel.id,
        status: 'SCHEDULED',
        startedAt: { not: null },
        sets: { equals: duel.sets },
      },
      data: { sets: next },
    });

    if (updated.count > 0) return;

    const fresh = await this.prisma.duel.findUnique({
      where: { id: duel.id },
      select: { status: true, sets: true },
    });

    throw invalidState(fresh?.status ?? duel.status, {
      sets: fresh?.sets.length ?? duel.sets.length,
    });
  }
}

interface Proposal {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly proposedById: string;
}
