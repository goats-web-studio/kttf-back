import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';

import { type AuthenticatedRequest } from './jwt-auth.guard.js';
import { TokenService } from './token.service.js';

const BEARER = /^Bearer (.+)$/;

/**
 * Токен, если он есть.
 *
 * Нужен там, где маршрут публичный, но ответ зависит от того, кто спрашивает:
 * календарь турниров открыт всем, а черновики в нём видит только тот, кто
 * управляет клубом. Требовать токен на публичном маршруте нельзя, а
 * игнорировать — значит прятать черновики и от их автора.
 *
 * Недействительный токен здесь не отказ: запрос выполняется как анонимный.
 * Иначе просроченный токен в фоновой вкладке ломал бы публичную страницу.
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = BEARER.exec(request.headers.authorization ?? '');

    if (match?.[1] !== undefined) {
      const userId = this.tokens.verifyAccessToken(match[1]);

      if (userId !== null) {
        request.userId = userId;
      }
    }

    return true;
  }
}

/** Идентификатор пользователя или `undefined`. Применяется под `OptionalJwtGuard`. */
export const OptionalUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().userId,
);
