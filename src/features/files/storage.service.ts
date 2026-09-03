import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ENV, type Env } from '../../infra/config/env.js';

/**
 * Хранилище файлов — ТС 7.8, ADR-036.
 *
 * Файл идёт через API, а не предподписанной ссылкой прямо в MinIO. Ссылка
 * несёт в подписи имя хоста, а хост у хранилища внутри сети (`kttf-minio`) и
 * снаружи (`https://домен`) разный: браузеру пришлось бы ходить в MinIO мимо
 * прокси, то есть открывать его наружу отдельным портом. Через API это одна
 * точка входа, одна проверка прав и одно правило на тип и размер файла.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client =
      this.env.S3_ACCESS_KEY === undefined || this.env.S3_SECRET_KEY === undefined
        ? null
        : new S3Client({
            endpoint: this.env.S3_ENDPOINT,
            region: this.env.S3_REGION,
            // MinIO адресует бакет путём, а не поддоменом: `kttf-media.minio`
            // в локальной сети не разрешается ничем.
            forcePathStyle: true,
            credentials: {
              accessKeyId: this.env.S3_ACCESS_KEY,
              secretAccessKey: this.env.S3_SECRET_KEY,
            },
          });
  }

  /**
   * Бакет заводится при старте, а не при первой загрузке.
   *
   * Иначе первый же человек, загружающий фото, ждёт создание бакета, а при
   * двух копиях приложения два запроса создают его наперегонки.
   */
  async onModuleInit(): Promise<void> {
    if (this.client === null) {
      this.logger.warn('Ключи хранилища не заданы: загрузка файлов отключена');

      return;
    }

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.env.S3_BUCKET }));
        this.logger.log(`Бакет ${this.env.S3_BUCKET} создан`);
      } catch (error) {
        // Не падаем: хранилище может подняться позже, а без него работает
        // всё, кроме загрузки фото.
        this.logger.error(`Бакет ${this.env.S3_BUCKET} недоступен`, error);
      }
    }
  }

  /** Кладёт файл и отдаёт его ключ. Имя выдаётся своё: чужое имя файла — это путь. */
  async put(prefix: string, body: Buffer, contentType: string, extension: string): Promise<string> {
    const client = this.required();
    const key = `${prefix}/${randomUUID()}.${extension}`;

    await client.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    return key;
  }

  /** Читает файл целиком. Аватары мелкие, потоком отдавать нечего. */
  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const client = this.required();

    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
      );

      const body = await object.Body?.transformToByteArray();

      if (body === undefined) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'File not found', { key });
      }

      return {
        body: Buffer.from(body),
        contentType: object.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(ERROR_CODES.NOT_FOUND, 'File not found', { key });
    }
  }

  private required(): S3Client {
    if (this.client === null) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Storage is not configured');
    }

    return this.client;
  }
}
