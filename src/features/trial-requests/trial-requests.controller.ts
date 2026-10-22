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
import {
  answerTrialRequestSchema,
  createTrialRequestSchema,
  listTrialRequestsSchema,
  type AnswerTrialRequestInput,
  type CreateTrialRequestInput,
  type IncomingTrialRequestView,
  type ListTrialRequestsQuery,
  type Page,
  type TrialRequestView,
  type TrialRequestsCount,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { TrialRequestsService } from './trial-requests.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());
const listQuery = new ZodValidationPipe(listTrialRequestsSchema);

/**
 * Заявка на пробную с сайта — T3 (ADR-059, `docs/11` 3.3.3). Всё — только
 * вошедшему: отправителю — свои заявки, адресату — его ящик. Право на ящик
 * проверяет сервис: у клуба в него пускает и администратора платформы,
 * чего не умеет `RequireClubRole`.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class TrialRequestsController {
  constructor(private readonly trials: TrialRequestsService) {}

  @Post('trainings/:id/trial-requests')
  async create(
    @Param('id', uuidParam) trainingId: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createTrialRequestSchema)) body: CreateTrialRequestInput,
  ): Promise<TrialRequestView> {
    return this.trials.create(trainingId, userId, body);
  }

  @Get('me/trial-requests')
  async listMine(
    @CurrentUserId() userId: string,
    @Query(listQuery) query: ListTrialRequestsQuery,
  ): Promise<Page<TrialRequestView>> {
    return this.trials.listMine(userId, query);
  }

  @Post('trial-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TrialRequestView> {
    return this.trials.cancel(id, userId);
  }

  @Post('trial-requests/:id/answer')
  @HttpCode(HttpStatus.OK)
  async answer(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(answerTrialRequestSchema)) body: AnswerTrialRequestInput,
  ): Promise<IncomingTrialRequestView> {
    return this.trials.answer(id, userId, body);
  }

  @Get('coaches/:id/trial-requests')
  async forCoach(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
    @Query(listQuery) query: ListTrialRequestsQuery,
  ): Promise<Page<IncomingTrialRequestView>> {
    return this.trials.incoming({ kind: 'COACH', id }, userId, query);
  }

  @Get('coaches/:id/trial-requests/count')
  async countForCoach(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TrialRequestsCount> {
    return this.trials.count({ kind: 'COACH', id }, userId);
  }

  @Get('clubs/:id/trial-requests')
  async forClub(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
    @Query(listQuery) query: ListTrialRequestsQuery,
  ): Promise<Page<IncomingTrialRequestView>> {
    return this.trials.incoming({ kind: 'CLUB', id }, userId, query);
  }

  @Get('clubs/:id/trial-requests/count')
  async countForClub(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TrialRequestsCount> {
    return this.trials.count({ kind: 'CLUB', id }, userId);
  }
}
