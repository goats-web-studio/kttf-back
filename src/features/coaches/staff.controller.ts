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
import {
  inviteClubCoachSchema,
  listCoachStudentsSchema,
  requestClubCoachSchema,
  updateClubCoachSchema,
  type ClubCoachView,
  type ClubStaffManageView,
  type CoachStudentRow,
  type CoachStudentsView,
  type InviteClubCoachInput,
  type ListCoachStudentsQuery,
  type Page,
  type RequestClubCoachInput,
  type UpdateClubCoachInput,
} from '@kttf/shared/types';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtGuard, OptionalUserId } from '../auth/optional-jwt.guard.js';
import { RequireClubRole } from '../clubs/club-role.guard.js';
import { ClubStaffService } from './club-staff.service.js';
import { RequireCoachOwner } from './coach-owner.guard.js';
import { StudentsService } from './students.service.js';

const uuidParam = new ZodValidationPipe(z.uuid());

/** Тренерский штаб на странице клуба и в его кабинете — T2 (ADR-059). */
@Controller('clubs')
export class ClubStaffController {
  constructor(private readonly staff: ClubStaffService) {}

  @Get(':id/staff')
  async list(@Param('id', uuidParam) id: string): Promise<ClubCoachView[]> {
    return this.staff.forClub(id);
  }

  @Get(':id/staff/manage')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async manage(@Param('id', uuidParam) id: string): Promise<ClubStaffManageView> {
    return this.staff.manage(id);
  }

  /** Клуб приглашает тренера; встречный запрос тренера — и есть согласие. */
  @Post(':id/staff')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async invite(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(inviteClubCoachSchema)) body: InviteClubCoachInput,
  ): Promise<ClubCoachView> {
    return this.staff.invite(id, body);
  }

  @Patch(':id/staff/:coachId')
  @RequireClubRole('OWNER', 'ORGANIZER')
  async setPosition(
    @Param('id', uuidParam) id: string,
    @Param('coachId', uuidParam) coachId: string,
    @Body(new ZodValidationPipe(updateClubCoachSchema)) body: UpdateClubCoachInput,
  ): Promise<ClubCoachView> {
    return this.staff.setPosition({ clubId: id, coachId }, body);
  }
}

/** Ответ на связь штаба и её разрыв — любой из сторон. */
@Controller('club-coaches')
@UseGuards(JwtAuthGuard)
export class ClubCoachesController {
  constructor(private readonly staff: ClubStaffService) {}

  @Post(':clubId/:coachId/confirm')
  async confirm(
    @Param('clubId', uuidParam) clubId: string,
    @Param('coachId', uuidParam) coachId: string,
    @CurrentUserId() userId: string,
  ): Promise<ClubCoachView> {
    return this.staff.confirm({ clubId, coachId }, userId);
  }

  @Delete(':clubId/:coachId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('clubId', uuidParam) clubId: string,
    @Param('coachId', uuidParam) coachId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    await this.staff.remove({ clubId, coachId }, userId);
  }
}

/** Штаб и ученики со стороны тренера — T2 (ADR-059). */
@Controller('coaches')
export class CoachStaffController {
  constructor(
    private readonly staff: ClubStaffService,
    private readonly students: StudentsService,
  ) {}

  /** Тренер просится в клуб; приглашение клуба — и есть согласие. */
  @Post(':id/clubs')
  @RequireCoachOwner()
  async request(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(requestClubCoachSchema)) body: RequestClubCoachInput,
  ): Promise<ClubCoachView> {
    return this.staff.request(id, body);
  }

  /** Ученики на странице тренера: младшие 14 — только числом. */
  @Get(':id/students')
  @UseGuards(OptionalJwtGuard)
  async studentsView(
    @Param('id', uuidParam) id: string,
    @OptionalUserId() viewerId: string | undefined,
  ): Promise<CoachStudentsView> {
    return this.students.view(id, viewerId);
  }

  @Get(':id/students/manage')
  @RequireCoachOwner()
  async manageStudents(
    @Param('id', uuidParam) id: string,
    @Query(new ZodValidationPipe(listCoachStudentsSchema)) query: ListCoachStudentsQuery,
  ): Promise<Page<CoachStudentRow>> {
    return this.students.manage(id, query);
  }

  /** «Я ученик». Раньше `:playerId`: «me» — не идентификатор. */
  @Post(':id/students/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async join(@Param('id', uuidParam) id: string, @CurrentUserId() userId: string): Promise<void> {
    await this.students.join(id, userId);
  }

  @Delete(':id/students/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(@Param('id', uuidParam) id: string, @CurrentUserId() userId: string): Promise<void> {
    await this.students.leave(id, userId);
  }

  /** Тренер убирает чужую ссылку на себя. */
  @Delete(':id/students/:playerId')
  @RequireCoachOwner()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeStudent(
    @Param('id', uuidParam) id: string,
    @Param('playerId', uuidParam) playerId: string,
  ): Promise<void> {
    await this.students.remove(id, playerId);
  }
}
