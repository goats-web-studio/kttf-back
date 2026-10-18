import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import type { AuthenticatedRequest } from './jwt-auth.guard.js';
import { LastSeenService } from './last-seen.service.js';

/**
 * Отметка посещения на каждом запросе с проверенным токеном — ADR-050.
 *
 * Перехватчик, а не строка в guard'ах: он срабатывает после любого из них —
 * обязательного и необязательного токена, — и guard'ы остаются проверкой
 * доступа без побочных эффектов. Ответ отметку не ждёт.
 */
@Injectable()
export class LastSeenInterceptor implements NestInterceptor {
  constructor(private readonly lastSeen: LastSeenService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().userId;

      if (userId !== undefined) {
        void this.lastSeen.touch(userId);
      }
    }

    return next.handle();
  }
}
