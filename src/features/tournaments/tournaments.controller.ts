import {
  createTournamentSchema,
  duplicateTournamentSchema,
  listTournamentsSchema,
  registerSchema,
  updateRegistrationSchema,
  updateTournamentSchema,
  type CreateTournamentInput,
  type DuplicateTournamentInput,
  type ListTournamentsQuery,
  type Page,
  type RegisterInput,
  type RegistrationView,
  type TournamentView,
  type UpdateRegistrationInput,
  type UpdateTournamentInput,
} from '@kttf/shared/types';
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';

import { TournamentsService } from './tournaments.service.js';

const uuidParam = z.uuid();

/**
 * Контракт — ТС 7.5. Маршруты и их формы менять нельзя без правки документа.
 *
 * Жеребьёвка, старт, завершение, снимок, синхронизация и таблицы сюда пока не
 * входят: они читают встречи и этапы, которых ещё нет.
 *
 * Чтение открыто без токена — это публичный календарь (ТЗ 9.2). Токен, если
 * он есть, влияет только на видимость черновиков.
 */
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Get()
  @UseGuards(OptionalJwtGuard)
  async list(
    @Query(new ZodValidationPipe(listTournamentsSchema)) query: ListTournamentsQuery,
    @OptionalUserId() userId?: string,
  ): Promise<Page<TournamentView>> {
    return this.tournaments.list(query, userId);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(
    @Body(new ZodValidationPipe(createTournamentSchema)) body: CreateTournamentInput,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.create(body, userId);
  }

  @Get(':id')
  @UseGuards(OptionalJwtGuard)
  async findById(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @OptionalUserId() userId?: string,
  ): Promise<TournamentView> {
    return this.tournaments.findById(id, userId);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(updateTournamentSchema)) body: UpdateTournamentInput,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.update(id, body, userId);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.tournaments.remove(id, userId);
  }

  /** «Повторить прошлый» — ТЗ 4.2. */
  @Post(':id/duplicate')
  @UseGuards(JwtAuthGuard)
  async duplicate(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(duplicateTournamentSchema)) body: DuplicateTournamentInput,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.duplicate(id, body, userId);
  }

  @Post(':id/publish')
  @UseGuards(JwtAuthGuard)
  async publish(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.transition(id, 'publish', userId);
  }

  @Post(':id/open-registration')
  @UseGuards(JwtAuthGuard)
  async openRegistration(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.transition(id, 'openRegistration', userId);
  }

  @Post(':id/close-registration')
  @UseGuards(JwtAuthGuard)
  async closeRegistration(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.transition(id, 'closeRegistration', userId);
  }

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard)
  async cancel(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<TournamentView> {
    return this.tournaments.transition(id, 'cancel', userId);
  }

  @Get(':id/registrations')
  @UseGuards(OptionalJwtGuard)
  async listRegistrations(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @OptionalUserId() userId?: string,
  ): Promise<readonly RegistrationView[]> {
    return this.tournaments.listRegistrations(id, userId);
  }

  @Post(':id/registrations')
  @UseGuards(JwtAuthGuard)
  async register(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @CurrentUserId() userId: string,
  ): Promise<RegistrationView> {
    return this.tournaments.register(id, body, userId);
  }

  @Patch(':id/registrations/:registrationId')
  @UseGuards(JwtAuthGuard)
  async updateRegistration(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('registrationId', new ZodValidationPipe(uuidParam)) registrationId: string,
    @Body(new ZodValidationPipe(updateRegistrationSchema)) body: UpdateRegistrationInput,
    @CurrentUserId() userId: string,
  ): Promise<RegistrationView> {
    return this.tournaments.updateRegistration(id, registrationId, body, userId);
  }

  @Delete(':id/registrations/:registrationId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRegistration(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Param('registrationId', new ZodValidationPipe(uuidParam)) registrationId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.tournaments.removeRegistration(id, registrationId, userId);
  }
}
