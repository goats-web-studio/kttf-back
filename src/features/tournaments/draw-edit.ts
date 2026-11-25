import { AppError, ERROR_CODES } from '@kttf/shared/errors';

/**
 * Ручная правка групп — ADR-124.
 *
 * Турнир-менеджер RTTF даёт только «Поменять местами». Этого мало, когда
 * группы должны стать разного размера: пришло нечётное число, двоих
 * одноклубников надо развести, а лишнюю группу — расформировать. Здесь три
 * действия сверх обмена: перенести игрока, собрать новую группу из выбранных
 * и расформировать группу. Каждое возвращает новый состав затронутых групп —
 * встречи строит заново вызывающий, круговой схемой этапа.
 *
 * Состав группы в базе выводится из её встреч, поэтому группа из одного
 * невозможна: в ней нет встреч, и человек потерялся бы. В группе всегда не
 * меньше двух.
 */

export interface EditableGroup {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly participants: readonly string[];
}

export interface GroupEdit {
  /** Новый состав затронутых групп: id группы → участники. */
  readonly changed: ReadonlyMap<string, readonly string[]>;
  /** Участники новой группы, если она заводится. */
  readonly created?: readonly string[];
  /** Расформированная группа. */
  readonly removed?: string;
}

export const MIN_GROUP_SIZE = 2;

/** Перенести игрока в другую группу того же этапа. */
export function planMove(
  groups: readonly EditableGroup[],
  playerId: string,
  targetId: string,
): GroupEdit {
  const source = groupOf(groups, playerId);
  const target = groups.find((group) => group.id === targetId);

  if (target === undefined) {
    throw new AppError(ERROR_CODES.DRAW_POSITION_NOT_FOUND, 'Group is not in this stage', {
      groupId: targetId,
    });
  }

  if (target.id === source.id) {
    throw refusal('SAME_GROUP', { groupId: targetId });
  }

  const left = source.participants.filter((id) => id !== playerId);
  assertBigEnough(source, left);

  return {
    changed: new Map([
      [source.id, left],
      [target.id, [...target.participants, playerId]],
    ]),
  };
}

/** Новая группа из выбранных игроков. */
export function planNewGroup(
  groups: readonly EditableGroup[],
  playerIds: readonly string[],
): GroupEdit {
  if (playerIds.length < MIN_GROUP_SIZE) {
    throw refusal('GROUP_TOO_SMALL', { size: playerIds.length });
  }

  const picked = new Set(playerIds);
  const changed = new Map<string, readonly string[]>();

  for (const id of playerIds) groupOf(groups, id);

  for (const group of groups) {
    if (!group.participants.some((id) => picked.has(id))) continue;

    const left = group.participants.filter((id) => !picked.has(id));
    assertBigEnough(group, left);
    changed.set(group.id, left);
  }

  return { changed, created: [...playerIds] };
}

/**
 * Расформировать группу: её игроки по одному уходят в самую малую из
 * оставшихся (при равенстве — в первую по порядку), чтобы группы остались
 * ровными.
 */
export function planDisband(groups: readonly EditableGroup[], groupId: string): GroupEdit {
  const disbanded = groups.find((group) => group.id === groupId);

  if (disbanded === undefined) {
    throw new AppError(ERROR_CODES.DRAW_POSITION_NOT_FOUND, 'Group is not in this stage', {
      groupId,
    });
  }

  const rest = groups.filter((group) => group.id !== groupId);

  if (rest.length === 0) throw refusal('LAST_GROUP', { groupId });

  const members = new Map(rest.map((group) => [group.id, [...group.participants]]));
  const ordered = [...rest].sort((left, right) => left.order - right.order);

  const size = (group: EditableGroup): number => (members.get(group.id) ?? []).length;

  for (const participant of disbanded.participants) {
    const smallest = ordered.reduce((best, group) => (size(group) < size(best) ? group : best));
    members.get(smallest.id)?.push(participant);
  }

  const changed = new Map<string, readonly string[]>();
  for (const group of rest) {
    const next = members.get(group.id) ?? [];
    if (next.length !== group.participants.length) changed.set(group.id, next);
  }

  return { changed, removed: groupId };
}

function groupOf(groups: readonly EditableGroup[], playerId: string): EditableGroup {
  const found = groups.find((group) => group.participants.includes(playerId));

  if (found === undefined) {
    throw new AppError(ERROR_CODES.DRAW_POSITION_NOT_FOUND, 'Player is not in this stage', {
      playerId,
    });
  }

  return found;
}

function assertBigEnough(group: EditableGroup, left: readonly string[]): void {
  if (left.length < MIN_GROUP_SIZE) {
    throw refusal('GROUP_TOO_SMALL', { group: group.label, size: left.length });
  }
}

function refusal(reason: string, details: Record<string, unknown>): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, 'The group change is not possible', {
    ...details,
    reason,
  });
}
