import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { CLUB_IMAGE_WIDTHS, type ClubImageWidth } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

/**
 * Предел пикселей на входе — защита от «бомбы распаковки»: PNG в сотню
 * килобайт, который разворачивается в гигабайты памяти. Сорок мегапикселей
 * — больше любого снимка с телефона.
 */
export const IMAGE_MAX_INPUT_PIXELS = 40_000_000;

/** Качество WebP: на фото зала разницы с исходником не видно, а вес — в разы меньше. */
const WEBP_QUALITY = 80;

export interface ProcessedImage {
  readonly width: number;
  readonly height: number;
  /** Варианты по ширине; самый широкий — основной файл. */
  readonly variants: ReadonlyMap<ClubImageWidth, Buffer>;
}

/**
 * Обработка картинок клуба — ADR-055, `docs/09` 6.
 *
 * Поворот по EXIF, затем EXIF выбрасывается целиком: в снимке с телефона
 * лежат координаты места съёмки, а это персональные данные того, кто снимал.
 * `sharp` метаданные не переносит, пока его об этом не попросить.
 */
@Injectable()
export class ImageService {
  /**
   * Обложка ролика YouTube. Мелкая обложка `hqdefault` — 4:3 с чёрными
   * полосами сверху и снизу у обычного широкого ролика: полосы срезаются
   * до 16:9, иначе в галерее у видео рамка, которой нет у фото.
   */
  async processVideoCover(input: Buffer, letterboxed: boolean): Promise<ProcessedImage> {
    if (!letterboxed) return this.process(input);

    const { width, height } = await sharp(input).metadata();
    const height16x9 = Math.round((width * 9) / 16);

    if (height16x9 >= height) return this.process(input);

    const cropped = await sharp(input)
      .extract({ left: 0, top: Math.round((height - height16x9) / 2), width, height: height16x9 })
      .toBuffer();

    return this.process(cropped);
  }

  async process(input: Buffer): Promise<ProcessedImage> {
    const source = sharp(input, { limitInputPixels: IMAGE_MAX_INPUT_PIXELS, failOn: 'error' });

    try {
      const variants = new Map<ClubImageWidth, Buffer>();
      let size = { width: 0, height: 0 };

      for (const width of CLUB_IMAGE_WIDTHS) {
        const { data, info } = await source
          .clone()
          .rotate()
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer({ resolveWithObject: true });

        variants.set(width, data);
        size = { width: info.width, height: info.height };
      }

      return { ...size, variants };
    } catch {
      // Битый файл или превышен предел пикселей — для человека это одно:
      // «эту картинку не принять».
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Image cannot be processed', {
        field: 'file',
        reason: 'DECODE',
      });
    }
  }
}
