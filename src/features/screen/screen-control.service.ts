import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import type { ScreenControlView, SetScreenControlInput } from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { assertConsoleAccess } from '../tournaments/console-access.js';

import { ScreenEventsService } from './screen-events.service.js';
import { controlOf } from './screen.service.js';

/** Сколько держится закрепление по умолчанию. */
const DEFAULT_MINUTES = 5;

/**
 * Управление экраном зала из консоли — ADR-082.
 *
 * Судья закрепляет слайд («показать сетку сейчас») на несколько минут или
 * возвращает «Авто». Право — то же, что у консоли: любая роль в клубе.
 * После записи стена будится потоком и переключается сама.
 */
@Injectable()
export class ScreenControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ScreenEventsService,
  ) {}

  async get(tournamentId: string, userId: string): Promise<ScreenControlView> {
    const tournament = await this.load(tournamentId, userId);

    return controlOf(tournament.screenPin, tournament.screenPinUntil);
  }

  async set(
    tournamentId: string,
    input: SetScreenControlInput,
    userId: string,
  ): Promise<ScreenControlView> {
    await this.load(tournamentId, userId);

    const until =
      input.pin === null
        ? null
        : new Date(Date.now() + (input.minutes ?? DEFAULT_MINUTES) * 60_000);
    const saved = await this.prisma.tournament.update({
      where: { id: tournamentId },
      data: { screenPin: input.pin, screenPinUntil: until },
      select: { screenPin: true, screenPinUntil: true },
    });

    // После записи, а не внутри: стена перечитывает базу (ScreenEventsService).
    this.events.changed(tournamentId);

    return controlOf(saved.screenPin, saved.screenPinUntil);
  }

  private async load(tournamentId: string, userId: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { clubId: true, status: true, screenPin: true, screenPinUntil: true },
    });

    if (tournament === null || tournament.status === 'DRAFT') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Tournament not found', { tournamentId });
    }

    await assertConsoleAccess(this.prisma, tournament.clubId, userId, { tournamentId });

    return tournament;
  }
}
