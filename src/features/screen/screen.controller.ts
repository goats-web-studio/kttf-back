import { SCREEN_EVENTS, type ScreenView } from '@kttf/shared/types';
import { Controller, Get, type MessageEvent, Param, Sse } from '@nestjs/common';
import { concatMap, from, interval, map, merge, Observable, of, switchMap } from 'rxjs';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { ScreenEventsService } from './screen-events.service.js';
import { ScreenService } from './screen.service.js';

/**
 * Второй экран зала — ТС 7.7.
 *
 * Оба маршрута открыты без авторизации: ключ — публичный токен в адресе.
 * Ничего, кроме показанного на стене, они не отдают (ADR-025).
 */

/** Токен генерируется как 32 символа base64url — ТС 8.3. */
const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

/**
 * Пауза между `ping`.
 *
 * Меньше обычных 60 секунд молчания, после которых прокси закрывает
 * соединение, и заметно больше, чем нужно: между встречами в зале пауза
 * измеряется минутами, и без этих событий канал выглядел бы мёртвым.
 */
const PING_INTERVAL_MS = 25_000;

@Controller('public/screen')
export class ScreenController {
  constructor(
    private readonly screen: ScreenService,
    private readonly events: ScreenEventsService,
  ) {}

  @Get(':publicToken')
  async state(
    @Param('publicToken', new ZodValidationPipe(tokenParam)) publicToken: string,
  ): Promise<ScreenView> {
    return this.screen.byToken(publicToken);
  }

  /**
   * Поток состояния — SSE вместо вебсокета, ADR-025.
   *
   * Первое событие уходит сразу при подключении: экран не должен ждать
   * ближайшего результата, чтобы что-то показать. Дальше — по изменениям
   * турнира, каждый раз состоянием целиком.
   *
   * Неизвестный токен закрывает поток ошибкой, а не отвечает `404`: заголовки
   * к тому моменту уже отправлены. Поэтому экран сначала запрашивает
   * состояние обычным `GET`, получает по нему внятный отказ и только потом
   * открывает поток.
   */
  @Sse(':publicToken/stream')
  stream(
    @Param('publicToken', new ZodValidationPipe(tokenParam)) publicToken: string,
  ): Observable<MessageEvent> {
    const state = from(this.screen.tournamentIdOf(publicToken)).pipe(
      switchMap((tournamentId) => merge(of(undefined), this.events.of(tournamentId))),
      // concatMap, а не mergeMap: два изменения подряд не должны обгонять
      // друг друга и оставить на стене состояние, которое уже неверно.
      concatMap(() => this.screen.byToken(publicToken)),
      map((view): MessageEvent => ({ type: SCREEN_EVENTS.state, data: view })),
    );

    const ping = interval(PING_INTERVAL_MS).pipe(
      map((): MessageEvent => ({
        type: SCREEN_EVENTS.ping,
        data: { at: new Date().toISOString() },
      })),
    );

    return merge(state, ping);
  }
}
