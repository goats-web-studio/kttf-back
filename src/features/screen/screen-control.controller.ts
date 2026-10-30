import {
  setScreenControlSchema,
  type ScreenControlView,
  type SetScreenControlInput,
} from '@kttf/shared/types';
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';

import { ScreenControlService } from './screen-control.service.js';

const uuidParam = z.uuid();

/**
 * Слайд экрана зала из консоли — ADR-082.
 *
 * `GET` — что закреплено сейчас, `PUT` — закрепить на несколько минут или
 * вернуть «Авто» (`pin: null`). Действие сетевое: офлайн-очередь консоли его
 * не несёт, экран без сети и так ничего не получит.
 */
@Controller('tournaments/:id/screen')
@UseGuards(JwtAuthGuard)
export class ScreenControlController {
  constructor(private readonly control: ScreenControlService) {}

  @Get()
  async get(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @CurrentUserId() userId: string,
  ): Promise<ScreenControlView> {
    return this.control.get(id, userId);
  }

  @Put()
  async set(
    @Param('id', new ZodValidationPipe(uuidParam)) id: string,
    @Body(new ZodValidationPipe(setScreenControlSchema)) body: SetScreenControlInput,
    @CurrentUserId() userId: string,
  ): Promise<ScreenControlView> {
    return this.control.set(id, body, userId);
  }
}
