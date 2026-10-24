import {
  annulDuelSchema,
  createDuelSchema,
  disputeDuelSchema,
  duelReasonSchema,
  listAdminDuelsSchema,
  listDuelsSchema,
  listMyDuelsSchema,
  reportDuelSchema,
  resolveDuelSchema,
  respondDuelSchema,
  type AdminDuelItemView,
  type AnnulDuelInput,
  type CreateDuelInput,
  type DisputeDuelInput,
  type DuelItemView,
  type DuelReasonInput,
  type DuelView,
  type ListAdminDuelsQuery,
  type ListDuelsQuery,
  type ListMyDuelsQuery,
  type Page,
  type ReportDuelInput,
  type ResolveDuelInput,
  type RespondDuelInput,
} from '@kttf/shared/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { DuelsAdminService } from './duels-admin.service.js';
import { DuelsService } from './duels.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());
/** Причина необязательна — запрос может прийти и вовсе без тела. */
const reasonBody = new ZodValidationPipe<DuelReasonInput>(
  z.preprocess((value) => value ?? {}, duelReasonSchema),
);

/**
 * Дуэли и спарринги — ADR-065, `docs/13` §4. Доска и страница открыты всем,
 * но ответ зависит от смотрящего (отклики, `can`), поэтому токен читается,
 * если он есть. Действия — под входом; кто именно может, решает сервис.
 */
@Controller()
export class DuelsController {
  constructor(private readonly duels: DuelsService) {}

  @Get('duels')
  @UseGuards(OptionalJwtGuard)
  async list(
    @Query(new ZodValidationPipe(listDuelsSchema)) query: ListDuelsQuery,
    @OptionalUserId() userId?: string,
  ): Promise<Page<DuelItemView>> {
    return this.duels.list(query, userId);
  }

  @Post('duels')
  @UseGuards(JwtAuthGuard)
  async create(
    @Body(new ZodValidationPipe(createDuelSchema)) body: CreateDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.create(userId, body);
  }

  @Get('me/duels')
  @UseGuards(JwtAuthGuard)
  async listMine(
    @Query(new ZodValidationPipe(listMyDuelsSchema)) query: ListMyDuelsQuery,
    @CurrentUserId() userId: string,
  ): Promise<Page<DuelItemView>> {
    return this.duels.listMine(userId, query);
  }

  @Get('duels/:id')
  @UseGuards(OptionalJwtGuard)
  async view(
    @Param('id', uuidParam) id: string,
    @OptionalUserId() userId?: string,
  ): Promise<DuelView> {
    return this.duels.view(id, userId);
  }

  @Post('duels/:id/responses')
  @UseGuards(JwtAuthGuard)
  async respond(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(respondDuelSchema)) body: RespondDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.respond(id, userId, body);
  }

  @Post('duel-responses/:id/withdraw')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.withdraw(id, userId);
  }

  @Post('duel-responses/:id/accept')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.accept(id, userId);
  }

  @Post('duel-responses/:id/decline')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async declineResponse(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.declineResponse(id, userId);
  }

  @Post('duels/:id/decline')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async decline(
    @Param('id', uuidParam) id: string,
    @Body(reasonBody) body: DuelReasonInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.decline(id, userId, body);
  }

  @Post('duels/:id/cancel')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', uuidParam) id: string,
    @Body(reasonBody) body: DuelReasonInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.cancel(id, userId, body);
  }

  @Post('duels/:id/result')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async report(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(reportDuelSchema)) body: ReportDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.report(id, userId, body);
  }

  @Post('duels/:id/confirm')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async confirm(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.confirm(id, userId);
  }

  @Post('duels/:id/dispute')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async dispute(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(disputeDuelSchema)) body: DisputeDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.duels.dispute(id, userId, body);
  }
}

/** Очередь рейтинговых дуэлей администратора — `docs/13` §3.6. */
@Controller('admin/duels')
export class DuelsAdminController {
  constructor(private readonly admin: DuelsAdminService) {}

  @Get()
  @RequireAdmin()
  async list(
    @Query(new ZodValidationPipe(listAdminDuelsSchema)) query: ListAdminDuelsQuery,
  ): Promise<Page<AdminDuelItemView>> {
    return this.admin.list(query);
  }

  @Post(':id/resolve')
  @RequireAdmin()
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(resolveDuelSchema)) body: ResolveDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.admin.resolve(id, userId, body);
  }

  @Post(':id/annul')
  @RequireAdmin()
  @HttpCode(HttpStatus.OK)
  async annul(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(annulDuelSchema)) body: AnnulDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.admin.annul(id, userId, body);
  }
}
