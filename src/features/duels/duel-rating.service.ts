import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  DUEL_PAIR_WINDOW_DAYS,
  PROVISIONAL_THRESHOLD,
  applyDelta,
  calculateDuelRating,
  duelRatingBlock,
  negate,
  type RatedDuelRecord,
} from '@kttf/shared/rating';
import type { ReportDuelInput } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { RATING_HOLD_STATUSES, invalidState } from './duel-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Дальше этого `duelRatingBlock` дуэли не сравнивает — читать их незачем. */
const BLOCK_WINDOW_MS = DUEL_PAIR_WINDOW_DAYS * DAY_MS;

type Tx = Prisma.TransactionClient;

/** Дуэль в объёме, нужном для начисления. */
export interface RatedDuel {
  readonly id: string;
  readonly authorId: string;
  readonly opponentId: string | null;
  readonly startsAt: Date | null;
}

/**
 * Рейтинг дуэлей — ADR-065 §5, `docs/13` §3.4–3.6.
 *
 * Сама арифметика и правила частоты — в `@kttf/shared/rating` (бриф,
 * запрет №2); здесь только чтение журнала и запись в него. Всё работает
 * внутри транзакции вызывающего: начисление, смена состояния дуэли и
 * уведомления либо случаются вместе, либо не случаются вовсе.
 */
@Injectable()
export class DuelRatingService {
  /**
   * Можно ли назначить рейтинговую встречу этой пары на это время. Строки
   * обоих игроков блокируются: две одновременные «Принять» не пройдут
   * проверку частоты вдвоём, видя друг друга несуществующими.
   */
  async assertSchedulable(
    tx: Tx,
    duelId: string,
    playerAId: string,
    playerBId: string,
    at: Date,
  ): Promise<void> {
    await lockPlayers(tx, [playerAId, playerBId]);

    const block = duelRatingBlock(
      await this.records(tx, [playerAId, playerBId], at, duelId),
      playerAId,
      playerBId,
      at,
    );

    if (block !== null) {
      throw new AppError(ERROR_CODES.DUEL_RATING_LIMIT, 'Rated duel frequency limit', {
        kind: block.kind,
        playerId: block.playerId,
      });
    }
  }

  /**
   * Начисление по подтверждённому счёту — подтверждение соперником или
   * решение администратора. Предел частоты проверяется ещё раз: между
   * назначением и счётом могли подтвердиться другие дуэли. Сработал —
   * дуэль сыграна без рейтинга (`ratingSkipped`), а не отказ: игра была.
   *
   * Снимок — текущее состояние проекции в момент подтверждения: он же и
   * «на старте», и «сейчас», поэтому цепочка журнала непрерывна сама собой.
   *
   * Возвращает дельты по игрокам строкой или `null`, если рейтинг не менялся.
   */
  async apply(
    tx: Tx,
    duel: RatedDuel,
    result: ReportDuelInput,
    userId: string,
  ): Promise<ReadonlyMap<string, string> | null> {
    const { authorId, opponentId, startsAt } = duel;

    if (opponentId === null || startsAt === null) throw invalidState('OPEN');

    await lockPlayers(tx, [authorId, opponentId]);

    const block = duelRatingBlock(
      await this.records(tx, [authorId, opponentId], startsAt, duel.id),
      authorId,
      opponentId,
      startsAt,
    );

    if (block !== null) {
      await tx.duel.update({
        where: { id: duel.id },
        data: { ratingSkipped: block.kind },
        select: { id: true },
      });

      return null;
    }

    const loserId = result.winnerId === authorId ? opponentId : authorId;
    const players = await tx.player.findMany({
      where: { id: { in: [authorId, opponentId] } },
      select: { id: true, rating: true, ratedMatches: true },
    });
    const snapshot = (id: string) => {
      const player = players.find((row) => row.id === id);

      if (player === undefined) throw new Error(`Дуэль ${duel.id}: игрок ${id} не найден`);

      return { rating: Number(player.rating), ratedMatches: player.ratedMatches };
    };
    const winner = snapshot(result.winnerId);
    const loser = snapshot(loserId);
    const rating = calculateDuelRating({
      duelId: duel.id,
      winnerId: result.winnerId,
      loserId,
      winner,
      loser,
      winnerSets: result.winnerSets,
      loserSets: result.loserSets,
    });

    // Те же поля, что у события турнира: аудит и пересчёт читают их одинаково.
    // `matchId` черновика — идентификатор дуэли, в журнал он идёт как `duelId`.
    await tx.ratingEvent.createMany({
      data: rating.events.map((event) => ({
        playerId: event.playerId,
        duelId: duel.id,
        type: 'MATCH' as const,
        ratingBefore: event.ratingBefore,
        delta: event.delta,
        ratingAfter: event.ratingAfter,
        opponentRating: event.opponentRating,
        kFactor: event.kFactor,
        tFactor: event.tFactor,
        mFactor: event.mFactor,
        expected: event.expected,
        gapMultiplier: event.gapMultiplier,
        imbalance: event.imbalance,
        clamped: event.clamped,
        createdBy: userId,
      })),
    });

    for (const player of rating.players) {
      await tx.player.update({
        where: { id: player.playerId },
        data: {
          rating: player.rating,
          ratedMatches: player.ratedMatches,
          isProvisional: player.isProvisional,
        },
        select: { id: true },
      });
    }

    // Пометка PROVISIONAL смотрит на момент начисления: потом игрок
    // наберёт встреч, и текущий признак об этой дуэли уже ничего не скажет.
    await tx.duel.update({
      where: { id: duel.id },
      data: {
        provisional: [winner, loser].some((side) => side.ratedMatches < PROVISIONAL_THRESHOLD),
      },
      select: { id: true },
    });

    return new Map(
      rating.events.map((event) => [event.playerId, new Prisma.Decimal(event.delta).toString()]),
    );
  }

  /**
   * Отмена начисления администратором: каждому участнику — обратное событие
   * `MANUAL_ADJUST` со ссылкой на дуэль и причиной. Журнал не переписывается
   * (бриф, запрет №3), последующие события не пересчитываются: их дельты
   * считались против рейтинга, который тогда был.
   *
   * Обратная дельта применяется к текущему рейтингу с той же отсечкой по
   * `MIN_RATING`, что и всё остальное: фактически снятое может быть меньше
   * начисленного, и это видно по `clamped`.
   *
   * Счётчик встреч (`ratedMatches`) не трогается: событие `MATCH` в журнале
   * осталось, и проекция, пересобранная из журнала, насчитала бы его снова.
   */
  async annul(tx: Tx, duelId: string, reason: string, userId: string): Promise<void> {
    const events = await tx.ratingEvent.findMany({
      where: { duelId, type: 'MATCH' },
      select: { playerId: true, delta: true },
    });

    if (events.length === 0) throw invalidState('COMPLETED', { rated: false });

    const ids = events.map((event) => event.playerId);

    await lockPlayers(tx, ids);

    const players = await tx.player.findMany({
      where: { id: { in: ids } },
      select: { id: true, rating: true },
    });

    for (const event of events) {
      const player = players.find((row) => row.id === event.playerId);

      if (player === undefined) continue;

      const before = Number(player.rating);
      const applied = applyDelta(before, negate(Number(event.delta)));

      await tx.ratingEvent.create({
        data: {
          playerId: event.playerId,
          duelId,
          type: 'MANUAL_ADJUST',
          ratingBefore: before,
          delta: applied.appliedDelta,
          ratingAfter: applied.rating,
          clamped: applied.clamped,
          reason,
          createdBy: userId,
        },
        select: { id: true },
      });
      await tx.player.update({
        where: { id: event.playerId },
        data: { rating: applied.rating },
        select: { id: true },
      });
    }
  }

  /**
   * Рейтинговые дуэли обоих, кроме проверяемой, в окне вокруг неё. Сыгранная
   * без рейтинга (`ratingSkipped`) и аннулированная места в пределе не
   * занимают: рейтинг по ним в итоге не менялся.
   */
  private async records(
    tx: Tx,
    playerIds: readonly string[],
    at: Date,
    excludeId: string,
  ): Promise<RatedDuelRecord[]> {
    const rows = await tx.duel.findMany({
      where: {
        id: { not: excludeId },
        rated: true,
        status: { in: [...RATING_HOLD_STATUSES] },
        annulledAt: null,
        ratingSkipped: null,
        startsAt: {
          gt: new Date(at.getTime() - BLOCK_WINDOW_MS),
          lt: new Date(at.getTime() + BLOCK_WINDOW_MS),
        },
        OR: [{ authorId: { in: [...playerIds] } }, { opponentId: { in: [...playerIds] } }],
      },
      select: { authorId: true, opponentId: true, startsAt: true },
    });

    return rows.flatMap((row) =>
      row.opponentId === null || row.startsAt === null
        ? []
        : [{ playerAId: row.authorId, playerBId: row.opponentId, at: row.startsAt }],
    );
  }
}

/**
 * Строки игроков — под замок до конца транзакции, в одном порядке: две
 * транзакции на одну пару ждут друг друга, а не взаимно блокируются.
 */
async function lockPlayers(tx: Tx, ids: readonly string[]): Promise<void> {
  const sorted = [...new Set(ids)].sort();

  await tx.$queryRaw`SELECT id FROM "Player" WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
}
