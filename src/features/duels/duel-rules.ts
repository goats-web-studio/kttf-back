import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  DUEL_FLAG_BIG_GAIN,
  DUEL_FLAG_PAIR_COUNT,
  DUEL_FLAG_WINDOW_DAYS,
  DUEL_HORIZON_DAYS,
  setsToWin,
  type DuelBestOf,
  type DuelFlag,
  type DuelStatus,
  type ReportDuelInput,
} from '@kttf/shared/types';

/**
 * Правила дуэлей, которым не нужна база, — ADR-065, `docs/13` §3. Чистые
 * функции: сервис читает записи, здесь решается, можно ли.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Рейтинговые дуэли, занимающие место в пределе частоты (`duelRatingBlock`):
 * назначенные и сыгранные. `UNCONFIRMED` сюда не входит — рейтинг по ней не
 * менялся, и держать из-за неё место в неделе значило бы наказывать за
 * молчание соперника.
 */
export const RATING_HOLD_STATUSES = [
  'SCHEDULED',
  'REPORTED',
  'DISPUTED',
  'COMPLETED',
] as const satisfies readonly DuelStatus[];

/**
 * Для пометок администратора считаются все встречи пары, которые были или
 * будут сыграны, — и неподтверждённые тоже: частая пара видна и без счёта.
 */
export const FLAG_STATUSES = [
  ...RATING_HOLD_STATUSES,
  'UNCONFIRMED',
] as const satisfies readonly DuelStatus[];

/** Где ещё не решено, кто и когда играет: тут можно откликаться и отказывать. */
export const SEEKING_STATUSES = ['OPEN', 'CHALLENGE'] as const satisfies readonly DuelStatus[];

/** Отказ «не к этому состоянию». */
export function invalidState(status: string, details: Record<string, unknown> = {}): AppError {
  return new AppError(ERROR_CODES.DUEL_INVALID_STATE, 'Action does not fit the duel status', {
    ...details,
    status,
  });
}

/**
 * Вариант времени: начинается в будущем и не дальше `DUEL_HORIZON_DAYS`.
 * Длину окна проверила схема (`duelSlotInputSchema`).
 */
export function assertSlotTime(startsAt: Date, now: Date, index?: number): void {
  const start = startsAt.getTime();
  const horizon = now.getTime() + DUEL_HORIZON_DAYS * DAY_MS;

  if (start <= now.getTime() || start > horizon) {
    throw new AppError(ERROR_CODES.DUEL_TIME_INVALID, 'Slot is in the past or too far ahead', {
      startsAt: startsAt.toISOString(),
      horizonDays: DUEL_HORIZON_DAYS,
      ...(index === undefined ? {} : { index }),
    });
  }
}

/**
 * Счёт по формату дуэли: победитель — один из двоих, у него ровно
 * `setsToWin(bestOf)` партий, у проигравшего меньше.
 */
export function assertScore(
  bestOf: DuelBestOf,
  input: ReportDuelInput,
  participants: readonly [string, string],
): void {
  const need = setsToWin(bestOf);
  const valid =
    participants.includes(input.winnerId) &&
    input.winnerSets === need &&
    input.loserSets >= 0 &&
    input.loserSets < need;

  if (!valid) {
    throw new AppError(ERROR_CODES.DUEL_SCORE_INVALID, 'Score does not fit the match format', {
      setsToWin: need,
    });
  }
}

/** Рейтинговая дуэль пары — для пометок администратора. */
export interface PairDuel {
  readonly id: string;
  readonly authorId: string;
  readonly opponentId: string | null;
  readonly at: Date;
  readonly winnerId: string | null;
}

/** Начисление победителю по дуэли — для `BIG_GAIN`. */
export interface DuelGain {
  readonly playerId: string;
  readonly at: Date;
  readonly delta: number;
}

export interface FlagSubject {
  readonly id: string;
  readonly authorId: string;
  readonly opponentId: string | null;
  readonly at: Date;
  readonly winnerId: string | null;
  /** Провизорный в момент начисления; до начисления — текущий признак. */
  readonly provisional: boolean;
}

/**
 * Пометки рейтинговой дуэли — `DuelFlag`, ADR-065 §6.
 *
 * Окно — 30 дней, которые кончаются этой дуэлью: так старая дуэль в
 * очереди показывает то, что было видно тогда, а свежая — последний месяц
 * пары. Сама дуэль в счёт пары входит всегда («эта тоже»).
 */
export function duelFlags(
  subject: FlagSubject,
  pairDuels: readonly PairDuel[],
  gains: readonly DuelGain[],
): { flags: DuelFlag[]; pairCount: number } {
  const flags: DuelFlag[] = [];

  if (subject.opponentId === null) {
    return { flags: subject.provisional ? ['PROVISIONAL'] : [], pairCount: 0 };
  }

  const from = subject.at.getTime() - DUEL_FLAG_WINDOW_DAYS * DAY_MS;
  const to = subject.at.getTime();
  const inWindow = (at: Date): boolean => at.getTime() > from && at.getTime() <= to;
  const pair = new Set([subject.authorId, subject.opponentId]);
  const window = [
    subject,
    ...pairDuels.filter(
      (duel) =>
        duel.id !== subject.id &&
        duel.opponentId !== null &&
        pair.has(duel.authorId) &&
        pair.has(duel.opponentId) &&
        duel.authorId !== duel.opponentId &&
        inWindow(duel.at),
    ),
  ];
  const pairCount = window.length;

  if (pairCount >= DUEL_FLAG_PAIR_COUNT) flags.push('PAIR_FREQUENT');

  const winners = window.flatMap((duel) => (duel.winnerId === null ? [] : [duel.winnerId]));

  if (winners.length >= DUEL_FLAG_PAIR_COUNT && new Set(winners).size === 1) {
    flags.push('ONE_SIDED');
  }

  if (subject.provisional) flags.push('PROVISIONAL');

  if (subject.winnerId !== null) {
    const gained = gains
      .filter((gain) => gain.playerId === subject.winnerId && inWindow(gain.at))
      .reduce((sum, gain) => sum + gain.delta, 0);

    if (gained >= DUEL_FLAG_BIG_GAIN) flags.push('BIG_GAIN');
  }

  return { flags, pairCount };
}
