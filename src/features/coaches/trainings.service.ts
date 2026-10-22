import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import {
  CHILD_AUDIENCES,
  TIME_OF_DAY_BOUNDS,
  TRAINING_MORE_MAX,
  type ClubTrainingsManageView,
  type ListTrainingsQuery,
  type Page,
  type SetClubTrainingsInput,
  type TrainingDetailView,
  type TrainingGroupView,
  type TrainingLink,
  type TrainingView,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { pageOf } from '../../common/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { staffFromTrainings } from './club-staff.service.js';
import { groupTrainings, keptLink, rowId, slotRows } from './training-rules.js';
import { trainingBlocksSql, type TrainingBlockRow } from './trainings-sql.js';
import {
  PUBLIC_COACH,
  PUBLIC_TRAINING,
  TRAINING_ORDER,
  isTrainingPublic,
  toTrainingView,
  trainingFields,
  type TrainingRecord,
} from './training-view.js';

/**
 * Условие на тренировки раздела «Тренировки» — `docs/11` 5.2 и решение
 * владельца от 20.10.2026. Только публичные тренировки; фильтры — к самим
 * тренировкам, блоки собираются уже из прошедших.
 *
 * Условия на одно поле (аудитория и возраст, город и язык с их `OR`)
 * складываются через `AND`: иначе второе затёрло бы первое.
 *
 * То же условие в SQL — `trainingsFilterSql` (`trainings-sql.ts`): по нему
 * база считает страницу блоков. Правится одно — правится и другое.
 */
export function trainingsWhere(query: ListTrainingsQuery): Prisma.TrainingWhereInput {
  const and: Prisma.TrainingWhereInput[] = [PUBLIC_TRAINING];

  if (query.audience !== undefined) and.push({ audiences: { hasSome: query.audience } });

  // Возраст ребёнка: тренировка для детей или подростков, которая берёт с
  // этого возраста или младше, либо возраст не указан.
  if (query.age !== undefined) {
    and.push({
      audiences: { hasSome: [...CHILD_AUDIENCES] },
      OR: [{ kidsFromAge: null }, { kidsFromAge: { lte: query.age } }],
    });
  }

  // Город клуба у клубной тренировки, иначе — город страницы тренера.
  if (query.cityId !== undefined) {
    and.push({
      OR: [
        { clubId: { not: null }, club: { is: { cityId: { in: query.cityId } } } },
        { clubId: null, coach: { is: { cityId: { in: query.cityId } } } },
      ],
    });
  }

  // Расписание по дням (T3): день и время суток — у одного и того же
  // занятия. Тренировка без занятий под такие фильтры не попадает.
  const slot: Prisma.TrainingSlotWhereInput[] = [];

  if (query.day !== undefined) slot.push({ weekday: { in: query.day } });

  if (query.time !== undefined) {
    slot.push({
      OR: query.time.map((time) => {
        const [from, to] = TIME_OF_DAY_BOUNDS[time];

        return { startMin: { gte: from, lt: to } };
      }),
    });
  }

  if (slot.length > 0) and.push({ slots: { some: { AND: slot } } });

  // Идёт набор: есть места или мало мест.
  if (query.open === true) and.push({ enrollment: { in: ['OPEN', 'FEW'] } });

  // Язык — тренера. У клубной тренировки — только подтверждённого и
  // опубликованного: без него язык не проверить, и она не проходит.
  if (query.language !== undefined) {
    const languages = { languages: { has: query.language } };

    and.push({
      OR: [
        { author: 'COACH', coach: { is: languages } },
        { author: 'CLUB', link: 'CONFIRMED', coach: { is: { ...PUBLIC_COACH, ...languages } } },
      ],
    });
  }

  return {
    ...(query.kind === undefined ? {} : { kind: { in: query.kind } }),
    ...(query.place === undefined ? {} : { place: { in: query.place } }),
    ...(query.clubId === undefined ? {} : { clubId: query.clubId }),
    // Без цены — «по договорённости»: под «цену до» такая не подходит.
    ...(query.priceTo === undefined ? {} : { priceKzt: { not: null, lte: query.priceTo } }),
    AND: and,
  };
}

/** Клубные строки списка впереди тренерских: клуб ведёт свою страницу сам. */
function clubFirst(a: TrainingRecord, b: TrainingRecord): number {
  return a.author === b.author ? 0 : a.author === 'CLUB' ? -1 : 1;
}

/**
 * Тренировки — своя сущность (решение владельца от 20.10.2026): их заводит
 * тренер или клуб, вторая сторона подтверждает связь. Здесь — то, что
 * касается клуба и связи: тренировки клуба, подтверждение и отказ, общий
 * список блоками. Свои тренировки тренер правит на своей странице
 * (`CoachesService.setTrainings`).
 */
@Injectable()
export class TrainingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Раздел «Тренировки» блоками по месту. Страница считает блоки, а не
   * тренировки: блок клуба не рвётся между страницами. Какие блоки на
   * странице и сколько их всего, решает база (`trainingBlocksSql`); затем
   * читаются тренировки только этих блоков — с тем же условием, так что
   * ставшая за это время непубличной на страницу не попадёт. Блоки из них
   * собирает `groupTrainings`, порядок — как у страницы из базы.
   */
  async list(query: ListTrainingsQuery): Promise<Page<TrainingGroupView>> {
    const blocks = await this.prisma.$queryRaw<TrainingBlockRow[]>(trainingBlocksSql(query));
    const total = blocks[0]?.total ?? 0;
    // Номер блока на странице — по любой его тренировке.
    const position = new Map(
      blocks.flatMap((block, index) => (block.ids ?? []).map((id) => [id, index] as const)),
    );

    if (position.size === 0) return pageOf([], total, query);

    const rows = await this.prisma.training.findMany({
      where: { AND: [trainingsWhere(query), { id: { in: [...position.keys()] } }] },
      select: trainingFields,
      // Первое написание зала — у самой ранней тренировки, как в базе.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const at = (group: TrainingGroupView) => position.get(group.trainings[0]?.id ?? '') ?? 0;

    return pageOf(
      groupTrainings(rows).sort((a, b) => at(a) - at(b)),
      total,
      query,
    );
  }

  /**
   * Страница тренировки — «Подробнее». Видимость и маскировка — как в
   * списке; автор, вторая сторона и администратор видят её и непубличной,
   * как есть. Остальным непубличная не существует — как чужой адрес.
   *
   * `more` — другие публичные тренировки того же владельца (`trainingOwner`):
   * у клубной — тренировки клуба, у тренерской — тренера. Публичные и
   * замаскированные для всех: это витрина, а не кабинет.
   */
  async detail(id: string, viewerId: string | undefined): Promise<TrainingDetailView> {
    const training = await this.prisma.training.findUnique({
      where: { id },
      select: trainingFields,
    });

    if (training === null) throw trainingNotFound(id);

    const party = viewerId !== undefined && (await this.isParty(training, viewerId));

    if (!party && !isTrainingPublic(training)) throw trainingNotFound(id);

    const owner: Prisma.TrainingWhereInput =
      training.author === 'CLUB'
        ? { author: 'CLUB', clubId: training.clubId }
        : { author: 'COACH', coachId: training.coachId };
    const more = await this.prisma.training.findMany({
      where: { AND: [PUBLIC_TRAINING, owner, { id: { not: id } }] },
      select: trainingFields,
      orderBy: [...TRAINING_ORDER],
      take: TRAINING_MORE_MAX,
    });

    return {
      ...toTrainingView(training, party),
      more: more.map((row) => toTrainingView(row, false)),
    };
  }

  /** «Тренировки в клубе» на странице клуба: свои и подтверждённые тренерские. */
  async forClub(clubId: string): Promise<TrainingView[]> {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { hiddenAt: true },
    });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { id: clubId });
    }

    // Скрытый клуб из каталога ушёл — его тренировки тоже.
    if (club.hiddenAt !== null) return [];

    const rows = await this.prisma.training.findMany({
      where: {
        clubId,
        OR: [
          { author: 'CLUB' },
          { author: 'COACH', link: 'CONFIRMED', coach: { is: PUBLIC_COACH } },
        ],
      },
      select: trainingFields,
      orderBy: [...TRAINING_ORDER],
    });

    return rows.sort(clubFirst).map((training) => toTrainingView(training, false));
  }

  /** Тренировки в кабинете клуба: свои, входящие от тренеров и подтверждённые тренерские. */
  async manage(clubId: string): Promise<ClubTrainingsManageView> {
    const rows = await this.prisma.training.findMany({
      where: { clubId },
      select: trainingFields,
      orderBy: [...TRAINING_ORDER],
    });
    const pick = (author: 'COACH' | 'CLUB', link?: TrainingLink) =>
      rows
        .filter((row) => row.author === author && (link === undefined || row.link === link))
        .map((row) => toTrainingView(row, true));

    return {
      trainings: pick('CLUB'),
      requests: pick('COACH', 'PENDING'),
      coachTrainings: pick('COACH', 'CONFIRMED'),
    };
  }

  /**
   * Тренировки клуба целиком: место — сам клуб. Тренер — только с
   * опубликованной страницей; указан — ждёт его подтверждения. Строка с
   * `id` и тем же тренером сохраняет связь, в том числе отказ.
   */
  async setClubTrainings(
    clubId: string,
    input: SetClubTrainingsInput,
  ): Promise<ClubTrainingsManageView> {
    const coachIds = input.trainings.map((row) => row.coachId ?? null);
    const wanted = coachIds.flatMap((coachId) => (coachId === null ? [] : [coachId]));
    const [stored, coaches] = await Promise.all([
      this.prisma.training.findMany({
        where: { clubId, author: 'CLUB' },
        select: { id: true, coachId: true, link: true, linkAt: true, createdAt: true },
      }),
      wanted.length === 0
        ? Promise.resolve([])
        : this.prisma.coach.findMany({
            where: { id: { in: [...new Set(wanted)] }, ...PUBLIC_COACH },
            select: { id: true },
          }),
    ]);
    const open = new Set(coaches.map((coach) => coach.id));
    const unknown = coachIds.findIndex((coachId) => coachId !== null && !open.has(coachId));

    if (unknown !== -1) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Coach is unknown or not published', {
        field: `trainings.${String(unknown)}.coachId`,
      });
    }

    const byId = new Map(stored.map((training) => [training.id, training]));
    const data = input.trainings.map((row, index) => {
      const coachId = row.coachId ?? null;
      const previous = row.id === undefined ? undefined : byId.get(row.id);
      const fields = {
        author: 'CLUB' as const,
        booking: 'CLUB' as const,
        clubId,
        coachId,
        ...keptLink(
          previous && { partner: previous.coachId, link: previous.link, linkAt: previous.linkAt },
          coachId,
        ),
        kind: row.kind,
        audiences: row.audiences,
        kidsFromAge: row.kidsFromAge ?? null,
        place: 'CLUB' as const,
        title: row.title,
        schedule: row.schedule ?? null,
        priceKzt: row.priceKzt ?? null,
        unit: row.unit,
        note: row.note ?? null,
        description: row.description ?? null,
        enrollment: row.enrollment ?? null,
        sortOrder: index,
      };

      return previous === undefined
        ? { ...fields, id: rowId(previous) }
        : { ...fields, id: previous.id, createdAt: previous.createdAt };
    });

    // Тренер подтвердил группу и остался в ней — он в штабе клуба (T2).
    const staff = data.flatMap((row) =>
      row.link === 'CONFIRMED' && row.coachId !== null ? [{ clubId, coachId: row.coachId }] : [],
    );

    await this.prisma.$transaction([
      this.prisma.training.deleteMany({ where: { clubId, author: 'CLUB' } }),
      this.prisma.training.createMany({ data }),
      // Свежесть страницы клуба — как при правке цен (ADR-055).
      this.prisma.club.update({ where: { id: clubId }, data: { profileReviewedAt: new Date() } }),
      this.prisma.trainingSlot.createMany({ data: slotRows(data, input.trainings) }),
      ...staffFromTrainings(this.prisma, staff),
    ]);

    return this.manage(clubId);
  }

  /** Вторая сторона подтверждает связь — только ту, что ждёт ответа. */
  async confirm(id: string, userId: string, now = new Date()): Promise<TrainingView> {
    return this.answer(id, userId, ['PENDING'], { link: 'CONFIRMED', linkAt: now });
  }

  /** Отказ или разрыв уже подтверждённой связи. */
  async decline(id: string, userId: string, now = new Date()): Promise<TrainingView> {
    return this.answer(id, userId, ['PENDING', 'CONFIRMED'], { link: 'DECLINED', linkAt: now });
  }

  /**
   * Ответ второй стороны. Условие на статус — в самом обновлении: два
   * одновременных ответа не перепишут друг друга.
   */
  private async answer(
    id: string,
    userId: string,
    from: readonly TrainingLink[],
    data: { link: TrainingLink; linkAt: Date },
  ): Promise<TrainingView> {
    const training = await this.load(id);

    await this.assertSecondSide(training, userId);

    // Подтверждённая связь добавляет тренера в штаб клуба — той же
    // транзакцией (ADR-059, T2). Разрыв связи штаб не трогает.
    const count = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.training.updateMany({
        where: { id, link: { in: [...from] } },
        data,
      });

      if (
        updated.count > 0 &&
        data.link === 'CONFIRMED' &&
        training.clubId !== null &&
        training.coachId !== null
      ) {
        for (const operation of staffFromTrainings(tx, [
          { clubId: training.clubId, coachId: training.coachId },
        ])) {
          await operation;
        }
      }

      return updated.count;
    });

    if (count === 0) {
      const fresh = await this.prisma.training.findUnique({
        where: { id },
        select: { link: true },
      });

      throw new AppError(ERROR_CODES.TRAINING_LINK_INVALID, 'Link does not wait for this answer', {
        link: fresh?.link ?? training.link,
      });
    }

    return toTrainingView(await this.load(id), true);
  }

  /**
   * Вторая сторона: у тренировки тренера — OWNER или ORGANIZER клуба, у
   * клубной — владелец страницы тренера. Администратор — за любую сторону.
   * Автор отвечать за вторую сторону не может: связь он рвёт, убрав её из
   * своего списка.
   */
  private async assertSecondSide(training: TrainingRecord, userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });

    if (user?.isAdmin === true) return;

    if (training.author === 'CLUB' && training.coach?.userId === userId) return;

    if (training.author === 'COACH' && training.clubId !== null) {
      const member = await this.prisma.clubMember.findUnique({
        where: { clubId_userId: { clubId: training.clubId, userId } },
        select: { role: true },
      });

      if (member?.role === 'OWNER' || member?.role === 'ORGANIZER') return;
    }

    throw new AppError(ERROR_CODES.FORBIDDEN, 'Only the other side answers', { id: training.id });
  }

  /**
   * Сторона тренировки — автор или вторая сторона: владелец страницы
   * тренера, OWNER или ORGANIZER клуба. Либо администратор.
   */
  private async isParty(training: TrainingRecord, userId: string): Promise<boolean> {
    if (training.coach?.userId === userId) return true;

    const [user, member] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
      training.clubId === null
        ? Promise.resolve(null)
        : this.prisma.clubMember.findUnique({
            where: { clubId_userId: { clubId: training.clubId, userId } },
            select: { role: true },
          }),
    ]);

    return user?.isAdmin === true || member?.role === 'OWNER' || member?.role === 'ORGANIZER';
  }

  private async load(id: string): Promise<TrainingRecord> {
    const training = await this.prisma.training.findUnique({
      where: { id },
      select: trainingFields,
    });

    if (training === null) throw trainingNotFound(id);

    return training;
  }
}

function trainingNotFound(id: string): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, 'Training not found', { id });
}
