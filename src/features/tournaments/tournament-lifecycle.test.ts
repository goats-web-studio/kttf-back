import type { TournamentStatus } from '@kttf/shared/types';
import { describe, expect, it } from 'vitest';

import {
  acceptsRegistrations,
  isDeletable,
  isPublic,
  nextStatus,
  TOURNAMENT_ACTIONS,
  type TournamentAction,
} from './tournament-lifecycle.js';

const STATUSES: TournamentStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'REG_OPEN',
  'REG_CLOSED',
  'RUNNING',
  'FINISHED',
  'RATED',
  'CANCELLED',
];

/**
 * Разрешённые переходы — ТЗ 4.1, целиком.
 *
 * Бриф 5.1 требует покрыть все переходы. Таблица перечисляет только
 * разрешённые, а тест проверяет и их, и то, что все остальные запрещены:
 * забытый запрет опаснее забытого разрешения — он молча пускает турнир
 * туда, откуда возврата нет.
 */
const ALLOWED: readonly [TournamentStatus, TournamentAction, TournamentStatus][] = [
  ['DRAFT', 'publish', 'PUBLISHED'],
  ['PUBLISHED', 'openRegistration', 'REG_OPEN'],
  ['REG_OPEN', 'closeRegistration', 'REG_CLOSED'],
  ['REG_CLOSED', 'start', 'RUNNING'],
  ['RUNNING', 'finish', 'FINISHED'],
  ['FINISHED', 'rate', 'RATED'],
  ['DRAFT', 'cancel', 'CANCELLED'],
  ['PUBLISHED', 'cancel', 'CANCELLED'],
  ['REG_OPEN', 'cancel', 'CANCELLED'],
  ['REG_CLOSED', 'cancel', 'CANCELLED'],
  ['RUNNING', 'cancel', 'CANCELLED'],
  ['FINISHED', 'cancel', 'CANCELLED'],
];

describe('переходы жизненного цикла', () => {
  it.each(ALLOWED)('из %s действие %s ведёт в %s', (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it('всё, чего нет в таблице, запрещено', () => {
    const allowed = new Set(ALLOWED.map(([from, action]) => `${from}:${action}`));

    for (const status of STATUSES) {
      for (const action of TOURNAMENT_ACTIONS) {
        if (allowed.has(`${status}:${action}`)) continue;

        expect(nextStatus(status, action), `${status} + ${action}`).toBeUndefined();
      }
    }
  });

  it('обсчитанный турнир не отменяется', () => {
    // Рейтинг уже разошёлся по журналу событий и профилям игроков. Смена
    // статуса его не вернёт — такой случай разбирается пересчётом.
    expect(nextStatus('RATED', 'cancel')).toBeUndefined();
  });

  it('отменённый турнир не оживает', () => {
    for (const action of TOURNAMENT_ACTIONS) {
      expect(nextStatus('CANCELLED', action), action).toBeUndefined();
    }
  });

  it('этапы не перепрыгиваются', () => {
    // Из черновика нельзя открыть регистрацию, минуя публикацию: иначе
    // игроки записываются на турнир, которого ещё нет в календаре.
    expect(nextStatus('DRAFT', 'openRegistration')).toBeUndefined();
    expect(nextStatus('PUBLISHED', 'start')).toBeUndefined();
    expect(nextStatus('REG_OPEN', 'start')).toBeUndefined();
  });
});

describe('свойства статуса', () => {
  it('состав меняется только при открытой регистрации', () => {
    for (const status of STATUSES) {
      expect(acceptsRegistrations(status), status).toBe(status === 'REG_OPEN');
    }
  });

  it('черновик не публичен, остальное публично', () => {
    for (const status of STATUSES) {
      expect(isPublic(status), status).toBe(status !== 'DRAFT');
    }
  });

  it('удалить можно только черновик', () => {
    // Для опубликованного в ТЗ 4.1 есть отдельный переход — отмена.
    for (const status of STATUSES) {
      expect(isDeletable(status), status).toBe(status === 'DRAFT');
    }
  });
});
