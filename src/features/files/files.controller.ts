import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { PHOTO_MAX_BYTES, rejectPhoto, type UploadedFile } from '@kttf/shared/types';
import {
  Controller,
  Get,
  Header,
  Param,
  Post,
  Res,
  UploadedFile as UploadedFileParam,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { StorageService } from './storage.service.js';

/** Пришедший файл. Структурно, чтобы не тянуть типы multer ради четырёх полей. */
interface IncomingFile {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly size: number;
}

/** Расширение по типу: имя файла от клиента в ключ не попадает — это путь. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Ключ файла: `<папка>/<uuid>.<расширение>`.
 *
 * Проверяется схемой, потому что приходит из пути запроса: без ограничения
 * `../` в ключе — это чтение чужого бакета.
 */
const fileKeyParam = z.string().regex(/^[a-z-]+\/[0-9a-f-]{36}\.[a-z]{3,4}$/);

/**
 * Файлы — ТС 7.8, ADR-036.
 *
 * Загрузка под входом: класть файлы в хранилище вправе тот, кто вошёл.
 * Чтение открыто, как и остальное чтение продукта: фото игрока видно на
 * публичной странице, и требовать токен ради аватара значило бы закрыть
 * публичную часть.
 */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  /**
   * Фото игрока — ТЗ 2.2.
   *
   * Правило приёма — общая функция `rejectPhoto`: форма отказывает ровно
   * тому файлу, которому откажет сервер (ADR-029). Здесь оно всё равно
   * проверяется: форма — это удобство, а не защита.
   */
  @Post('player-photo')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      // Потолок и здесь: без него multer примет гигабайт в память прежде,
      // чем до проверки дойдёт очередь.
      limits: { fileSize: PHOTO_MAX_BYTES },
    }),
  )
  async uploadPlayerPhoto(@UploadedFileParam() file?: IncomingFile): Promise<UploadedFile> {
    if (file === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is missing', { field: 'file' });
    }

    const rejection = rejectPhoto({ type: file.mimetype, size: file.size });

    if (rejection !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is not accepted', {
        field: 'file',
        reason: rejection,
      });
    }

    const extension = EXTENSIONS[file.mimetype] ?? 'bin';
    const key = await this.storage.put('players', file.buffer, file.mimetype, extension);

    return { url: `/api/v1/files/${key}` };
  }

  /**
   * Отдача файла.
   *
   * Через API, а не прямой ссылкой в MinIO: наружу открыт один прокси, и
   * второй порт ради аватаров — это вторая точка входа, которую нужно
   * закрывать и наблюдать.
   */
  @Get(':folder/:name')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  async download(
    @Param('folder') folder: string,
    @Param('name') name: string,
    @Res() response: Response,
  ): Promise<void> {
    const key = new ZodValidationPipe(fileKeyParam).transform(`${folder}/${name}`);
    const file = await this.storage.get(key);

    // Имя в ключе — случайный UUID, поэтому содержимое неизменно: год
    // хранения в кэше безопасен и снимает повторные запросы за аватаром.
    response.type(file.contentType).send(file.body);
  }
}
