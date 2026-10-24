import {
  annulDuelSchema,
  createDuelSchema,
  disputeDuelSchema,
  duelContactSchema,
  duelReasonSchema,
  duelSetSchema,
  duelUndoSetSchema,
  listAdminDuelsSchema,
  listDuelsSchema,
  listMyDuelsSchema,
  reportDuelSchema,
  resolveDuelSchema,
  rescheduleDuelSchema,
  respondDuelSchema,
  type AdminDuelItemView,
  type AnnulDuelInput,
  type CreateDuelInput,
  type DisputeDuelInput,
  type DuelContactInput,
  type DuelItemView,
  type DuelReasonInput,
  type DuelSetInput,
  type DuelUndoSetInput,
  type DuelView,
  type ListAdminDuelsQuery,
  type ListDuelsQuery,
  type ListMyDuelsQuery,
  type Page,
  type ReportDuelInput,
  type RescheduleDuelInput,
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
import { DuelMatchService } from './duel-match.service.js';
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

/**
 * Матч дуэли — ADR-068, `docs/13` §3.7: старт, табло, перенос, контакт.
 * Только участникам; что именно можно сейчас — решает сервис.
 */
@Controller('duels/:id')
@UseGuards(JwtAuthGuard)
export class DuelMatchController {
  constructor(private readonly match: DuelMatchService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.start(id, userId);
  }

  @Post('sets')
  @HttpCode(HttpStatus.OK)
  async addSet(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(duelSetSchema)) body: DuelSetInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.addSet(id, userId, body);
  }

  @Post('sets/undo')
  @HttpCode(HttpStatus.OK)
  async undoSet(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(duelUndoSetSchema)) body: DuelUndoSetInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.undoSet(id, userId, body);
  }

  @Post('finish')
  @HttpCode(HttpStatus.OK)
  async finish(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.finish(id, userId);
  }

  @Post('reschedule')
  @HttpCode(HttpStatus.OK)
  async propose(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(rescheduleDuelSchema)) body: RescheduleDuelInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.propose(id, userId, body);
  }

  @Post('reschedule/accept')
  @HttpCode(HttpStatus.OK)
  async acceptReschedule(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.acceptReschedule(id, userId);
  }

  @Post('reschedule/decline')
  @HttpCode(HttpStatus.OK)
  async declineReschedule(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.declineReschedule(id, userId);
  }

  @Post('reschedule/withdraw')
  @HttpCode(HttpStatus.OK)
  async withdrawReschedule(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.withdrawReschedule(id, userId);
  }

  @Post('contact')
  @HttpCode(HttpStatus.OK)
  async contact(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(duelContactSchema)) body: DuelContactInput,
    @CurrentUserId() userId: string,
  ): Promise<DuelView> {
    return this.match.contact(id, userId, body);
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
