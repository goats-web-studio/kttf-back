import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ImageService } from './image.service.js';

/**
 * Обработка картинок клуба — ADR-055. Настоящий `sharp`, без заглушек:
 * проверяется именно то, ради чего он взят, — метаданные уходят, размеры
 * сжимаются, битый файл не роняет запрос.
 */

const service = new ImageService();

async function phoneShot(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c33' } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'место съёмки' } } })
    .toBuffer();
}

describe('картинка клуба', () => {
  it('три ширины WebP, основной — не шире 1600', async () => {
    const result = await service.process(await phoneShot(4000, 3000));

    expect([...result.variants.keys()]).toEqual([480, 960, 1600]);
    expect(result).toMatchObject({ width: 1600, height: 1200 });

    const small = await sharp(result.variants.get(480)).metadata();
    expect(small).toMatchObject({ format: 'webp', width: 480, height: 360 });
  });

  it('метаданные снимка выбрасываются', async () => {
    const result = await service.process(await phoneShot(1200, 800));
    const meta = await sharp(result.variants.get(1600)).metadata();

    expect(meta.exif).toBeUndefined();
  });

  it('маленькая картинка не растягивается', async () => {
    const result = await service.process(await phoneShot(300, 300));

    expect(result).toMatchObject({ width: 300, height: 300 });
  });

  it('битый файл — отказ проверки, а не падение', async () => {
    await expect(service.process(Buffer.from('not an image'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'DECODE' },
    });
  });
});
