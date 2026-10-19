import { CATALOG_IMAGE_MAX_BYTES } from '@kttf/shared/types';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../../infra/config/env.js';

/** Хост по умолчанию: каталог наполняется выгрузкой RTTF — `docs/10` 6. */
export const DEFAULT_IMPORT_HOSTS = ['rttf.ru'] as const;

/** Сколько ждать одно фото: пачка импорта — до пятидесяти строк с фото у каждой. */
const FETCH_TIMEOUT_MS = 15_000;

/** Тот же потолок, что у загрузки фото товара вручную. */
export const IMPORT_IMAGE_MAX_BYTES = CATALOG_IMAGE_MAX_BYTES;

/** Переадресаций больше не бывает у честного сервера картинок. */
const REDIRECTS_MAX = 3;

/**
 * Типы, которые `sharp` разбирает без внешних программ. SVG нет: это
 * документ со ссылками внутри, а не картинка.
 */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Причина, по которой фото не скачано, — пишется в итог строки импорта. */
export type ImageFetchFailure = 'HOST' | 'HTTP' | 'TYPE' | 'SIZE' | 'NETWORK';

export class ImageFetchError extends Error {
  constructor(readonly reason: ImageFetchFailure) {
    super(`Image fetch failed: ${reason}`);
  }
}

export function importHosts(env: Pick<Env, 'CATALOG_IMPORT_HOSTS'>): readonly string[] {
  return env.CATALOG_IMPORT_HOSTS === undefined
    ? DEFAULT_IMPORT_HOSTS
    : env.CATALOG_IMPORT_HOSTS.split(',');
}

/** Только https и только разрешённый хост или его поддомен: `img.rttf.ru` — да, `rttf.ru.evil` — нет. */
export function isAllowedImageUrl(url: URL, hosts: readonly string[]): boolean {
  const host = url.hostname.toLowerCase();

  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  );
}

/**
 * Скачивание фото для импорта каталога — ADR-058, `docs/10` 6.
 *
 * Ссылки приходят из файла импорта, поэтому сервер ходит только на
 * разрешённые хосты (`CATALOG_IMPORT_HOSTS`): иначе импорт стал бы способом
 * заставить API запросить внутренний адрес. Переадресация проверяется на
 * каждом шаге — на чужой хост она не уводит.
 *
 * Пути RTTF бывают с пробелами: `new URL` кодирует их сам (`%20`), а уже
 * закодированное не трогает.
 */
@Injectable()
export class CatalogImageFetcher {
  private readonly hosts: readonly string[];

  constructor(@Inject(ENV) env: Env) {
    this.hosts = importHosts(env);
  }

  async fetch(raw: string): Promise<Buffer> {
    let url = new URL(raw);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

    for (let hop = 0; hop <= REDIRECTS_MAX; hop += 1) {
      if (!isAllowedImageUrl(url, this.hosts)) throw new ImageFetchError('HOST');

      const response = await this.request(url, signal);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) throw new ImageFetchError('HTTP');
        url = new URL(location, url);
        continue;
      }

      if (!response.ok) throw new ImageFetchError('HTTP');

      return this.body(response);
    }

    throw new ImageFetchError('HTTP');
  }

  private async request(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, { redirect: 'manual', signal });
    } catch {
      // Хост не ответил или не уложился во время — для итога строки это одно.
      throw new ImageFetchError('NETWORK');
    }
  }

  private async body(response: Response): Promise<Buffer> {
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();

    if (type === undefined || !IMAGE_TYPES.includes(type)) throw new ImageFetchError('TYPE');

    const declared = Number(response.headers.get('content-length') ?? '0');

    if (declared > IMPORT_IMAGE_MAX_BYTES) throw new ImageFetchError('SIZE');
    if (response.body === null) throw new ImageFetchError('HTTP');

    // Длина в заголовке — обещание, а не гарантия: тело читается с потолком.
    const chunks: Uint8Array[] = [];
    let size = 0;

    // Тело ответа `fetch` в типах Node — поток `any`; байты в нём всегда.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        size += value.byteLength;
        if (size > IMPORT_IMAGE_MAX_BYTES) {
          await reader.cancel();
          throw new ImageFetchError('SIZE');
        }
        chunks.push(value);
      }
    } catch (error) {
      // Обрыв посреди тела или истекло время — то же, что хост не ответил.
      throw error instanceof ImageFetchError ? error : new ImageFetchError('NETWORK');
    }

    return Buffer.concat(chunks);
  }
}
