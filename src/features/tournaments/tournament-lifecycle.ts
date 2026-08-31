import type { TournamentStatus } from '@kttf/shared/types';

/**
 * Жизненный цикл турнира — ТЗ 4.1.
 *
 * Чистая таблица переходов, без базы и без Nest: бриф 5.1 требует покрыть
 * тестами **все** переходы, а не только удачные. Проверять их на живой базе
 * означало бы двадцать восемь интеграционных тестов вместо одной таблицы.
 */

/** Действия, доступные человеку. Переход в `RUNNING` и дальше — не отсюда. */
export const TOURNAMENT_ACTIONS = [
  'publish',
  'openRegistration',
  'closeRegistration',
  'start',
  'finish',
  'rate',
  'cancel',
] as const;

export type TournamentAction = (typeof TOURNAMENT_ACTIONS)[number];

const TRANSITIONS: Readonly<Record<TournamentAction, Readonly<Record<string, TournamentStatus>>>> =
  {
    publish: { DRAFT: 'PUBLISHED' },
    openRegistration: { PUBLISHED: 'REG_OPEN' },
    closeRegistration: { REG_OPEN: 'REG_CLOSED' },
    // Требует сформированных групп — это проверяет жеребьёвка, а не таблица.
    start: { REG_CLOSED: 'RUNNING' },
    // Требует, чтобы все встречи имели результат. Тоже условие сверх таблицы.
    finish: { RUNNING: 'FINISHED' },
    // Условие сверх таблицы — «расчёт рейтинга выполнен успешно» (ТЗ 4.1).
    // Отдельным маршрутом наружу не выходит: обсчёт делает тот же `finish`
    // второй транзакцией, и в «Завершён» турнир остаётся только если расчёт
    // не удался. Тогда повторный вызов доводит его до «Обсчитан».
    rate: { FINISHED: 'RATED' },
    cancel: {
      DRAFT: 'CANCELLED',
      PUBLISHED: 'CANCELLED',
      REG_OPEN: 'CANCELLED',
      REG_CLOSED: 'CANCELLED',
      RUNNING: 'CANCELLED',
      FINISHED: 'CANCELLED',
    },
  };

/**
 * Куда переводит действие из текущего статуса. `undefined` — переход запрещён.
 *
 * Отменить можно из любого статуса, кроме `RATED`: рейтинг уже разошёлся по
 * журналу событий и по профилям игроков, и отмена турнира его не вернёт.
 * Такой случай разбирается пересчётом, а не сменой статуса (ТЗ 4.1).
 */
export function nextStatus(
  current: TournamentStatus,
  action: TournamentAction,
): TournamentStatus | undefined {
  return TRANSITIONS[action][current];
}

/** Меняется ли состав участников. После закрытия регистрации — нет. */
export function acceptsRegistrations(status: TournamentStatus): boolean {
  return status === 'REG_OPEN';
}

/** Виден ли турнир тем, кто не управляет клубом. Черновик — нет. */
export function isPublic(status: TournamentStatus): boolean {
  return status !== 'DRAFT';
}

/** Можно ли ещё удалить турнир насовсем, а не отменить. */
export function isDeletable(status: TournamentStatus): boolean {
  // Опубликованный турнир уже видели игроки, на него могли записаться.
  // Для него в ТЗ 4.1 есть отдельный переход — отмена.
  return status === 'DRAFT';
}
