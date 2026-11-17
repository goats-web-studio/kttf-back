/**
 * Удалённый игрок — ADR-092.
 *
 * Аккаунт удалён, а спортивная история осталась: имя в базе — пустые строки,
 * `Player.deletedAt` заполнен. В ответах — флаг `deleted`, подпись «Удалённый
 * игрок» клиент пишет на языке интерфейса.
 */

/**
 * Подпись для заголовков тем форума: они хранятся строкой и пишутся
 * по-русски (ADR-068), перевести их на клиенте нельзя.
 */
export const DELETED_PLAYER_TITLE_RU = 'Удалённый игрок';

/** Фильтр Prisma: только живые игроки. */
export const LIVE_PLAYER = { deletedAt: null } as const;

/** Удалён ли игрок. Prisma отдаёт `Date` или `null`; иное — живой. */
export function isDeletedPlayer(row: { deletedAt?: Date | null }): boolean {
  return row.deletedAt instanceof Date;
}
