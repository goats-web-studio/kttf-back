import { isAppError } from '@kttf/shared/errors';
import { PHOTO_MAX_BYTES } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesController } from './files.controller.js';
import type { StorageService } from './storage.service.js';

/**
 * Загрузка и отдача файлов — ТС 7.9, ADR-036.
 *
 * Правило приёма живёт в общем коде и проверено там. Здесь — то, что
 * принадлежит серверу: имя файла от клиента в ключ не попадает, а ключ из
 * пути запроса не выпускает за пределы своей папки.
 */

function makeStorage() {
  return {
    put: vi.fn().mockResolvedValue('players/11111111-1111-4111-8111-111111111111.jpg'),
    putAt: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ body: Buffer.from('x'), contentType: 'image/jpeg' }),
  };
}

const images = {
  processVideoCover: vi.fn(),
  process: vi.fn().mockResolvedValue({
    width: 1600,
    height: 900,
    variants: new Map([
      [480, Buffer.from('s')],
      [960, Buffer.from('m')],
      [1600, Buffer.from('l')],
    ]),
  }),
};

let storage: ReturnType<typeof makeStorage>;
let controller: FilesController;

beforeEach(() => {
  images.process.mockClear();
  storage = makeStorage();
  controller = new FilesController(storage as unknown as StorageService, images);
});

describe('загрузка фото', () => {
  const photo = { buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 100 };

  it('отдаёт путь, а не абсолютную ссылку', async () => {
    // Зашитый в базу https://localhost/... пережил бы переезд на боевой
    // домен ровно до первого открытия профиля.
    const result = await controller.uploadPlayerPhoto(photo);

    expect(result.url).toBe('/api/v1/files/players/11111111-1111-4111-8111-111111111111.jpg');
  });

  it('имя файла от клиента в ключ не попадает', async () => {
    // Чужое имя файла — это путь: «../../etc/passwd» тоже имя.
    await controller.uploadPlayerPhoto({ ...photo, originalname: '../../evil.jpg' } as never);

    expect(storage.put).toHaveBeenCalledWith('players', photo.buffer, 'image/jpeg', 'jpg');
  });

  it('пустой запрос — отказ, а не падение', async () => {
    await controller.uploadPlayerPhoto(undefined).then(
      () => expect.unreachable('ожидался отказ'),
      (error: unknown) => {
        expect(isAppError(error) && error.code).toBe('VALIDATION_FAILED');
      },
    );
  });

  it('чужой тип и слишком большой файл отвергаются с причиной', async () => {
    await controller.uploadPlayerPhoto({ ...photo, mimetype: 'image/svg+xml' }).then(
      () => expect.unreachable('ожидался отказ'),
      (error: unknown) => {
        expect(isAppError(error) && error.details).toMatchObject({ reason: 'TYPE' });
      },
    );

    await controller.uploadPlayerPhoto({ ...photo, size: PHOTO_MAX_BYTES + 1 }).then(
      () => expect.unreachable('ожидался отказ'),
      (error: unknown) => {
        expect(isAppError(error) && error.details).toMatchObject({ reason: 'SIZE' });
      },
    );

    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe('отдача файла', () => {
  const response = { type: vi.fn().mockReturnThis(), send: vi.fn() };

  it('ключ из пути ограничен своей папкой', async () => {
    // Иначе «../» в ключе — это чтение чужого бакета.
    await expect(
      controller.download('players', '../../secret.txt', response as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(storage.get).not.toHaveBeenCalled();
  });

  it('правильный ключ отдаётся с типом содержимого', async () => {
    await controller.download(
      'players',
      '11111111-1111-4111-8111-111111111111.jpg',
      response as never,
    );

    expect(storage.get).toHaveBeenCalledWith('players/11111111-1111-4111-8111-111111111111.jpg');
    expect(response.type).toHaveBeenCalledWith('image/jpeg');
  });
});

describe('картинка клуба', () => {
  const CLUB = '22222222-2222-4222-8222-222222222222';
  const image = { buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: PHOTO_MAX_BYTES + 1 };

  it('кладёт три ширины рядом и отдаёт путь основного файла с размерами', async () => {
    // Снимок с телефона больше потолка портрета, но в потолок клуба влезает.
    const result = await controller.uploadClubImage(CLUB, image);

    expect(result).toMatchObject({ width: 1600, height: 900 });
    expect(result.url).toMatch(/^\/api\/v1\/files\/clubs\/[0-9a-f-]{36}\.webp$/);

    const keys = storage.putAt.mock.calls.map((call) => call[0] as string).sort();
    const id = result.url.slice('/api/v1/files/clubs/'.length, -'.webp'.length);
    expect(keys).toEqual([`clubs/${id}-480.webp`, `clubs/${id}-960.webp`, `clubs/${id}.webp`]);
  });

  it('чужой тип отвергается до обработки', async () => {
    await expect(
      controller.uploadClubImage(CLUB, { ...image, mimetype: 'image/svg+xml' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'TYPE' } });
    expect(images.process).not.toHaveBeenCalled();
  });

  it('пустой запрос — отказ', async () => {
    await expect(controller.uploadClubImage(CLUB, undefined)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('картинки и сканы тренера (ADR-059)', () => {
  const COACH = '33333333-3333-4333-8333-333333333333';
  const image = { buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 100 };
  const response = { type: vi.fn().mockReturnThis(), send: vi.fn() };

  it('фото тренера кладётся тремя ширинами в свою папку', async () => {
    const result = await controller.uploadCoachImage(COACH, image);

    expect(result.url).toMatch(/^\/api\/v1\/files\/coaches\/[0-9a-f-]{36}\.webp$/);
    expect(storage.putAt).toHaveBeenCalledTimes(3);
  });

  it('скан — один WebP шириной до 1600, ответ — только путь', async () => {
    images.process.mockResolvedValueOnce({
      width: 1200,
      height: 1600,
      variants: new Map([[1600, Buffer.from('doc')]]),
    });

    const result = await controller.uploadCoachDoc(COACH, image);

    expect(images.process).toHaveBeenCalledWith(image.buffer, [1600]);
    expect(result).toEqual({
      url: expect.stringMatching(/^\/api\/v1\/files\/coach-docs\/[0-9a-f-]{36}\.webp$/) as unknown,
    });
    expect(storage.putAt).toHaveBeenCalledOnce();
    expect(storage.putAt.mock.calls[0]?.[0]).toMatch(/^coach-docs\/[0-9a-f-]{36}\.webp$/);
  });

  it('скан чужого типа отвергается до обработки', async () => {
    await expect(
      controller.uploadCoachDoc(COACH, { ...image, mimetype: 'application/pdf' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'TYPE' } });
    expect(images.process).not.toHaveBeenCalled();
  });

  it('общая выдача сканы не отдаёт — как будто файла нет', async () => {
    // Иначе непубличный скан открывался бы всем, кто знает путь.
    await expect(
      controller.download(
        'coach-docs',
        '11111111-1111-4111-8111-111111111111.webp',
        response as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(storage.get).not.toHaveBeenCalled();
  });

  it('фото тренера общая выдача отдаёт', async () => {
    await controller.download(
      'coaches',
      '11111111-1111-4111-8111-111111111111-480.webp',
      response as never,
    );

    expect(storage.get).toHaveBeenCalledWith(
      'coaches/11111111-1111-4111-8111-111111111111-480.webp',
    );
  });
});
