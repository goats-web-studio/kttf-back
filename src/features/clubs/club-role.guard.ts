import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';

export type ClubRole = 'OWNER' | 'ORGANIZER' | 'REFEREE';

const CLUB_ROLES = 'kttf:club-roles';

/**
 * Проверка роли в клубе.
 *
 * ТС 8.3: ролевая модель проверяется на уровне guard'ов, а не интерфейса.
 * Клуб берётся из параметра маршрута `id` — все защищённые маршруты клубов
 * лежат под `/clubs/:id`.
 */
@Injectable()
export class ClubRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Маршруты без декоратора guard не касается: метаданных у них нет.
    const allowed = this.reflector.getAllAndOverride<ClubRole[] | undefined>(CLUB_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (allowed === undefined || allowed.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.userId;
    // Express допускает повторение параметра, и тип у него шире строки.
    const clubId = request.params.id;

    if (userId === undefined || typeof clubId !== 'string') {
      throw new AppError(
        ERROR_CODES.UNAUTHORIZED,
        'Club role check requires an authenticated user',
      );
    }

    const membership = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } },
      select: { role: true },
    });

    if (membership === null || !allowed.includes(membership.role)) {
      // Один и тот же ответ и для чужого клуба, и для несуществующего: иначе
      // перебором идентификаторов узнаётся, какие клубы вообще есть.
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Insufficient club role', { clubId });
    }

    return true;
  }
}

/**
 * Маршрут доступен только перечисленным ролям в клубе из `:id`.
 *
 * Включает и проверку токена: роль без пользователя не проверить, а забыть
 * второй декоратор легко — и тогда маршрут молча открывается всем.
 */
export function RequireClubRole(...roles: ClubRole[]): ReturnType<typeof applyDecorators> {
  return applyDecorators(SetMetadata(CLUB_ROLES, roles), UseGuards(JwtAuthGuard, ClubRoleGuard));
}
