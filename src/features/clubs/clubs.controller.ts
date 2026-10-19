import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  addMemberSchema,
  clubEventSchema,
  clubStatsQuerySchema,
  createClubSchema,
  listClubsSchema,
  setClubHiddenSchema,
  setClubHoursSchema,
  setClubPricesSchema,
  updateClubSchema,
  type AddMemberInput,
  type ClubEventInput,
  type ClubListItemView,
  type ClubMemberView,
  type ClubStatsQuery,
  type ClubStatsView,
  type ClubSummaryView,
  type ClubView,
  type CreateClubInput,
  type ListClubsQuery,
  type Page,
  type SetClubHiddenInput,
  type SetClubHoursInput,
  type SetClubPricesInput,
  type UpdateClubInput,
} from '@kttf/shared/types';
import type { Request } from 'express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId } from '../auth/jwt-auth.guard.js';
import { clientIp } from '../club-applications/client-ip.js';
import { ClubPageService } from './club-page.service.js';
import { RequireClubRole } from './club-role.guard.js';
import { ClubStatsService } from './club-stats.service.js';
import { ClubsService } from './clubs.service.js';

const uuidParam = z.uuid();

/**
 * Контракт — ТС 7.4.
 *
 * Двух маршрутов раздела здесь нет: `balance` и `transactions`. Они относятся
 * к финансам клуба, а оплата по разделу 9 состояния ждёт подтверждения
 * гипотез. Заводить их пустыми означало бы обещать функцию, которой нет.
 */
@Controller('clubs')
export class ClubsController {
  constructor(
    private readonly clubs: ClubsService,
    private readonly page: ClubPageService,
    private readonly stats: ClubStatsService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listClubsSchema)) query: ListClubsQuery,
  ): Promise<Page<ClubListItemView>> {
    return this.clubs.list(query);
  }

  @Get(':id')
  async findOne(@Param('id', new ZodValidationPipe(uuidParam)) id: string): Promise<ClubView> {
    return this.clubs.findById(id);
  }

  /**
   * Клуб заводит администратор платформы по заявке «Напишите нам» — ADR-049.
   * Заведший становится владельцем и передаёт клуб представителю зала
   * через состав (`POST /clubs/:id/members`).
   */
  @Post()
  @RequireAdmin()
  async create(
    @Body(new ZodValidationPipe(createClubSchema)) body: CreateClubInput,
    @CurrentUserId() userId: string,
  ): Promise<ClubView> {
    return this.clubs.create(body, userId);
  }

  @Patch(':id')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async update(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateClubSchema)) body: UpdateClubInput,
  ): Promise<ClubView> {
    return this.clubs.update(id, body);
  }

  /** Часы работы неделей целиком — ADR-055. */
  @Put(':id/hours')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async setHours(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(setClubHoursSchema)) body: SetClubHoursInput,
  ): Promise<ClubView> {
    return this.page.setHours(id, body);
  }

  /** Прайс целиком, порядок строк — порядок в теле. */
  @Put(':id/prices')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async setPrices(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(setClubPricesSchema)) body: SetClubPricesInput,
  ): Promise<ClubView> {
    return this.page.setPrices(id, body);
  }

  /** «Всё актуально» — страница проверена без правок. */
  @Post(':id/reviewed')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async markReviewed(@Param('id', new ZodValidationPipe(uuidParam)) id: string): Promise<ClubView> {
    return this.page.markReviewed(id);
  }

  /** Скрыть из каталога — администратор платформы. */
  @Patch(':id/hidden')
  @RequireAdmin()
  async setHidden(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(setClubHiddenSchema)) body: SetClubHiddenInput,
  ): Promise<ClubView> {
    return this.page.setHidden(id, body.hidden);
  }

  /** Живые данные клуба — публичны, как и сама страница. */
  @Get(':id/summary')
  async summary(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ): Promise<ClubSummaryView> {
    return this.page.summary(id);
  }

  /**
   * Просмотр и нажатие на способ связи. Открыт всем: смотрят страницу без
   * входа. Ответ пустой и одинаковый всегда — и для повтора, и для чужого
   * клуба.
   */
  @Post(':id/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordEvent(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(clubEventSchema)) body: ClubEventInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.stats.record(id, body, clientIp(request));
  }

  /** Статистика обращений — только составу клуба. */
  @Get(':id/stats')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async clubStats(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Query(new ZodValidationPipe(clubStatsQuerySchema)) query: ClubStatsQuery,
  ): Promise<ClubStatsView> {
    return this.stats.stats(id, query.days);
  }

  /** Состав публичен — ТЗ 3.2 показывает его на странице клуба. */
  @Get(':id/members')
  async members(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
  ): Promise<readonly ClubMemberView[]> {
    return this.clubs.listMembers(id);
  }

  /** Состав организаторов ведёт владелец — ТЗ 1. */
  @Post(':id/members')
  @RequireClubRole('OWNER')
  async addMember(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
  ): Promise<ClubMemberView> {
    return this.clubs.addMember(id, body);
  }

  @Delete(':id/members/:userId')
  @RequireClubRole('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('userId', new ZodValidationPipe(uuidParam)) userId: string,
  ): Promise<void> {
    await this.clubs.removeMember(id, userId);
  }
}
