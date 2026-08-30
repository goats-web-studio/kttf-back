import {
  buildKnockout,
  scheduleRoundRobin,
  splitIntoGroups,
  type AdvancingSelection,
  type KnockoutOptions,
  type ParticipantId,
} from '@kttf/shared/brackets';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type {
  BracketSourceView,
  ClubCollisionView,
  FormatConfig,
  SeedingConfig,
  StageType,
} from '@kttf/shared/types';

/**
 * Жеребьёвка — ТЗ 5.3.
 *
 * Чистая функция: получает участников и конфигурацию, возвращает план этапов,
 * групп и встреч. Ни базы, ни Prisma здесь нет, поэтому расстановку можно
 * проверить тестами целиком, а не через двадцать интеграционных сценариев.
 *
 * Сами схемы строит движок из общего кода. Здесь только раскладка его вывода
 * по моделям: дублировать логику сеток в приложении запрещено (запрет №2).
 */

export interface DrawParticipant {
  readonly playerId: string;
  readonly rating: number;
  readonly clubId: string | null;
  /** Ручной посев, если организатор его расставил. */
  readonly seed: number | null;
}

export interface PlannedMatch {
  readonly id: string;
  /** Ключ группы из `PlannedGroup.key`, либо `null` для сетки. */
  readonly groupKey: string | null;
  readonly playerAId: string | null;
  readonly playerBId: string | null;
  readonly sourceA: BracketSourceView | null;
  readonly sourceB: BracketSourceView | null;
  /** Тур круговой схемы либо круг сетки. */
  readonly bracketRound: number | null;
  readonly bracketSlot: number | null;
}

export interface PlannedGroup {
  readonly key: string;
  readonly label: string;
  readonly order: number;
  readonly participants: readonly string[];
}

export interface PlannedStage {
  readonly order: number;
  readonly type: StageType;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly groups: readonly PlannedGroup[];
  readonly matches: readonly PlannedMatch[];
}

export interface DrawPlan {
  readonly stages: readonly PlannedStage[];
  readonly clubCollisions: readonly ClubCollisionView[];
}

/**
 * Порядок посева — ТЗ 5.2.
 *
 * `RANDOM` порядок не меняет: перемешивание вносит случайность, а функция
 * обязана оставаться чистой и повторяемой. Перемешивает вызывающий, до входа
 * сюда, и тогда результат жеребьёвки воспроизводится по той же входной
 * последовательности.
 */
export function seedParticipants(
  participants: readonly DrawParticipant[],
  seeding: SeedingConfig | null,
): DrawParticipant[] {
  const method = seeding?.method ?? 'RATING';

  if (method === 'RANDOM') return [...participants];

  if (method === 'MANUAL') {
    // Расставленные организатором идут первыми в его порядке, остальные —
    // по рейтингу следом. Иначе половина сетки зависела бы от порядка выборки.
    return [...participants].sort((left, right) => {
      if (left.seed !== null && right.seed !== null) return left.seed - right.seed;
      if (left.seed !== null) return -1;
      if (right.seed !== null) return 1;
      return byRating(left, right);
    });
  }

  return [...participants].sort(byRating);
}

function byRating(left: DrawParticipant, right: DrawParticipant): number {
  // При равных рейтингах порядок задаёт идентификатор: жеребьёвка обязана
  // быть воспроизводимой, а порядок выборки из базы таковым не является.
  return right.rating - left.rating || left.playerId.localeCompare(right.playerId);
}

/**
 * План жеребьёвки.
 *
 * @param makeId Генератор идентификаторов встреч. Передаётся снаружи, чтобы
 *   функция оставалась чистой и проверяемой.
 */
export function planDraw(
  config: FormatConfig,
  participants: readonly DrawParticipant[],
  seeding: SeedingConfig | null,
  makeId: () => string,
): DrawPlan {
  const seeded = seedParticipants(participants, seeding);

  if (seeded.length < 2) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'At least two participants are required', {
      participants: seeded.length,
    });
  }

  switch (config.type) {
    case 'ROUND_ROBIN':
      return planRoundRobin(config, seeded, makeId);
    case 'KNOCKOUT':
      return planKnockout(config, seeded, makeId);
    default:
      return planGroupStage(config, seeded, seeding, makeId);
  }
}

function planRoundRobin(
  config: Extract<FormatConfig, { type: 'ROUND_ROBIN' }>,
  seeded: readonly DrawParticipant[],
  makeId: () => string,
): DrawPlan {
  const ids = seeded.map((participant) => participant.playerId);
  // Группа здесь одна и формально не нужна, но без неё решению судьи
  // по равенству очков негде храниться: TieDecision привязан к группе.
  const group: PlannedGroup = { key: 'main', label: 'Круговая', order: 0, participants: ids };

  const matches = scheduleRoundRobin(ids, config.rounds).map((match) => ({
    id: makeId(),
    groupKey: group.key,
    playerAId: match.a,
    playerBId: match.b,
    sourceA: null,
    sourceB: null,
    bracketRound: match.round,
    bracketSlot: null,
  }));

  return {
    stages: [
      {
        order: 0,
        type: 'ROUND_ROBIN',
        name: 'Круговая',
        config: { rounds: config.rounds, setsToWin: config.setsToWin },
        groups: [group],
        matches,
      },
    ],
    clubCollisions: [],
  };
}

function planKnockout(
  config: Extract<FormatConfig, { type: 'KNOCKOUT' }>,
  seeded: readonly DrawParticipant[],
  makeId: () => string,
): DrawPlan {
  if (config.consolation) {
    // Утешительная сетка для проигравших в первом круге — ТЗ 5.1. Движок её
    // не строит, а собирать сетку в приложении запрещено запретом №2:
    // офлайн-консоль должна получить ту же сетку тем же кодом.
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Consolation bracket is not supported yet', {
      format: config.type,
    });
  }

  return {
    stages: [
      planKnockoutStage(
        seeded.map((participant) => participant.playerId),
        { thirdPlace: config.thirdPlace },
        { order: 0, name: 'Олимпийская сетка', setsToWin: config.setsToWin },
        makeId,
      ),
    ],
    clubCollisions: [],
  };
}

/**
 * Этап-сетка из уже посеянного списка.
 *
 * Общий для олимпийки с жеребьёвки и для плей-офф, который достраивается по
 * итогам групп: сетка та же самая, отличается только откуда взялся посев.
 */
function planKnockoutStage(
  participants: readonly ParticipantId[],
  options: KnockoutOptions,
  stage: { order: number; name: string; setsToWin: number },
  makeId: () => string,
): PlannedStage {
  const bracket = buildKnockout(participants, options);

  // Движок ссылается на встречи своими идентификаторами вида «R2M0».
  // База ссылается на них же по первичному ключу, поэтому ключи выдаются
  // заранее и перевод делается по карте.
  const ids = new Map(bracket.matches.map((match) => [match.id, makeId()]));

  return {
    order: stage.order,
    type: 'KNOCKOUT',
    name: stage.name,
    config: {
      setsToWin: stage.setsToWin,
      thirdPlace: options.thirdPlace ?? false,
      bracketSize: bracket.bracketSize,
      byes: bracket.byes,
    },
    groups: [],
    matches: bracket.matches.map((match) => ({
      id: mustGet(ids, match.id),
      groupKey: null,
      playerAId: participantOf(match.a),
      playerBId: participantOf(match.b),
      sourceA: sourceOf(match.a, ids),
      sourceB: sourceOf(match.b, ids),
      bracketRound: match.round,
      bracketSlot: match.slot,
    })),
  };
}

/**
 * Групповой этап схем «группы + сетка» и «группы + финальные группы».
 *
 * Строится только он. Плей-офф и финальные группы посеваются результатами
 * групп, которых до первой сыгранной встречи не существует, — эти этапы
 * появляются, когда групповой этап завершён.
 */
function planGroupStage(
  config: Extract<FormatConfig, { type: 'GROUPS_KNOCKOUT' | 'GROUPS_FINAL_GROUPS' }>,
  seeded: readonly DrawParticipant[],
  seeding: SeedingConfig | null,
  makeId: () => string,
): DrawPlan {
  const split = splitIntoGroups(
    seeded.map((participant) => ({
      participant: participant.playerId,
      ...(participant.clubId === null ? {} : { club: participant.clubId }),
    })),
    {
      ...(config.groupCount === undefined ? {} : { groupCount: config.groupCount }),
      ...(config.groupSize === undefined ? {} : { groupSize: config.groupSize }),
      separateByClub: seeding?.separateByClub ?? true,
    },
  );

  const setsToWin = config.type === 'GROUPS_KNOCKOUT' ? config.groupSetsToWin : config.setsToWin;

  const groups = split.groups.map((group, order) => ({
    key: group.label,
    label: group.label,
    order,
    participants: group.participants,
  }));

  // Сколько человек дойдёт до следующего этапа, видно уже здесь: группа
  // меньше зоны выхода отдаёт всех, кто в ней есть. Проверка стоит на
  // жеребьёвке, а не на достройке, потому что достройка случается посреди
  // турнира при вводе счёта — отказывать судье там поздно и не за что.
  const advancing = groups.reduce(
    (total, group) => total + Math.min(group.participants.length, config.advancePerGroup),
    0,
  );

  if (advancing < 2) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Too few participants advance from groups', {
      advancing,
      advancePerGroup: config.advancePerGroup,
      groups: groups.length,
    });
  }

  const matches = groups.flatMap((group) =>
    scheduleRoundRobin(group.participants, 1).map((match) => ({
      id: makeId(),
      groupKey: group.key,
      playerAId: match.a,
      playerBId: match.b,
      sourceA: null,
      sourceB: null,
      bracketRound: match.round,
      bracketSlot: null,
    })),
  );

  return {
    stages: [
      {
        order: 0,
        type: 'GROUPS',
        name: 'Групповой этап',
        config: { setsToWin, advancePerGroup: config.advancePerGroup },
        groups,
        matches,
      },
    ],
    clubCollisions: split.clubCollisions.map((collision) => ({
      club: collision.club,
      group: collision.group,
      participants: [...collision.participants],
    })),
  };
}

function participantOf(source: { kind: string; participant?: string }): string | null {
  return source.kind === 'PARTICIPANT' ? (source.participant ?? null) : null;
}

function sourceOf(
  source: { kind: string; matchId?: string },
  ids: Map<string, string>,
): BracketSourceView | null {
  if (source.kind !== 'WINNER' && source.kind !== 'LOSER') return null;
  if (source.matchId === undefined) return null;

  return { kind: source.kind, matchId: mustGet(ids, source.matchId) };
}

function mustGet(ids: Map<string, string>, key: string): string {
  const value = ids.get(key);

  if (value === undefined) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Bracket references an unknown match', { key });
  }

  return value;
}

/**
 * Этап по итогам групп — плей-офф либо финальные группы.
 *
 * Его не существовало при жеребьёвке: он сеется результатами групп, а до
 * первой сыгранной встречи результатов нет. Отбор вышедших делает движок
 * (`selectAdvancing`), здесь только раскладка по моделям — та же граница,
 * что и во всей остальной жеребьёвке.
 *
 * @returns `null`, если схема турнира следующего этапа не предполагает.
 */
export function planNextStage(
  config: FormatConfig,
  selection: AdvancingSelection,
  makeId: () => string,
): PlannedStage | null {
  if (config.type === 'GROUPS_KNOCKOUT') {
    return planKnockoutStage(
      selection.seeded,
      { thirdPlace: config.thirdPlace },
      { order: 1, name: 'Плей-офф', setsToWin: config.koSetsToWin },
      makeId,
    );
  }

  if (config.type === 'GROUPS_FINAL_GROUPS') {
    return planFinalGroups(config, selection, makeId);
  }

  return null;
}

/**
 * Финальные группы — ТЗ 5.1, «финалы по местам».
 *
 * k-я группа собирает тех, кто занял k-е место в своей группе: победители
 * играют за первые места, вторые номера — за следующие. Число финальных групп
 * совпадает с числом выходящих — это закреплено схемой конфигурации.
 */
function planFinalGroups(
  config: Extract<FormatConfig, { type: 'GROUPS_FINAL_GROUPS' }>,
  selection: AdvancingSelection,
  makeId: () => string,
): PlannedStage {
  const groups = selection.byPlace.map((participants, index) => ({
    key: `final-${String(index + 1)}`,
    label: `Финальная гр. ${String(index + 1)}`,
    order: index,
    participants,
  }));

  const matches = groups.flatMap((group) =>
    scheduleRoundRobin(group.participants, 1).map((match) => ({
      id: makeId(),
      groupKey: group.key,
      playerAId: match.a,
      playerBId: match.b,
      sourceA: null,
      sourceB: null,
      bracketRound: match.round,
      bracketSlot: null,
    })),
  );

  return {
    order: 1,
    type: 'GROUPS',
    name: 'Финальные группы',
    config: { setsToWin: config.setsToWin },
    groups,
    matches,
  };
}
