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
} from '@nestjs/common';
import {
  adminAuditQuerySchema,
  adminBlockUserSchema,
  adminClubsQuerySchema,
  adminConfirmPlayerSchema,
  adminLinkPlayerSchema,
  adminPlayersQuerySchema,
  adminResetPasswordSchema,
  adminSetAdminSchema,
  adminSetClubRoleSchema,
  adminUpdateUserSchema,
  adminUsersQuerySchema,
  type AdminAuditQuery,
  type AdminBlockUserInput,
  type AdminClubMember,
  type AdminClubListItem,
  type AdminClubsQuery,
  type AdminConfirmPlayerInput,
  type AdminLinkPlayerInput,
  type AdminPlayerListItem,
  type AdminPlayersQuery,
  type AdminResetPasswordInput,
  type AdminResetPasswordResult,
  type AdminSetAdminInput,
  type AdminSetClubRoleInput,
  type AdminUpdateUserInput,
  type AdminUserListItem,
  type AdminUsersQuery,
  type AdminUserView,
  type AuditEntry,
  type Page,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RequireAdmin } from '../auth/admin.guard.js';
import { CurrentUserId } from '../auth/jwt-auth.guard.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminClubsService } from './admin-clubs.service.js';
import { AdminPlayersService } from './admin-players.service.js';
import { AdminUsersService } from './admin-users.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());

/**
 * Управление аккаунтами, профилями и клубами — ADR-103. Только
 * администратор платформы; каждое изменение пишется в журнал.
 */
@Controller('admin')
@RequireAdmin()
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly players: AdminPlayersService,
    private readonly clubs: AdminClubsService,
    private readonly auditLog: AdminAuditService,
  ) {}

  // ---------- аккаунты ----------

  @Get('users')
  async listUsers(
    @Query(new ZodValidationPipe(adminUsersQuerySchema)) query: AdminUsersQuery,
  ): Promise<Page<AdminUserListItem>> {
    return this.users.list(query);
  }

  @Get('users/:id')
  async user(@Param('id', uuidParam) id: string): Promise<AdminUserView> {
    return this.users.view(id);
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminUpdateUserSchema)) body: AdminUpdateUserInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.update(id, body, adminId);
  }

  @Post('users/:id/password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminResetPasswordSchema)) body: AdminResetPasswordInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminResetPasswordResult> {
    return this.users.resetPassword(id, body, adminId);
  }

  @Post('users/:id/block')
  @HttpCode(HttpStatus.OK)
  async block(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminBlockUserSchema)) body: AdminBlockUserInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.block(id, body, adminId);
  }

  @Delete('users/:id/block')
  async unblock(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.unblock(id, adminId);
  }

  @Put('users/:id/admin')
  async setAdmin(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminSetAdminSchema)) body: AdminSetAdminInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.setAdmin(id, body, adminId);
  }

  @Post('users/:id/sessions/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSessions(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() adminId: string,
  ): Promise<void> {
    await this.users.revokeSessions(id, adminId);
  }

  @Put('users/:id/club-roles')
  async setClubRole(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminSetClubRoleSchema)) body: AdminSetClubRoleInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.setClubRole(id, body, adminId);
  }

  @Delete('users/:id/club-roles/:clubId')
  async removeClubRole(
    @Param('id', uuidParam) id: string,
    @Param('clubId', uuidParam) clubId: string,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.removeClubRole(id, clubId, adminId);
  }

  @Put('users/:id/player')
  async linkPlayer(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminLinkPlayerSchema)) body: AdminLinkPlayerInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.linkPlayer(id, body, adminId);
  }

  @Delete('users/:id/player')
  async unlinkPlayer(
    @Param('id', uuidParam) id: string,
    @CurrentUserId() adminId: string,
  ): Promise<AdminUserView> {
    return this.users.unlinkPlayer(id, adminId);
  }

  // ---------- профили игроков ----------

  /** Правка самого профиля — `PATCH /players/:id`: администратору там можно (ADR-102). */
  @Get('players')
  async listPlayers(
    @Query(new ZodValidationPipe(adminPlayersQuerySchema)) query: AdminPlayersQuery,
  ): Promise<Page<AdminPlayerListItem>> {
    return this.players.list(query);
  }

  @Post('players/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPlayer(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(adminConfirmPlayerSchema)) body: AdminConfirmPlayerInput,
    @CurrentUserId() adminId: string,
  ): Promise<AdminPlayerListItem> {
    return this.players.confirm(id, body, adminId);
  }

  // ---------- клубы ----------

  @Get('clubs')
  async listClubs(
    @Query(new ZodValidationPipe(adminClubsQuerySchema)) query: AdminClubsQuery,
  ): Promise<Page<AdminClubListItem>> {
    return this.clubs.list(query);
  }

  @Get('clubs/:id/members')
  async clubMembers(@Param('id', uuidParam) id: string): Promise<AdminClubMember[]> {
    return this.clubs.members(id);
  }

  // ---------- журнал ----------

  @Get('audit')
  async audit(
    @Query(new ZodValidationPipe(adminAuditQuerySchema)) query: AdminAuditQuery,
  ): Promise<Page<AuditEntry>> {
    return this.auditLog.list(query);
  }
}
