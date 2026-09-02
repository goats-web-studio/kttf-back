import {
  AppError,
  ERROR_CODES,
  isAppError,
  isErrorCode,
  type ErrorCode,
} from '@kttf/shared/errors';
import type {
  RejectedOperation,
  SyncOperation,
  SyncRequest,
  SyncResult,
  TournamentSnapshotView,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { MatchesService } from '../matches/matches.service.js';
import { assertConsoleAccess } from '../tournaments/console-access.js';
import { loadTournamentState } from '../tournaments/tournament-state.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';
import { tournamentFields, type TournamentRecord } from '../tournaments/tournaments.select.js';

import { buildSnapshot } from './snapshot.js';

/**
 * Синхронизация офлайн-очереди консоли — ТС 6.3, ADR-026.
 *
 * Операции применяются **теми же методами сервисов**, что и онлайн-маршруты:
 * `MATCH_RESULT` идёт через тот же ввод счёта, что и запрос по сети. Второго
 * описания правил здесь нет и быть не может — иначе счёт, введённый в зале без
 * сети, посчитался бы иначе, чем тот же счёт по сети (запрет №2 брифа).
 *
 * Порядок — строго по `seq`. Конфликт разрешается тем, что позднейшая
 * операция ложится поверх ранней: отдельного разбора конфликтов нет, и это
 * решение, а не упущение (ADR-026).
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matches: MatchesService,
    private readonly tournaments: TournamentsService,
  ) {}

  /** Снимок турнира для консоли — ТС 6.1. */
  async snapshot(id: string, userId: string): Promise<TournamentSnapshotView> {
    const tournament = await this.load(id, userId);

    return buildSnapshot(await loadTournamentState(this.prisma, tournament), new Date());
  }

  /**
   * Приём пачки операций.
   *
   * Отклонённая операция **не останавливает пачку**: судья, у которого одна
   * встреча уехала в отказ, не должен потерять остальные три часа работы.
   * Отказы возвращаются списком, снимок приходит всегда — по нему консоль
   * и увидит, что именно из введённого не легло.
   */
  async sync(id: string, input: SyncRequest, userId: string): Promise<SyncResult> {
    await this.load(id, userId);

    const applied: string[] = [];
    const rejected: RejectedOperation[] = [];
    const ordered = [...input.operations].sort((left, right) => left.seq - right.seq);

    for (const operation of ordered) {
      const outcome = await this.applyOnce(id, operation, input.lastServerVersion, userId);

      if (outcome === null) {
        applied.push(operation.clientOpId);
      } else {
        rejected.push({ clientOpId: operation.clientOpId, reason: outcome });
      }
    }

    // Турнир перечитывается после применения: версия и состояние изменились.
    const tournament = await this.load(id, userId);

    return {
      serverVersion: tournament.version,
      applied,
      rejected,
      snapshot: buildSnapshot(await loadTournamentState(this.prisma, tournament), new Date()),
    };
  }

  /**
   * Одна операция: журнал, применение, отметка исхода.
   *
   * Возвращает `null`, если операция применена, и код отказа, если нет.
   *
   * Запись в журнал идёт **до** применения: обрыв между применением и отметкой
   * оставил бы операцию неотмеченной, и повторная отправка применила бы её
   * второй раз. Уже известная операция второй раз не применяется — её исход
   * берётся из журнала. Прерванная попытка (запись есть, исхода нет)
   * применяется заново: все шесть типов задают состояние, а не приращение,
   * и повторное «поставить на стол 3» или «счёт 3:1» дают тот же результат.
   */
  private async applyOnce(
    tournamentId: string,
    operation: SyncOperation,
    basedOnVersion: number,
    userId: string,
  ): Promise<ErrorCode | null> {
    const known = await this.prisma.syncOperation.findUnique({
      where: {
        tournamentId_clientOpId: { tournamentId, clientOpId: operation.clientOpId },
      },
      select: { id: true, appliedAt: true, rejectedReason: true },
    });

    if (known !== null && (known.appliedAt !== null || known.rejectedReason !== null)) {
      return known.rejectedReason === null ? null : asErrorCode(known.rejectedReason);
    }

    const record =
      known ??
      (await this.prisma.syncOperation.create({
        data: {
          tournamentId,
          clientOpId: operation.clientOpId,
          seq: operation.seq,
          type: operation.type,
          // У отмены встречи тела нет: в колонке остаётся NULL, а не пустой
          // объект, — иначе журнал врал бы, что тело было.
          payload: 'payload' in operation ? operation.payload : Prisma.DbNull,
          basedOnVersion,
          actorId: userId,
        },
        select: { id: true, appliedAt: true, rejectedReason: true },
      }));

    try {
      await this.apply(tournamentId, operation, userId);
    } catch (error) {
      // Отказ по правилам домена — обычный исход синхронизации, а не сбой:
      // судья мог ввести счёт встречи, которую параллельно закрыли иначе.
      // Всё прочее наружу как `INTERNAL_ERROR`: в необработанном исключении
      // может оказаться что угодно, вплоть до строки подключения (ТС 7.8).
      const reason = isAppError(error) ? error.code : ERROR_CODES.INTERNAL_ERROR;

      await this.prisma.syncOperation.update({
        where: { id: record.id },
        data: { rejectedReason: reason },
      });

      return reason;
    }

    await this.prisma.syncOperation.update({
      where: { id: record.id },
      data: { appliedAt: new Date() },
    });

    return null;
  }

  /** Операция — тем же методом, каким её выполнил бы онлайн-маршрут. */
  private async apply(
    tournamentId: string,
    operation: SyncOperation,
    userId: string,
  ): Promise<void> {
    switch (operation.type) {
      case 'MATCH_ASSIGN':
        await this.assertOwnMatch(tournamentId, operation.matchId);
        await this.matches.assign(operation.matchId, operation.payload, userId);

        return;

      case 'MATCH_RESULT':
        await this.assertOwnMatch(tournamentId, operation.matchId);
        await this.matches.result(operation.matchId, operation.payload, userId);

        return;

      case 'MATCH_EDIT':
        await this.assertOwnMatch(tournamentId, operation.matchId);
        await this.matches.update(operation.matchId, operation.payload, userId);

        return;

      case 'MATCH_CANCEL':
        await this.assertOwnMatch(tournamentId, operation.matchId);
        await this.matches.cancel(operation.matchId, userId);

        return;

      case 'TIE_DECISION':
        await this.tournaments.resolveTie(tournamentId, operation.payload, userId);

        return;

      case 'PLAYER_WITHDRAW':
        await this.tournaments.updateRegistration(
          tournamentId,
          operation.registrationId,
          operation.payload,
          userId,
        );

        return;
    }
  }

  /**
   * Встреча принадлежит тому турниру, чью очередь синхронизируют.
   *
   * Иначе очередь одного турнира стала бы способом править чужой: право
   * проверяется по клубу, а клуб проводит турниры каждую неделю.
   */
  private async assertOwnMatch(tournamentId: string, matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { tournamentId: true },
    });

    if (match?.tournamentId !== tournamentId) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Match not found in this tournament', {
        tournamentId,
        matchId,
      });
    }
  }

  private async load(id: string, userId: string): Promise<TournamentRecord> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      select: tournamentFields,
    });

    if (tournament === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Tournament not found', { id });
    }

    await assertConsoleAccess(this.prisma, tournament.clubId, userId, { tournamentId: id });

    return tournament;
  }
}

/**
 * Код отказа из журнала.
 *
 * Колонка строковая: перечень кодов живёт в общем коде и меняется чаще, чем
 * стоит гонять миграции. Строка, не попавшая в перечень, означает порчу
 * данных, и наружу она уходит как внутренняя ошибка, а не как чужой код.
 */
function asErrorCode(value: string): ErrorCode {
  return isErrorCode(value) ? value : ERROR_CODES.INTERNAL_ERROR;
}
