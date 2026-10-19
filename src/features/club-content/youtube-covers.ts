import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { Injectable } from '@nestjs/common';

/** Сколько ждать обложку: дольше — человек решит, что форма зависла. */
const FETCH_TIMEOUT_MS = 8000;

export interface YoutubeCover {
  readonly body: Buffer;
  /** Мелкая обложка 4:3 с полосами у широкого ролика — срезать до 16:9. */
  readonly letterboxed: boolean;
}

/**
 * Обложка ролика YouTube — ADR-055, `docs/09` 7.2.
 *
 * Скачивается сервером один раз при добавлении и хранится у нас: посетитель
 * страницы клуба не ходит к Google, пока сам не нажмёт «смотреть». Сначала
 * крупная `maxresdefault` — её нет у старых и мелких роликов, тогда
 * `hqdefault`, которая есть у любого существующего. Нет и её — ролика нет.
 */
@Injectable()
export class YoutubeCovers {
  async fetch(youtubeId: string): Promise<YoutubeCover> {
    const large = await this.download(`https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`);

    if (large !== null) return { body: large, letterboxed: false };

    const small = await this.download(`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`);

    if (small !== null) return { body: small, letterboxed: true };

    throw new AppError(ERROR_CODES.VIDEO_NOT_FOUND, 'Video cover not found', { youtubeId });
  }

  private async download(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

      return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    } catch {
      // Сеть недоступна или YouTube не ответил вовремя — для человека это
      // то же, что ролика нет: добавить его сейчас нельзя.
      return null;
    }
  }
}
