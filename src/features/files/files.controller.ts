import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CLUB_IMAGE_MAX_BYTES,
  PHOTO_MAX_BYTES,
  rejectPhoto,
  type UploadedFile,
  type UploadedImage,
} from '@kttf/shared/types';
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
import { SkipRateLimit } from '../auth/rate-limit.interceptor.js';
import { RequireClubRole } from '../clubs/club-role.guard.js';
import { RequireCoachOwner } from '../coaches/coach-owner.guard.js';
import { storeClubImage, storeImage } from './club-image.js';
import { ImageService } from './image.service.js';
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
const fileKeyParam = z.string().regex(/^[a-z-]+\/[0-9a-f-]{36}(?:-\d{3,4})?\.[a-z]{3,4}$/);

const uuidParam = z.uuid();

/**
 * Сканы документов тренеров — персональные данные (ADR-059, риски). Общей
 * выдачей они не отдаются: только маршрутом документа, который сверяет,
 * кто смотрит, — `GET /coaches/:id/credentials/:credentialId/file`.
 */
export const COACH_DOCS_FOLDER = 'coach-docs';

/** Скан документа — один WebP: шире 1600 на нём ничего не прочитать лучше. */
const COACH_DOC_WIDTHS = [1600] as const;

/**
 * Файлы — ТС 7.9, ADR-036.
 *
 * Загрузка под входом: класть файлы в хранилище вправе тот, кто вошёл.
 * Чтение открыто, как и остальное чтение продукта: фото игрока видно на
 * публичной странице, и требовать токен ради аватара значило бы закрыть
 * публичную часть.
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly storage: StorageService,
    private readonly images: ImageService,
  ) {}

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
   * Логотип или обложка клуба — ADR-055.
   *
   * Загружает только состав клуба. Сервер пережимает картинку в WebP трёх
   * ширин и снимает метаданные (`ImageService`); основной файл — самый
   * широкий, варианты лежат рядом с суффиксом ширины. Сохранить путь в
   * клубе — отдельный `PATCH /clubs/:id`: загруженная, но не сохранённая
   * картинка страницу не меняет.
   */
  @Post('clubs/:id')
  @RequireClubRole('OWNER', 'ORGANIZER')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CLUB_IMAGE_MAX_BYTES } }))
  async uploadClubImage(
    @Param('id', new ZodValidationPipe(uuidParam)) _clubId: string,
    @UploadedFileParam() file?: IncomingFile,
  ): Promise<UploadedImage> {
    const accepted = acceptImage(file);

    return storeClubImage(this.storage, await this.images.process(accepted.buffer));
  }

  /**
   * Фото или обложка тренера — ADR-059, как картинка клуба: WebP трёх ширин,
   * метаданные сняты. Загружает владелец страницы или администратор;
   * сохранить путь на странице — отдельный `PATCH /coaches/:id`.
   */
  @Post('coaches/:id')
  @RequireCoachOwner()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CLUB_IMAGE_MAX_BYTES } }))
  async uploadCoachImage(
    @Param('id', new ZodValidationPipe(uuidParam)) _coachId: string,
    @UploadedFileParam() file?: IncomingFile,
  ): Promise<UploadedImage> {
    const accepted = acceptImage(file);

    return storeImage(this.storage, 'coaches', await this.images.process(accepted.buffer));
  }

  /**
   * Скан документа тренера — ADR-059. Только фото: сервер пережимает его в
   * один WebP и снимает EXIF (в снимке с телефона — координаты). Путь
   * записывается в документ через `PUT /coaches/:id/credentials`.
   */
  @Post('coach-docs/:id')
  @RequireCoachOwner()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CLUB_IMAGE_MAX_BYTES } }))
  async uploadCoachDoc(
    @Param('id', new ZodValidationPipe(uuidParam)) _coachId: string,
    @UploadedFileParam() file?: IncomingFile,
  ): Promise<UploadedFile> {
    const accepted = acceptImage(file);
    const image = await this.images.process(accepted.buffer, COACH_DOC_WIDTHS);
    const { url } = await storeImage(this.storage, COACH_DOCS_FOLDER, image);

    return { url };
  }

  /**
   * Фото в сообщение форума — ADR-064: как картинка клуба, WebP трёх ширин,
   * метаданные сняты. Загружает любой вошедший; в сообщение путь попадает
   * только через контракт (`FORUM_IMAGE_PATH_PATTERN`), а писать на форуме
   * проверяет сам форум.
   */
  @Post('forum')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CLUB_IMAGE_MAX_BYTES } }))
  async uploadForumImage(@UploadedFileParam() file?: IncomingFile): Promise<UploadedImage> {
    const accepted = acceptImage(file);

    return storeImage(this.storage, 'forum', await this.images.process(accepted.buffer));
  }

  /**
   * Отдача файла.
   *
   * Через API, а не прямой ссылкой в MinIO: наружу открыт один прокси, и
   * второй порт ради аватаров — это вторая точка входа, которую нужно
   * закрывать и наблюдать.
   */
  @Get(':folder/:name')
  // Картинки неизменяемы, а страница клуба тянет их десятками (ADR-056).
  @SkipRateLimit()
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  async download(
    @Param('folder') folder: string,
    @Param('name') name: string,
    @Res() response: Response,
  ): Promise<void> {
    const key = new ZodValidationPipe(fileKeyParam).transform(`${folder}/${name}`);

    // Отказ тот же, что для несуществующего файла: наличие скана не
    // подсказывается никому.
    if (key.startsWith(`${COACH_DOCS_FOLDER}/`)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'File not found', { key });
    }

    const file = await this.storage.get(key);

    // Имя в ключе — случайный UUID, поэтому содержимое неизменно: год
    // хранения в кэше безопасен и снимает повторные запросы за аватаром.
    response.type(file.contentType).send(file.body);
  }
}

/**
 * Картинка, которую сервер пережмёт: клуба, тренера, скан документа. Правило
 * приёма — общая `rejectPhoto` с потолком картинок клуба.
 */
function acceptImage(file: IncomingFile | undefined): IncomingFile {
  if (file === undefined) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is missing', { field: 'file' });
  }

  const rejection = rejectPhoto({ type: file.mimetype, size: file.size }, CLUB_IMAGE_MAX_BYTES);

  if (rejection !== null) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'File is not accepted', {
      field: 'file',
      reason: rejection,
    });
  }

  return file;
}
