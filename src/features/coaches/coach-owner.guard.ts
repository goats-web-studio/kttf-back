import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';

/**
 * Владелец страницы тренера или администратор платформы — ADR-059, `docs/11` 4.5.
 *
 * Тренер берётся из параметра маршрута `id`: все защищённые маршруты лежат
 * под `/coaches/:id` и `/files/coaches/:id`. Администратор правит любую
 * страницу, поэтому проходит и к несуществующей — отказ `NOT_FOUND` ему
 * даст сервис.
 */
@Injectable()
export class CoachOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.userId;
    // Express допускает повторение параметра, и тип у него шире строки.
    const coachId = request.params.id;

    if (userId === undefined || typeof coachId !== 'string') {
      throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Coach check requires an authenticated user');
    }

    const [coach, user] = await Promise.all([
      this.prisma.coach.findUnique({ where: { id: coachId }, select: { userId: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
    ]);

    if (coach?.userId === userId || user?.isAdmin === true) return true;

    // Один ответ и для чужой страницы, и для несуществующей: иначе перебором
    // узнаётся, какие страницы заведены, включая черновики.
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not your coach page', { coachId });
  }
}

/**
 * Маршрут доступен владельцу страницы тренера из `:id` и администратору.
 * Включает и проверку токена — по той же причине, что `RequireClubRole`.
 */
export function RequireCoachOwner(): ReturnType<typeof applyDecorators> {
  return applyDecorators(UseGuards(JwtAuthGuard, CoachOwnerGuard));
}
