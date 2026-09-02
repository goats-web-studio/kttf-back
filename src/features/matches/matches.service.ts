import { resolveBracketSlots, validateMatchResult } from '@kttf/shared/brackets';
import type { BracketSlotMatch, BracketSlotSource } from '@kttf/shared/brackets';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  bracketSourceSchema,
  type AssignTableInput,
  type MatchDetailView,
  type MatchResultInput,
  type MatchUpdateResult,
  type MatchView,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ScreenEventsService } from '../screen/screen-events.service.js';
import { advanceAfterGroups } from '../tournaments/advance.js';
import { setsToWinOf } from '../tournaments/stage-config.js';
import { toMatchView, toStageView } from '../tournaments/tournaments.mapper.js';
import { matchFields, stageFields, type MatchRecord } from '../tournaments/tournaments.select.js';

/**
 * Встречи — ТС 7.6.
 *
 * Здесь живёт ввод счёта, то есть то место, ради которого делается продукт.
 * Всё, что можно посчитать до записи, считается чистыми функциями общего кода:
 * проверка счёта, продвижение победителя, отбор вышедших из групп. Приложение
 * только читает базу и пишет в неё — офлайн-консоль обязана получить те же
 * результаты тем же кодом (запрет №2 брифа).
 */

/** Встреча вместе с этапом и турниром: без них счёт не проверить и не записать. */
const matchWithContext = {
  ...matchFields,
  tournamentId: true,
  stage: { select: { id: true, order: true, config: true } },
  tournament: { select: { id: true, clubId: true, status: true } },
} as const;

type MatchWithContext = Prisma.MatchGetPayload<{ select: typeof matchWithContext }>;

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly screen: ScreenEventsService,
  ) {}

  async findById(id: string): Promise<MatchDetailView> {
    const match = await this.load(id);

    return { ...toMatchView(match), tournamentId: match.tournamentId };
  }

  /**
   * Назначение на стол — ТЗ 6.2.
   *
   * Встреча уезжает в зону «Играется». Результат этого шага не требует:
   * закрыть встречу можно и без назначения, иначе быстрых кнопок ТЗ 6.3
   * не получилось бы.
   */
  async assign(id: string, input: AssignTableInput, userId: string): Promise<MatchView> {
    const match = await this.load(id);

    await this.assertConsole(match, userId);
    assertRunning(match);
    assertReady(match);

    if (match.setsA !== null) {
      throw new AppError(ERROR_CODES.MATCH_ALREADY_FINISHED, 'Match already has a result', { id });
    }

    const updated = await this.prisma.match.update({
      where: { id },
      data: { tableNumber: input.tableNumber, status: 'PLAYING', startedAt: new Date() },
      select: matchFields,
    });

    this.screen.changed(match.tournamentId);

    return toMatchView(updated);
  }

  /** Ввод счёта — ТЗ 6.3. Изменение уже введённого идёт через `update`. */
  async result(id: string, input: MatchResultInput, userId: string): Promise<MatchUpdateResult> {
    return this.writeResult(await this.load(id), input, userId, 'create');
  }

  /**
   * Изменение уже введённого результата — ТЗ 6.3.
   *
   * Правка фиксируется в журнале: ТЗ 6.3 требует этого прямо, а спор о том,
   * какой счёт был введён изначально, иначе не разобрать.
   */
  async update(id: string, input: MatchResultInput, userId: string): Promise<MatchUpdateResult> {
    return this.writeResult(await this.load(id), input, userId, 'update');
  }

  /**
   * Отмена встречи с возвратом в очередь — ТЗ 6.3.
   *
   * Снимаются стол и результат, встреча возвращается в ожидание. Статус
   * `CANCELLED` здесь не выставляется: ТЗ 6.3 просит вернуть встречу в
   * очередь, а не вычеркнуть её из турнира.
   */
  async cancel(id: string, userId: string): Promise<MatchUpdateResult> {
    const match = await this.load(id);

    await this.assertConsole(match, userId);
    assertRunning(match);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertDownstreamFree(tx, match);

      const written = await tx.match.update({
        where: { id },
        data: {
          setsA: null,
          setsB: null,
          setScores: Prisma.DbNull,
          resultType: null,
          tableNumber: null,
          status: 'PENDING',
          startedAt: null,
          finishedAt: null,
        },
        select: matchFields,
      });

      return { written, advanced: await this.applyAdvancement(tx, match.stage.id) };
    });

    this.screen.changed(match.tournamentId);

    return {
      match: toMatchView(updated.written),
      updated: updated.advanced.map(toMatchView),
      nextStage: null,
      blockedByTies: [],
    };
  }

  /**
   * Общая часть ввода и правки: проверка, запись, продвижение, достройка.
   *
   * Право проверяется раньше состояния встречи: иначе посторонний узнавал бы
   * по коду отказа, введён ли уже счёт.
   */
  private async writeResult(
    match: MatchWithContext,
    input: MatchResultInput,
    userId: string,
    mode: 'create' | 'update',
  ): Promise<MatchUpdateResult> {
    await this.assertConsole(match, userId);
    assertRunning(match);
    assertReady(match);

    if (mode === 'create' && match.setsA !== null) {
      throw new AppError(ERROR_CODES.MATCH_ALREADY_FINISHED, 'Match already has a result', {
        id: match.id,
      });
    }
    if (mode === 'update' && match.setsA === null) {
      throw new AppError(ERROR_CODES.MATCH_HAS_NO_RESULT, 'Match has no result to change', {
        id: match.id,
      });
    }

    const problem = validateMatchResult(
      {
        setsA: input.setsA,
        setsB: input.setsB,
        setScores: input.setScores,
        resultType: input.resultType,
      },
      setsToWinOf(match.stage.config),
    );

    if (problem !== null) {
      throw new AppError(ERROR_CODES.INVALID_SCORE, 'Score does not fit the format', {
        problem,
        setsToWin: setsToWinOf(match.stage.config),
      });
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.assertDownstreamFree(tx, match);

      const written = await tx.match.update({
        where: { id: match.id },
        data: {
          setsA: input.setsA,
          setsB: input.setsB,
          setScores: input.setScores ?? Prisma.DbNull,
          resultType: input.resultType,
          status: 'FINISHED',
          finishedAt: new Date(),
        },
        select: matchFields,
      });

      if (mode === 'update') {
        // ТЗ 6.3: изменение результата фиксируется в журнале.
        await tx.auditLog.create({
          data: {
            actorId: userId,
            action: 'match.result.updated',
            entityType: 'Match',
            entityId: match.id,
            before: {
              setsA: match.setsA,
              setsB: match.setsB,
              setScores: match.setScores,
              resultType: match.resultType,
            },
            after: { ...input },
          },
        });
      }

      const advanced = await this.applyAdvancement(tx, match.stage.id);
      const next = await advanceAfterGroups(tx, match.tournamentId);

      return { written, advanced, next };
    });

    const nextStage =
      outcome.next.stageId === null ? null : await this.loadStage(outcome.next.stageId);

    // После транзакции, а не внутри: экран, разбуженный до коммита, перечитал
    // бы базу и увидел состояние без только что введённого счёта.
    this.screen.changed(match.tournamentId);

    return {
      match: toMatchView(outcome.written),
      updated: outcome.advanced.map(toMatchView),
      nextStage,
      blockedByTies: [...outcome.next.blockedByTies],
    };
  }

  /**
   * Пересчёт состава сетки по источникам — ADR-019.
   *
   * Считается весь этап целиком, а не одна следующая встреча: так правка
   * результата сама убирает из следующего круга прежнего победителя.
   */
  private async applyAdvancement(
    tx: Prisma.TransactionClient,
    stageId: string,
  ): Promise<MatchRecord[]> {
    const matches = await tx.match.findMany({ where: { stageId }, select: matchFields });
    const assignments = resolveBracketSlots(matches.map(toSlotMatch));

    if (assignments.length === 0) return [];

    const updated: MatchRecord[] = [];

    for (const assignment of assignments) {
      updated.push(
        await tx.match.update({
          where: { id: assignment.matchId },
          data:
            assignment.side === 'A'
              ? { playerAId: assignment.participant }
              : { playerBId: assignment.participant },
          select: matchFields,
        }),
      );
    }

    return updated;
  }

  /**
   * Есть ли ниже по сетке сыгранная встреча, которая держится на этом
   * результате.
   *
   * Каскадно стирать чужие результаты нельзя: судья должен снять нижнюю
   * встречу сам и увидеть, что именно он отменяет.
   */
  private async assertDownstreamFree(
    tx: Prisma.TransactionClient,
    match: MatchWithContext,
  ): Promise<void> {
    await this.assertLaterStagesFree(tx, match);

    const played = await tx.match.findMany({
      where: {
        stageId: match.stage.id,
        id: { not: match.id },
        NOT: { setsA: null },
      },
      select: matchFields,
    });

    const blocking = played.find((candidate) =>
      [candidate.sourceA, candidate.sourceB].some((source) => {
        const parsed = bracketSourceSchema.safeParse(source);
        return parsed.success && parsed.data.matchId === match.id;
      }),
    );

    if (blocking !== undefined) {
      throw new AppError(
        ERROR_CODES.DOWNSTREAM_MATCH_PLAYED,
        'A later match built on this result is already played',
        { matchId: match.id, blockedBy: blocking.id },
      );
    }
  }

  /**
   * Этапы, посеянные итогами этого: плей-офф после групп.
   *
   * Плей-офф сеется всей таблицей, а не одной встречей, поэтому правка любого
   * группового результата задевает его целиком. Пока в нём не сыграно ничего,
   * он просто сносится и достраивается заново по исправленной таблице. Как
   * только там появился результат, правка отклоняется: снести сыгранное молча
   * нельзя.
   */
  private async assertLaterStagesFree(
    tx: Prisma.TransactionClient,
    match: MatchWithContext,
  ): Promise<void> {
    const later = await tx.stage.findMany({
      where: { tournamentId: match.tournamentId, order: { gt: match.stage.order } },
      select: { id: true, matches: { where: { NOT: { setsA: null } }, select: { id: true } } },
    });

    if (later.length === 0) return;

    const blocking = later.find((stage) => stage.matches.length > 0);

    if (blocking !== undefined) {
      throw new AppError(
        ERROR_CODES.DOWNSTREAM_MATCH_PLAYED,
        'A later stage seeded by this result is already played',
        { matchId: match.id, blockedBy: blocking.matches[0]?.id },
      );
    }

    await tx.stage.deleteMany({ where: { id: { in: later.map((stage) => stage.id) } } });
  }

  private async loadStage(stageId: string): Promise<MatchUpdateResult['nextStage']> {
    const stage = await this.prisma.stage.findUnique({
      where: { id: stageId },
      select: stageFields,
    });

    /* v8 ignore next -- этап только что создан в той же транзакции */
    if (stage === null) return null;

    return toStageView(stage);
  }

  private async load(id: string): Promise<MatchWithContext> {
    const match = await this.prisma.match.findUnique({ where: { id }, select: matchWithContext });

    if (match === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Match not found', { id });
    }

    return match;
  }

  /**
   * Право вести консоль турнира.
   *
   * Судья турниром не управляет, но счёт вводит именно он: по ТЗ 1 его
   * доступ — консоль конкретного турнира (ADR-014, ADR-018).
   */
  private async assertConsole(match: MatchWithContext, userId: string): Promise<void> {
    const membership = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId: match.tournament.clubId, userId } },
      select: { role: true },
    });

    if (membership === null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Not allowed to run this tournament', {
        tournamentId: match.tournamentId,
      });
    }
  }
}

function assertRunning(match: MatchWithContext): void {
  if (match.tournament.status !== 'RUNNING') {
    throw new AppError(ERROR_CODES.TOURNAMENT_NOT_RUNNING, 'Tournament is not running', {
      tournamentId: match.tournamentId,
      status: match.tournament.status,
    });
  }
}

/** Пока предыдущий круг не сыгран, играть некому — ADR-019. */
function assertReady(match: MatchWithContext): void {
  if (match.playerAId === null || match.playerBId === null) {
    throw new AppError(ERROR_CODES.MATCH_NOT_READY, 'Match has no participants yet', {
      id: match.id,
    });
  }
}

function toSlotMatch(match: MatchRecord): BracketSlotMatch {
  return {
    id: match.id,
    a: match.playerAId,
    b: match.playerBId,
    sourceA: toSlotSource(match.sourceA),
    sourceB: toSlotSource(match.sourceB),
    setsA: match.setsA,
    setsB: match.setsB,
  };
}

/** Источник приходит из колонки `Json` и разбирается той же схемой, что писала. */
function toSlotSource(value: unknown): BracketSlotSource | null {
  const parsed = bracketSourceSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
