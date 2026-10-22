import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  listNotificationsSchema,
  readNotificationsSchema,
  type ListNotificationsQuery,
  type NotificationView,
  type NotificationsUnread,
  type Page,
  type ReadNotificationsInput,
} from '@kttf/shared/types';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { NotificationsService } from './notifications.service.js';

/** Колокольчик и страница уведомлений — только свои (ТЗ 10, ADR-059 T3). */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUserId() userId: string,
    @Query(new ZodValidationPipe(listNotificationsSchema)) query: ListNotificationsQuery,
  ): Promise<Page<NotificationView>> {
    return this.notifications.list(userId, query);
  }

  @Get('unread')
  async unread(@CurrentUserId() userId: string): Promise<NotificationsUnread> {
    return this.notifications.unread(userId);
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(readNotificationsSchema)) body: ReadNotificationsInput,
  ): Promise<void> {
    await this.notifications.read(userId, body);
  }
}
