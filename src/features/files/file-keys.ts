import { CATALOG_IMAGE_WIDTHS, CLUB_IMAGE_WIDTHS } from '@kttf/shared/types';

/**
 * Ключи хранилища по адресу файла — ADR-092, удаление аккаунта.
 *
 * Адрес в базе — `/api/v1/files/<папка>/<имя>`. Фото игрока и скан документа
 * тренера лежат одним файлом. Картинки, пережатые сервером, — основной файл
 * и варианты `<id>-<ширина>.webp` рядом (`club-image.ts`). Ширины берутся
 * все известные: лишний ключ при удалении безвреден, забытый — нет.
 */
const FILE_URL = /^\/api\/v1\/files\/([a-z-]+)\/([A-Za-z0-9-]+)\.([a-z]+)$/;

const SINGLE_FILE_FOLDERS = new Set(['players', 'coach-docs']);
const IMAGE_FOLDERS = new Set(['clubs', 'coaches', 'forum', 'products', 'brands']);
const WIDTHS = [...new Set<number>([...CLUB_IMAGE_WIDTHS, ...CATALOG_IMAGE_WIDTHS])];

export function fileKeysOf(url: string | null | undefined): string[] {
  if (url === null || url === undefined) return [];

  const match = FILE_URL.exec(url);
  if (match === null) return [];

  const [, folder = '', name = '', extension = ''] = match;
  const main = `${folder}/${name}.${extension}`;

  if (SINGLE_FILE_FOLDERS.has(folder)) return [main];
  if (!IMAGE_FOLDERS.has(folder)) return [];

  return [main, ...WIDTHS.map((width) => `${folder}/${name}-${String(width)}.webp`)];
}
