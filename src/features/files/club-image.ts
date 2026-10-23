import { randomUUID } from 'node:crypto';

import type { UploadedImage } from '@kttf/shared/types';

import type { ProcessedImage } from './image.service.js';
import type { StorageService } from './storage.service.js';

/** Папки картинок, пережатых сервером: у каждой свой набор ширин. */
export type ImageFolder = 'clubs' | 'products' | 'brands' | 'coaches' | 'coach-docs' | 'forum';

/**
 * Кладёт обработанную картинку: основной файл — самая широкая, рядом
 * варианты с суффиксом ширины (`clubs/<uuid>-480.webp`). Логотип, обложка,
 * фото галереи и обложка видео клуба лежат одинаково — ADR-055; фото товара
 * и логотип производителя — так же, своими ширинами (ADR-058); фото и обложка
 * тренера — как у клуба, скан документа тренера — одним файлом (ADR-059);
 * фото в сообщении форума — как у клуба (ADR-064).
 */
export async function storeImage(
  storage: StorageService,
  folder: ImageFolder,
  image: ProcessedImage,
): Promise<UploadedImage> {
  const id = randomUUID();
  const main = Math.max(...image.variants.keys());

  await Promise.all(
    [...image.variants].map(([width, body]) =>
      storage.putAt(
        width === main ? `${folder}/${id}.webp` : `${folder}/${id}-${String(width)}.webp`,
        body,
        'image/webp',
      ),
    ),
  );

  return { url: `/api/v1/files/${folder}/${id}.webp`, width: image.width, height: image.height };
}

export async function storeClubImage(
  storage: StorageService,
  image: ProcessedImage,
): Promise<UploadedImage> {
  return storeImage(storage, 'clubs', image);
}
