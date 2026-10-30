import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { ScreenControlView, ScreenView } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { withdrawnPlayers } from '../tournaments/finish.js';
import { loadTournamentState } from '../tournaments/tournament-state.js';
import { toPlayerView, toStageView, toTournamentView } from '../tournaments/tournaments.mapper.js';
import { tournamentFields } from '../tournaments/tournaments.select.js';

/**
 * Второй экран зала — ТЗ 6.5, маршрут ТС 7.7.
 *
 * Собирается из тех же записей и теми же функциями, что публичные результаты:
 * таблицы считает движок через `buildStandings`, представления даёт общий
 * маппер. Своей проекции у экрана нет намеренно — стена и страница результатов
 * обязаны показывать одно и то же.
 */
const SLIDES: ReadonlySet<string> = new Set(['tables', 'groups', 'bracket', 'results']);

/**
 * Закрепление слайда в том виде, в каком его видит стена — ADR-082.
 *
 * Истёкшее или незнакомое (поле в базе — строка) — «Авто»: стена листает сама.
 */
export function controlOf(
  pin: string | null,
  until: Date | null,
  now: Date = new Date(),
): ScreenControlView {
  return pin !== null && SLIDES.has(pin) && until !== null && until > now
    ? { pin: pin as NonNullable<ScreenControlView['pin']>, until: until.toISOString() }
    : { pin: null, until: null };
}

@Injectable()
export class ScreenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Состояние экрана по публичному токену.
   *
   * Токена достаточно: ни сессии, ни прав здесь нет — ссылка открывается на
   * телевизоре в зале, где входить некому. Черновик по токену не отдаётся:
   * до жеребьёвки показывать нечего, а токен существует с создания турнира.
   */
  async byToken(publicToken: string): Promise<ScreenView> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { publicToken },
      select: { ...tournamentFields, screenPin: true, screenPinUntil: true },
    });

    if (tournament === null || tournament.status === 'DRAFT') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Screen not found', { publicToken });
    }

    const state = await loadTournamentState(this.prisma, tournament);

    return {
      tournament: toTournamentView(tournament),
      players: state.registrations.map((registration) => toPlayerView(registration.player)),
      withdrawn: [...withdrawnPlayers(state.registrations)],
      standings: state.standings,
      stages: state.stages.map(toStageView),
      updatedAt: new Date().toISOString(),
      control: controlOf(tournament.screenPin, tournament.screenPinUntil),
    };
  }

  /** Идентификатор турнира по токену: поток подписывается на него, а не на токен. */
  async tournamentIdOf(publicToken: string): Promise<string> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { publicToken },
      select: { id: true, status: true },
    });

    if (tournament === null || tournament.status === 'DRAFT') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Screen not found', { publicToken });
    }

    return tournament.id;
  }
}
