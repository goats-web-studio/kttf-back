import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { type AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard.js';

/**
 * Администратор платформы — ТЗ 1, ADR-046.
 *
 * Признак читается из базы на каждый запрос, а не из токена: снятый
 * администратор теряет права сразу, а не когда истечёт access-токен.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<AuthenticatedRequest>().userId;

    if (userId === undefined) {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Admin check requires an authenticated user');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });

    if (user?.isAdmin !== true) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Platform admin only');
    }

    return true;
  }
}

/**
 * Маршрут только для администратора платформы.
 *
 * Включает и проверку токена — по той же причине, что `RequireClubRole`:
 * второй декоратор легко забыть, и маршрут молча откроется всем.
 */
export function RequireAdmin(): ReturnType<typeof applyDecorators> {
  return applyDecorators(UseGuards(JwtAuthGuard, AdminGuard));
}
