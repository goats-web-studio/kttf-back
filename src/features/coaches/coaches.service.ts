import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  COACH_DOC_PATH_PATTERN,
  canSubmitCoach,
  coachLimits,
  coachMissing,
  isCoachPublic,
  slugify,
  type CoachView,
  type SetCoachAchievementsInput,
  type SetCoachCredentialsInput,
  type SetCoachServicesInput,
  type UpdateCoachInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { pickSlug } from '../catalog/catalog-query.js';
import { PlacesService } from '../places/places.service.js';
import { countStudents } from './coach-students.js';
import { coachFields, toCoachView, type CoachRecord, type CoachViewer } from './coach-view.js';

/** Владелец страницы и администратор: маршруты под `RequireCoachOwner`. */
const OWNER: CoachViewer = { privileged: true };

/** Путь загрузки, под которым сервер отдаёт файлы; ключ в хранилище — после него. */
const FILES_PREFIX = '/api/v1/files/';

/** Сохранённый документ — то, с чем сравнивается правка. */
interface StoredCredential {
  readonly title: string;
  readonly issuer: string | null;
  readonly year: number | null;
  readonly fileKey: string | null;
  readonly verifiedAt: Date | null;
}

type CredentialFields = Omit<StoredCredential, 'verifiedAt'>;

/**
 * Отметка «проверено KTTF» переживает правку, только если проверенное не
 * изменилось: название, кем выдан, год и скан. Поменялось что-то из них —
 * администратор проверял другой документ (ADR-059, риск ложных документов).
 * Галочка «показывать скан» и вид документа отметку не снимают.
 */
export function keptVerification(previous: StoredCredential, next: CredentialFields): Date | null {
  const same =
    previous.title === next.title &&
    previous.issuer === next.issuer &&
    previous.year === next.year &&
    previous.fileKey === next.fileKey;

  return same ? previous.verifiedAt : null;
}

/** Где лежит скан и можно ли кэшировать ответ общим кэшем. */
export interface CredentialFile {
  readonly key: string;
  /** Скан публичен: открыт всем, а не только владельцу и администратору. */
  readonly isPublic: boolean;
}

/**
 * Страница тренера — ADR-059, `docs/11` 3.1: заведение из профиля игрока,
 * правка, заявка на проверку, публичный просмотр.
 *
 * Списки (тренировки, документы, заслуги) правятся целиком, как часы и цены
 * клуба: форма отправляет список разом, сервер заменяет строки одной
 * транзакцией.
 */
@Injectable()
export class CoachesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly places: PlacesService,
  ) {}

  /**
   * «Стать тренером». Страница одна на профиль игрока; город — город игрока,
   * адрес — фамилия и имя латиницей.
   */
  async create(userId: string): Promise<CoachView> {
    const player = await this.prisma.player.findUnique({
      where: { userId },
      select: {
        id: true,
        lastName: true,
        firstName: true,
        cityId: true,
        coachPage: { select: { id: true } },
      },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Coach page requires a player profile');
    }

    if (player.coachPage !== null) {
      throw new AppError(ERROR_CODES.COACH_ALREADY_EXISTS, 'Player already has a coach page', {
        coachId: player.coachPage.id,
      });
    }

    const slug = await this.freeSlug(player.lastName, player.firstName);

    try {
      const coach = await this.prisma.coach.create({
        data: { playerId: player.id, userId, slug, cityId: player.cityId },
        select: coachFields,
      });

      return await this.view(coach, OWNER);
    } catch (error) {
      // Двойное нажатие «Стать тренером»: второй запрос упирается в
      // уникальность и получает тот же отказ, что и при честной проверке.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(ERROR_CODES.COACH_ALREADY_EXISTS, 'Player already has a coach page');
      }

      throw error;
    }
  }

  /** Своя страница в любом статусе — кабинет тренера и администратор. */
  async findById(id: string): Promise<CoachView> {
    return this.view(await this.load(id), OWNER);
  }

  /**
   * Страница по адресу. Неопубликованную видят только владелец и
   * администратор; остальным она не существует — так же, как чужой адрес.
   */
  async findBySlug(slug: string, viewerId: string | undefined): Promise<CoachView> {
    const coach = await this.prisma.coach.findUnique({ where: { slug }, select: coachFields });

    if (coach === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { slug });
    }

    const viewer = { privileged: await this.isPrivileged(coach.userId, viewerId) };

    if (
      !viewer.privileged &&
      !isCoachPublic({ status: coach.status, hidden: coach.hiddenAt !== null })
    ) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { slug });
    }

    return this.view(coach, viewer);
  }

  /** Правка страницы. Статус не меняется: правки после одобрения — постмодерация. */
  async update(id: string, input: UpdateCoachInput): Promise<CoachView> {
    const current = await this.prisma.coach.findUnique({
      where: { id },
      select: { cityId: true },
    });

    if (current === null) throw notFound(id);

    await this.places.assertCityAvailable(input.cityId ?? undefined, current.cityId ?? undefined);

    const coach = await this.prisma.coach.update({
      where: { id },
      data: { ...defined(input), profileReviewedAt: new Date() },
      select: coachFields,
    });

    return this.view(coach, OWNER);
  }

  async setServices(id: string, input: SetCoachServicesInput): Promise<CoachView> {
    const { plan } = await this.planOf(id);

    assertLimit(input.services.length, coachLimits(plan).services, 'services');

    const [, , coach] = await this.prisma.$transaction([
      this.prisma.coachService.deleteMany({ where: { coachId: id } }),
      this.prisma.coachService.createMany({
        data: input.services.map((service, index) => ({
          coachId: id,
          kind: service.kind,
          audiences: service.audiences,
          kidsFromAge: service.kidsFromAge ?? null,
          place: service.place,
          title: service.title,
          schedule: service.schedule ?? null,
          priceKzt: service.priceKzt ?? null,
          unit: service.unit,
          note: service.note ?? null,
          sortOrder: index,
        })),
      }),
      this.touch(id),
    ]);

    return this.view(coach, OWNER);
  }

  /**
   * Документы целиком. Строка с `id` документа этого тренера остаётся той же
   * записью — с тем же адресом скана и, если документ не изменился, с
   * отметкой «проверено». Чужой или неизвестный `id` — новый документ:
   * подставить чужую проверенную запись в свой список нельзя.
   */
  async setCredentials(id: string, input: SetCoachCredentialsInput): Promise<CoachView> {
    const current = await this.prisma.coach.findUnique({
      where: { id },
      select: {
        plan: true,
        credentials: {
          select: {
            id: true,
            title: true,
            issuer: true,
            year: true,
            fileKey: true,
            verifiedAt: true,
          },
        },
      },
    });

    if (current === null) throw notFound(id);

    assertLimit(input.credentials.length, coachLimits(current.plan).credentials, 'credentials');

    const stored = new Map(current.credentials.map((credential) => [credential.id, credential]));
    const data = input.credentials.map((row, index) => {
      const fields = {
        title: row.title,
        issuer: row.issuer ?? null,
        year: row.year ?? null,
        fileKey: row.file ?? null,
      };
      const base = {
        coachId: id,
        kind: row.kind,
        ...fields,
        filePublic: row.filePublic ?? false,
        sortOrder: index,
      };
      const previous = row.id === undefined ? undefined : stored.get(row.id);

      return previous === undefined
        ? base
        : { ...base, id: previous.id, verifiedAt: keptVerification(previous, fields) };
    });

    const [, , coach] = await this.prisma.$transaction([
      this.prisma.coachCredential.deleteMany({ where: { coachId: id } }),
      this.prisma.coachCredential.createMany({ data }),
      this.touch(id),
    ]);

    return this.view(coach, OWNER);
  }

  async setAchievements(id: string, input: SetCoachAchievementsInput): Promise<CoachView> {
    const { plan } = await this.planOf(id);

    assertLimit(input.achievements.length, coachLimits(plan).achievements, 'achievements');

    const [, , coach] = await this.prisma.$transaction([
      this.prisma.coachAchievement.deleteMany({ where: { coachId: id } }),
      this.prisma.coachAchievement.createMany({
        data: input.achievements.map((achievement, index) => ({
          coachId: id,
          role: achievement.role,
          year: achievement.year ?? null,
          title: achievement.title,
          sortOrder: index,
        })),
      }),
      this.touch(id),
    ]);

    return this.view(coach, OWNER);
  }

  /** «Всё актуально»: тренер проверил страницу и ничего не менял. */
  async markReviewed(id: string): Promise<CoachView> {
    await this.planOf(id);

    return this.view(await this.touch(id), OWNER);
  }

  /**
   * На проверку — из черновика или после отказа, с городом и хотя бы одной
   * тренировкой. Условие на статус — в самом обновлении: два одновременных
   * запроса не отправят заявку дважды.
   */
  async submit(id: string, now = new Date()): Promise<CoachView> {
    const coach = await this.prisma.coach.findUnique({
      where: { id },
      select: { status: true, cityId: true, services: { select: { id: true } } },
    });

    if (coach === null) throw notFound(id);

    if (!canSubmitCoach(coach.status)) throw statusInvalid(coach.status);

    const missing = coachMissing({ city: coach.cityId, services: coach.services });

    if (missing.length > 0) {
      throw new AppError(ERROR_CODES.COACH_INCOMPLETE, 'Coach page is incomplete', { missing });
    }

    const { count } = await this.prisma.coach.updateMany({
      where: { id, status: { in: ['DRAFT', 'REJECTED'] } },
      data: { status: 'PENDING', submittedAt: now, rejectReason: null },
    });

    if (count === 0) {
      const fresh = await this.prisma.coach.findUnique({ where: { id }, select: { status: true } });

      throw fresh === null ? notFound(id) : statusInvalid(fresh.status);
    }

    return this.findById(id);
  }

  /**
   * Скан документа. Открыт всем, если тренер отметил «показывать скан» и
   * страница опубликована; иначе — только владельцу и администратору.
   * Остальным скана нет вовсе: отказ не подсказывает, что он приложен.
   */
  async credentialFile(
    coachId: string,
    credentialId: string,
    viewerId: string | undefined,
  ): Promise<CredentialFile> {
    const credential = await this.prisma.coachCredential.findFirst({
      where: { id: credentialId, coachId },
      select: {
        fileKey: true,
        filePublic: true,
        coach: { select: { userId: true, status: true, hiddenAt: true } },
      },
    });

    const fileKey = credential?.fileKey ?? null;

    if (credential === null || fileKey === null || !COACH_DOC_PATH_PATTERN.test(fileKey)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Credential file not found', { credentialId });
    }

    const isPublic =
      credential.filePublic &&
      isCoachPublic({
        status: credential.coach.status,
        hidden: credential.coach.hiddenAt !== null,
      });

    if (!isPublic && !(await this.isPrivileged(credential.coach.userId, viewerId))) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Credential file not found', { credentialId });
    }

    return { key: fileKey.slice(FILES_PREFIX.length), isPublic };
  }

  /** Существует ли страница, и под каким она планом. */
  async planOf(id: string): Promise<{ plan: CoachRecord['plan'] }> {
    const coach = await this.prisma.coach.findUnique({ where: { id }, select: { plan: true } });

    if (coach === null) throw notFound(id);

    return coach;
  }

  async view(coach: CoachRecord, viewer: CoachViewer): Promise<CoachView> {
    const students = await countStudents(this.prisma, [coach.playerId]);

    return toCoachView(coach, students.get(coach.playerId) ?? 0, viewer);
  }

  private async load(id: string): Promise<CoachRecord> {
    const coach = await this.prisma.coach.findUnique({ where: { id }, select: coachFields });

    if (coach === null) throw notFound(id);

    return coach;
  }

  /** Владелец страницы или администратор платформы. Аноним — никто из них. */
  private async isPrivileged(ownerId: string, viewerId: string | undefined): Promise<boolean> {
    if (viewerId === undefined) return false;
    if (viewerId === ownerId) return true;

    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerId },
      select: { isAdmin: true },
    });

    return viewer?.isAdmin === true;
  }

  private touch(id: string) {
    return this.prisma.coach.update({
      where: { id },
      data: { profileReviewedAt: new Date() },
      select: coachFields,
    });
  }

  /** Свободный адрес: `ivanov-ivan`, при занятости — `ivanov-ivan-2`, `-3`… */
  private async freeSlug(lastName: string, firstName: string): Promise<string> {
    const slug = slugify(lastName, firstName);
    // Имя без единой буквы, которую можно перевести латиницей, — редкость,
    // но адрес нужен всегда.
    const base = slug === 'item' ? 'coach' : slug;
    const taken = await this.prisma.coach.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });

    return pickSlug(base, new Set(taken.map((coach) => coach.slug)));
  }
}

function notFound(id: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Coach not found', { id });
}

export function statusInvalid(status: string): AppError {
  return new AppError(ERROR_CODES.COACH_STATUS_INVALID, 'Action does not fit the coach status', {
    status,
  });
}

/**
 * Предел плана. Пока тарифы выключены, он равен потолку схемы и не
 * срабатывает; с тарифами — отказ с полем, как у любой ошибки формы.
 */
function assertLimit(count: number, max: number, field: string): void {
  if (count > max) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Plan limit exceeded', { field, max });
  }
}
