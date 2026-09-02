import type { TournamentSnapshotView } from '@kttf/shared/types';

import type { TournamentState } from '../tournaments/tournament-state.js';
import {
  toRegistrationView,
  toStageView,
  toTournamentView,
} from '../tournaments/tournaments.mapper.js';

/**
 * Снимок турнира для консоли — ТС 6.1.
 *
 * То, что кладётся в локальное хранилище судьи и с чем он остаётся, когда
 * сеть пропадёт. Отсюда состав: турнир, участники со статусами и посевом,
 * этапы со встречами и посчитанные таблицы. Журнала рейтинга нет — он не
 * нужен в зале и занимал бы место на диске телефона.
 *
 * Ничего не считается здесь заново: таблицы уже посчитаны движком, места и
 * продвижение по сетке придут тем же кодом, что работает в консоли офлайн
 * (запрет №2 брифа).
 */
export function buildSnapshot(state: TournamentState, takenAt: Date): TournamentSnapshotView {
  return {
    version: state.tournament.version,
    tournament: toTournamentView(state.tournament),
    registrations: state.registrations.map(toRegistrationView),
    standings: state.standings,
    stages: state.stages.map(toStageView),
    takenAt: takenAt.toISOString(),
  };
}
