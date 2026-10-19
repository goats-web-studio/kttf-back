import { randomUUID } from 'node:crypto';

import type { UploadedImage } from '@kttf/shared/types';

import type { ProcessedImage } from './image.service.js';
import type { StorageService } from './storage.service.js';

/**
 * Кладёт обработанную картинку клуба: основной файл — самая широкая, рядом
 * варианты с суффиксом ширины (`clubs/<uuid>-480.webp`). Логотип, обложка,
 * фото галереи и обложка видео лежат одинаково — ADR-055.
 */
export async function storeClubImage(
  storage: StorageService,
  image: ProcessedImage,
): Promise<UploadedImage> {
  const id = randomUUID();

  await Promise.all(
    [...image.variants].map(([width, body]) =>
      storage.putAt(
        width === 1600 ? `clubs/${id}.webp` : `clubs/${id}-${String(width)}.webp`,
        body,
        'image/webp',
      ),
    ),
  );

  return { url: `/api/v1/files/clubs/${id}.webp`, width: image.width, height: image.height };
}
