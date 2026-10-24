import {
  DUEL_FLAG_WINDOW_DAYS,
  type AdminDuelItemView,
  type AnnulDuelInput,
  type DuelBestOf,
  type DuelView,
  type ListAdminDuelsQuery,
  type Page,
  type ResolveDuelInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf, skipOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DuelRatingService } from './duel-rating.service.js';
import { FLAG_STATUSES, assertScore, duelFlags, invalidState } from './duel-rules.js';
import {
  ANONYMOUS_VIEWER,
  duelFields,
  playerName,
  ratingChangeFields,
  toDuelItem,
  toRatingChange,
  type DuelRecord,
} from './duel-view.js';
import { DuelsService, claimDuel } from './duels.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = DUEL_FLAG_WINDOW_DAYS * DAY_MS;

/**
 * Надзор администратора за рейтинговыми дуэлями — ADR-065 §6, `docs/13` §3.6.
 *
 * Очередь с пометками, решение спора и отмена начисления. Пометки
 * считаются на лету по журналу: хранить их значило бы пересчитывать при
 * каждой новой дуэли пары. Блокировок автоматом нет (бриф, запрет №7) —
 * решает человек.
 */
@Injectable()
export class DuelsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly rating: DuelRatingService,
    private readonly duels: DuelsService,
  ) {}

  /**
   * Рейтинговые дуэли, свежие первыми. С `flagged` пометки нужны до
   * постраничности — выборка читается целиком и режется в памяти: рейтинговых
   * дуэлей у платформы сотни, а не миллионы, и фильтр по вычисляемому
   * признаку в SQL не выразить.
   */
  async list(query: ListAdminDuelsQuery, now = new Date()): Promise<Page<AdminDuelItemView>> {
    await this.duels.settleStale(now);

    const where: Prisma.DuelWhereInput = {
      rated: true,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.playerId === undefined
        ? {}
        : { OR: [{ authorId: query.playerId }, { opponentId: query.playerId }] }),
    };
    const orderBy: Prisma.DuelOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

    if (query.flagged === true) {
      const rows = await this.prisma.duel.findMany({ where, select: duelFields, orderBy });
      const flagged = (await this.decorate(rows)).filter((item) => item.flags.length > 0);
      const skip = skipOf(query);

      return pageOf(flagged.slice(skip, skip + query.limit), flagged.length, query);
    }

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
    // `flagged=false` — без фильтра, как и без параметра: «без пометок» никто не просил.
    return pageOf(await this.decorate(rows), total, query);
  }

  /**
   * Решение спора: счёт — дуэль обсчитывается как подтверждённая (с той же
   * повторной проверкой частоты), без счёта — не засчитывается. Обоим —
   * уведомление с их изменением рейтинга.
   */
  async resolve(
    id: string,
    adminId: string,
    input: ResolveDuelInput,
    now = new Date(),
  ): Promise<DuelView> {
    await this.duels.settleStale(now);

    const duel = await this.duels.load(id);

    if (duel.status !== 'DISPUTED') throw invalidState(duel.status);

    const opponent = duel.opponent;

    if (opponent === null) throw invalidState(duel.status);

    const result = input.result;

    if (result !== undefined) {
      assertScore(duel.bestOf as DuelBestOf, result, [duel.authorId, opponent.id]);
    }

    await this.prisma.$transaction(async (tx) => {
      const resolution = {
        resolutionComment: input.comment,
        resolvedById: adminId,
        resolvedAt: now,
      };
      let deltas: ReadonlyMap<string, string> | null = null;

      if (result === undefined) {
        await claimDuel(tx, id, ['DISPUTED'], {
          ...resolution,
          status: 'CANCELLED',
          closedAt: now,
        });
      } else {
        await claimDuel(tx, id, ['DISPUTED'], {
          ...resolution,
          status: 'COMPLETED',
          winnerId: result.winnerId,
          winnerSets: result.winnerSets,
          loserSets: result.loserSets,
          confirmedAt: now,
        });
        deltas = await this.rating.apply(tx, duel, result, adminId);
      }

      for (const [side, other] of [
        [duel.author, opponent],
        [opponent, duel.author],
      ] as const) {
        if (side.userId === null) continue;

        await this.notifications.create(tx, [side.userId], 'DUEL_COMPLETED', {
          duelId: id,
          kind: duel.kind,
          playerName: playerName(other),
          delta: deltas?.get(side.id) ?? null,
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'duel.resolve',
          entityType: 'Duel',
          entityId: id,
          before: { status: duel.status },
          after: {
            status: result === undefined ? 'CANCELLED' : 'COMPLETED',
            result: result ?? null,
            comment: input.comment,
            rated: deltas !== null,
          },
        },
      });
    });

    return this.duels.render(id, await this.duels.viewer(adminId), now);
  }

  /**
   * Отмена начисления: обратные события `MANUAL_ADJUST` обоим, дуэль
   * помечается аннулированной. Только сыгранная с рейтингом и один раз.
   */
  async annul(
    id: string,
    adminId: string,
    input: AnnulDuelInput,
    now = new Date(),
  ): Promise<DuelView> {
    const duel = await this.duels.load(id);

    if (duel.status !== 'COMPLETED' || duel.ratingSkipped !== null || duel.annulledAt !== null) {
      throw invalidState(duel.status, { annulled: duel.annulledAt !== null });
    }

    await this.prisma.$transaction(async (tx) => {
      await claimDuel(
        tx,
        id,
        ['COMPLETED'],
        { annulledAt: now, annulReason: input.reason, annulledById: adminId },
        { annulledAt: null },
      );
      await this.rating.annul(tx, id, input.reason, adminId);
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: 'duel.annul',
          entityType: 'Duel',
          entityId: id,
          after: { reason: input.reason },
        },
      });
    });

    return this.duels.render(id, await this.duels.viewer(adminId), now);
  }

  /**
   * Пометки, начисление и счёт пары за 30 дней для строк очереди. Три
   * запроса на страницу, а не на строку: дуэли пар, начисления победителей и
   * изменения рейтинга по самим дуэлям.
   */
  private async decorate(rows: readonly DuelRecord[]): Promise<AdminDuelItemView[]> {
    if (rows.length === 0) return [];

    const at = (row: { startsAt: Date | null; slotsFrom: Date }): Date =>
      row.startsAt ?? row.slotsFrom;
    const times = rows.map((row) => at(row).getTime());
    const from = new Date(Math.min(...times) - WINDOW_MS);
    const to = new Date(Math.max(...times));
    const players = [
      ...new Set(
        rows.flatMap((row) => [row.authorId, ...(row.opponentId ? [row.opponentId] : [])]),
      ),
    ];
    const winners = [...new Set(rows.flatMap((row) => (row.winnerId ? [row.winnerId] : [])))];

    const [pairRows, gainRows, changeRows] = await Promise.all([
      this.prisma.duel.findMany({
        where: {
          rated: true,
          status: { in: [...FLAG_STATUSES] },
          startsAt: { gt: from, lte: to },
          OR: [{ authorId: { in: players } }, { opponentId: { in: players } }],
        },
        select: { id: true, authorId: true, opponentId: true, startsAt: true, winnerId: true },
      }),
      winners.length === 0
        ? Promise.resolve([])
        : this.prisma.ratingEvent.findMany({
            where: {
              playerId: { in: winners },
              type: 'MATCH',
              duel: { is: { annulledAt: null, startsAt: { gt: from, lte: to } } },
            },
            select: { playerId: true, delta: true, duel: { select: { startsAt: true } } },
          }),
      this.prisma.ratingEvent.findMany({
        where: { duelId: { in: rows.map((row) => row.id) }, type: 'MATCH' },
        select: { ...ratingChangeFields, duelId: true },
        orderBy: { playerId: 'asc' },
      }),
    ]);

    const pairDuels = pairRows.flatMap((row) =>
      row.startsAt === null ? [] : [{ ...row, at: row.startsAt }],
    );
    const gains = gainRows.flatMap((row) => {
      const playedAt = row.duel?.startsAt ?? null;

      return playedAt === null
        ? []
        : [{ playerId: row.playerId, at: playedAt, delta: Number(row.delta) }];
    });

    return rows.map((row) => {
      const { flags, pairCount } = duelFlags(
        {
          id: row.id,
          authorId: row.authorId,
          opponentId: row.opponentId,
          at: at(row),
          winnerId: row.winnerId,
          // До начисления — текущий признак: дуэль ещё может сыграться.
          provisional:
            row.provisional ?? (row.author.isProvisional || row.opponent?.isProvisional === true),
        },
        pairDuels,
        gains,
      );

      return {
        // Администратор смотрит со стороны: «новых откликов» у него нет.
        ...toDuelItem(row, ANONYMOUS_VIEWER),
        flags,
        ratingChanges: changeRows.filter((change) => change.duelId === row.id).map(toRatingChange),
        annulledAt: row.annulledAt?.toISOString() ?? null,
        pairCount30d: pairCount,
      };
    });
  }
}
