import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

import { TokenService } from './token.service.js';

/** Запрос после успешной проверки токена. */
export interface AuthenticatedRequest extends Request {
  userId?: string;
}

const BEARER = /^Bearer (.+)$/;

/**
 * Проверка access-токена.
 *
 * Guard, а не проверка в контроллере: ТС 8.3 требует, чтобы ролевая модель
 * проверялась на уровне guard'ов. Здесь пока только «токен действителен» —
 * роли появятся вместе с доменом, которому они нужны.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = BEARER.exec(request.headers.authorization ?? '');

    if (match?.[1] === undefined) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Bearer token required');
    }

    const userId = this.tokens.verifyAccessToken(match[1]);

    if (userId === null) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Token invalid or expired');
    }

    request.userId = userId;
    return true;
  }
}

/**
 * Идентификатор пользователя из проверенного токена.
 *
 * Применяется только под `JwtAuthGuard`: без него в запросе ничего нет, и
 * декоратор об этом сообщает отказом, а не молчаливым `undefined`.
 */
export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (request.userId === undefined) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'CurrentUserId used without JwtAuthGuard');
  }

  return request.userId;
});
