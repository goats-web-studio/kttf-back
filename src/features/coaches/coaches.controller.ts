import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  SLUG_PATTERN,
  coachEventSchema,
  coachStatsQuerySchema,
  listCoachApplicationsSchema,
  listCoachesSchema,
  listTrainingsSchema,
  rejectCoachSchema,
  setCoachAchievementsSchema,
  setCoachCredentialsSchema,
  setCoachHiddenSchema,
  setClubTrainingsSchema,
  setCoachTrainingsSchema,
  updateCoachSchema,
  verifyCoachCredentialSchema,
  type CoachApplicationView,
  type CoachEventInput,
  type CoachListItemView,
  type CoachStatsQuery,
  type CoachStatsView,
  type CoachView,
  type ListCoachApplicationsQuery,
  type ListCoachesQuery,
  type ListTrainingsQuery,
  type Page,
  type RejectCoachInput,
  type SetCoachAchievementsInput,
  type SetCoachCredentialsInput,
  type SetCoachHiddenInput,
  type SetClubTrainingsInput,
  type SetCoachTrainingsInput,
  type ClubTrainingsManageView,
  type TrainingDetailView,
  type TrainingGroupView,
  type TrainingView,
  type UpdateCoachInput,
  type VerifyCoachCredentialInput,
} from '@kttf/shared/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { clientIp } from '../../common/client-ip.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { RequireClubRole } from '../clubs/club-role.guard.js';
import { StorageService } from '../files/storage.service.js';
import { CoachAdminService } from './coach-admin.service.js';
import { CoachCatalogService } from './coach-catalog.service.js';
import { RequireCoachOwner } from './coach-owner.guard.js';
import { CoachStatsService } from './coach-stats.service.js';
import { CoachesService } from './coaches.service.js';
import { TrainingsService } from './trainings.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());
const slugParam = new ZodValidationPipe(z.string().max(100).regex(SLUG_PATTERN));

/**
 * Страница тренера — ТС 7.4в, ADR-059.
 *
 * Чтение опубликованного открыто всем. Правка — владельцу страницы
 * (`Coach.userId`) и администратору платформы.
 */
@Controller('coaches')
export class CoachesController {
  constructor(
    private readonly coaches: CoachesService,
    private readonly catalog: CoachCatalogService,
    private readonly stats: CoachStatsService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listCoachesSchema)) query: ListCoachesQuery,
  ): Promise<Page<CoachListItemView>> {
    return this.catalog.list(query);
  }

  /** Публичная страница; неопубликованную видят только владелец и администратор. */
  @Get('by-slug/:slug')
  @UseGuards(OptionalJwtGuard)
  async findBySlug(
    @Param('slug', slugParam) slug: string,
    @OptionalUserId() viewerId: string | undefined,
  ): Promise<CoachView> {
    return this.coaches.findBySlug(slug, viewerId);
  }

  /** «Стать тренером» — из своего профиля игрока. */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@CurrentUserId() userId: string): Promise<CoachView> {
    return this.coaches.create(userId);
  }

  @Get(':id')
  @RequireCoachOwner()
  async findOne(@Param('id', uuidParam) id: string): Promise<CoachView> {
    return this.coaches.findById(id);
  }

  @Patch(':id')
  @RequireCoachOwner()
  async update(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(updateCoachSchema)) body: UpdateCoachInput,
  ): Promise<CoachView> {
    return this.coaches.update(id, body);
  }

  /**
   * Свои тренировки целиком, порядок строк — порядок в теле. «В клубе» —
   * клуб KTTF (клуб подтверждает) или зал вне KTTF с адресом.
   */
  @Put(':id/trainings')
  @RequireCoachOwner()
  async setTrainings(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(setCoachTrainingsSchema)) body: SetCoachTrainingsInput,
  ): Promise<CoachView> {
    return this.coaches.setTrainings(id, body);
  }

  @Put(':id/credentials')
  @RequireCoachOwner()
  async setCredentials(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(setCoachCredentialsSchema)) body: SetCoachCredentialsInput,
  ): Promise<CoachView> {
    return this.coaches.setCredentials(id, body);
  }

  @Put(':id/achievements')
  @RequireCoachOwner()
  async setAchievements(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(setCoachAchievementsSchema)) body: SetCoachAchievementsInput,
  ): Promise<CoachView> {
    return this.coaches.setAchievements(id, body);
  }

  /** «Всё актуально» — страница проверена без правок. */
  @Post(':id/reviewed')
  @RequireCoachOwner()
  async markReviewed(@Param('id', uuidParam) id: string): Promise<CoachView> {
    return this.coaches.markReviewed(id);
  }

  /** На проверку администратору. */
  @Post(':id/submit')
  @RequireCoachOwner()
  async submit(@Param('id', uuidParam) id: string): Promise<CoachView> {
    return this.coaches.submit(id);
  }

  /**
   * Просмотр и нажатие на способ связи. Открыт всем; ответ пустой и
   * одинаковый всегда — и для повтора, и для чужой страницы.
   */
  @Post(':id/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordEvent(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(coachEventSchema)) body: CoachEventInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.stats.record(id, body, clientIp(request));
  }

  @Get(':id/stats')
  @RequireCoachOwner()
  async coachStats(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(coachStatsQuerySchema)) query: CoachStatsQuery,
  ): Promise<CoachStatsView> {
    return this.stats.stats(id, query.days);
  }

  /**
   * Скан документа — персональные данные (ADR-059, риски). Общая выдача
   * файлов папку сканов не отдаёт; здесь права сверяются на каждый запрос.
   * Непубличный скан не оседает ни в каком кэше.
   */
  @Get(':id/credentials/:credentialId/file')
  @UseGuards(OptionalJwtGuard)
  async credentialFile(
    @Param('id', uuidParam) id: string,
    @Param('credentialId', uuidParam) credentialId: string,
    @OptionalUserId() viewerId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const { key, isPublic } = await this.coaches.credentialFile(id, credentialId, viewerId);
    const file = await this.storage.get(key);

    response
      // Публичный скан тренер может снова закрыть: кэш короткий, а не годовой.
      .setHeader('Cache-Control', isPublic ? 'public, max-age=300' : 'private, no-store')
      .type(file.contentType)
      .send(file.body);
  }
}

/**
 * Раздел «Тренировки» — блоками по месту — и ответ второй стороны на связь
 * (решение владельца от 20.10.2026).
 */
@Controller('trainings')
export class TrainingsController {
  constructor(private readonly trainings: TrainingsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listTrainingsSchema)) query: ListTrainingsQuery,
  ): Promise<Page<TrainingGroupView>> {
    return this.trainings.list(query);
  }

  /** «Подробнее»: непубличную видят только её стороны и администратор. */
  @Get(':id')
  @UseGuards(OptionalJwtGuard)
  async findOne(
    @Param('id', uuidParam) id: string,
    @OptionalUserId() viewerId: string | undefined,
  ): Promise<TrainingDetailView> {
    return this.trainings.detail(id, viewerId);
  }

  /** Подтвердить связь — клуб у тренировки тренера, тренер у клубной. */
  @Post(':id/confirm')
  @UseGuards(JwtAuthGuard)
  async confirm(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TrainingView> {
    return this.trainings.confirm(id, userId);
  }

  /** Отказать или разорвать подтверждённую связь. */
  @Post(':id/decline')
  @UseGuards(JwtAuthGuard)
  async decline(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TrainingView> {
    return this.trainings.decline(id, userId);
  }
}

/** Тренировки на странице клуба и в его кабинете. */
@Controller('clubs')
export class ClubTrainingsController {
  constructor(private readonly trainings: TrainingsService) {}

  @Get(':id/trainings')
  async list(@Param('id', uuidParam) id: string): Promise<TrainingView[]> {
    return this.trainings.forClub(id);
  }

  @Get(':id/trainings/manage')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async manage(@Param('id', uuidParam) id: string): Promise<ClubTrainingsManageView> {
    return this.trainings.manage(id);
  }

  /** Тренировки клуба целиком, порядок строк — порядок в теле. */
  @Put(':id/trainings')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async setTrainings(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(setClubTrainingsSchema)) body: SetClubTrainingsInput,
  ): Promise<ClubTrainingsManageView> {
    return this.trainings.setClubTrainings(id, body);
  }
}

/** Заявки тренеров и постмодерация — только администратор платформы. */
@Controller('admin/coaches')
@RequireAdmin()
export class CoachesAdminController {
  constructor(private readonly admin: CoachAdminService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listCoachApplicationsSchema)) query: ListCoachApplicationsQuery,
  ): Promise<Page<CoachApplicationView>> {
    return this.admin.list(query);
  }

  @Post(':id/approve')
  async approve(@Param('id', uuidParam) id: string): Promise<CoachApplicationView> {
    return this.admin.approve(id);
  }

  @Post(':id/reject')
  async reject(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(rejectCoachSchema)) body: RejectCoachInput,
  ): Promise<CoachApplicationView> {
    return this.admin.reject(id, body.reason);
  }

  @Patch(':id/hidden')
  async setHidden(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(setCoachHiddenSchema)) body: SetCoachHiddenInput,
  ): Promise<CoachApplicationView> {
    return this.admin.setHidden(id, body);
  }

  @Patch(':id/credentials/:credentialId')
  async verifyCredential(
    @Param('id', uuidParam) id: string,
    @Param('credentialId', uuidParam) credentialId: string,
    @Body(new ZodValidationPipe(verifyCoachCredentialSchema)) body: VerifyCoachCredentialInput,
  ): Promise<CoachView> {
    return this.admin.verifyCredential(id, credentialId, body.verified);
  }
}
