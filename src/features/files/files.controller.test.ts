import { isAppError } from '@kttf/shared/errors';
import { PHOTO_MAX_BYTES } from '@kttf/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesController } from './files.controller.js';
import type { StorageService } from './storage.service.js';

/**
 * Загрузка и отдача файлов — ТС 7.8, ADR-036.
 *
 * Правило приёма живёт в общем коде и проверено там. Здесь — то, что
 * принадлежит серверу: имя файла от клиента в ключ не попадает, а ключ из
 * пути запроса не выпускает за пределы своей папки.
 */

function makeStorage() {
  return {
    put: vi.fn().mockResolvedValue('players/11111111-1111-4111-8111-111111111111.jpg'),
    get: vi.fn().mockResolvedValue({ body: Buffer.from('x'), contentType: 'image/jpeg' }),
  };
}

let storage: ReturnType<typeof makeStorage>;
let controller: FilesController;

beforeEach(() => {
  storage = makeStorage();
  controller = new FilesController(storage as unknown as StorageService);
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
