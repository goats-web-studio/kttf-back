import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PHOTO_MAX_BYTES } from '@kttf/shared/types';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { TokenService } from '../src/features/auth/token.service.js';
import { FilesModule } from '../src/features/files/files.module.js';
import { StorageService } from '../src/features/files/storage.service.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Загрузка фото игрока по HTTP — ADR-036, ADR-129.
 *
 * Настоящие multer (через `FileInterceptor`) и sharp: юнит-тесты контроллера
 * подменяют оба, и сломанный разбор multipart после обновления библиотек
 * они бы не заметили. Подменено только хранилище.
 */

const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
};

const stored = new Map<string, { body: Buffer; contentType: string }>();

let app: INestApplication | undefined;
let base: string;
let token: string;

beforeEach(async () => {
  stored.clear();

  const storage = {
    putAt: vi.fn((key: string, body: Buffer, contentType: string) => {
      stored.set(key, { body, contentType });
      return Promise.resolve();
    }),
    onModuleInit: vi.fn(),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, FilesModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    // Отметка «был на сайте» (ADR-047) — единственное, что здесь пишет в базу.
    .useValue({ user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })
    .overrideProvider(StorageService)
    .useValue(storage)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  base = `${await app.getUrl()}/api/v1/files`;
  token = app.get(TokenService).issueAccessToken('user-1');
});

afterEach(async () => {
  await app?.close();
});

async function upload(file: Blob, withToken = true) {
  const form = new FormData();
  form.append('file', file, 'photo.jpg');

  const response = await fetch(`${base}/player-photo`, {
    method: 'POST',
    headers: withToken ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Снимок «с телефона»: JPEG с EXIF, где есть координаты места съёмки. */
async function phoneShot(): Promise<Blob> {
  const jpeg = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: '#36c' },
  })
    .jpeg()
    .withMetadata({
      exif: {
        IFD0: { Make: 'Телефон' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 7/1 0/1' },
      },
    })
    .toBuffer();

  return new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' });
}

describe('POST /files/player-photo', () => {
  it('фото с телефона принимается одним WebP без EXIF', async () => {
    const result = await upload(await phoneShot());

    expect(result.status).toBe(201);
    expect(result.body.url).toMatch(/^\/api\/v1\/files\/players\/[0-9a-f-]{36}\.webp$/);

    expect(stored.size).toBe(1);
    const [key, file] = [...stored][0] ?? [];
    expect(key).toBe(String(result.body.url).replace('/api/v1/files/', ''));
    expect(file?.contentType).toBe('image/webp');

    const meta = await sharp(file?.body).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(1200);
  });

  it('не картинка под видом JPEG — 400 с причиной DECODE, в хранилище ничего', async () => {
    const result = await upload(new Blob(['это не картинка'], { type: 'image/jpeg' }));

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { details: { reason: 'DECODE' } } });
    expect(stored.size).toBe(0);
  });

  it('файл больше предела отвергается multer до обработки', async () => {
    const result = await upload(
      new Blob([new Uint8Array(PHOTO_MAX_BYTES + 1)], { type: 'image/jpeg' }),
    );

    expect(result.status).toBe(413);
    expect(stored.size).toBe(0);
  });

  it('без входа — 401, файл не читается', async () => {
    const result = await upload(await phoneShot(), false);

    expect(result.status).toBe(401);
    expect(stored.size).toBe(0);
  });
});
