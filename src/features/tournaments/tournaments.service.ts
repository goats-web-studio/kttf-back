import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { checkEligibility } from '@kttf/shared/eligibility';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { findClubCollisions } from '@kttf/shared/brackets';
import { calculateTournamentRating, type TournamentLevel } from '@kttf/shared/rating';
import {
  formatConfigSchema,
  seedingConfigSchema,
  type ClubCollisionView,
  type DrawResult,
  type DrawSwapInput,
  type SeedingConfig,
  type TieDecisionInput,
  type TieDecisionResult,
  type TournamentResultsView,
  type TournamentStandingsView,
} from '@kttf/shared/types';
import type {
  CreateTournamentInput,
  DuplicateTournamentInput,
  ListTournamentsQuery,
  Page,
  RegisterInput,
  RegistrationView,
  TournamentView,
  UpdateRegistrationInput,
  UpdateTournamentInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ScreenEventsService } from '../screen/screen-events.service.js';

import { advanceAfterGroups } from './advance.js';
import { type DrawParticipant, planDraw } from './draw.js';
import { planDrawSwap } from './draw-swap.js';
import {
  buildRatingRun,
  playersWithoutSnapshot,
  unfinishedMatches,
  unresolvedTies,
  withdrawnPlayers,
} from './finish.js';
import { buildResults } from './results.js';
import { buildStandings } from './standings.js';
import { bumpVersion } from './tournament-state.js';
import { writeStage } from './stage-writer.js';
import {
  acceptsRegistrations,
  isDeletable,
  nextStatus,
  type TournamentAction,
} from './tournament-lifecycle.js';
import { toRegistrationView, toStageView, toTournamentView } from './tournaments.mapper.js';
import {
  OCCUPYING_STATUSES,
  playerFields,
  ratingEventFields,
  registrationFields,
  type StageRecord,
  stageFields,
  type TournamentRecord,
  tournamentFields,
} from './tournaments.select.js';

/** Публичный токен второго экрана — 32 символа, ТС 8.3. */
function publicToken(): string {
  return randomBytes(24).toString('base64url').slice(0, 32);
}

@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly screen: ScreenEventsService,
  ) {}

  /**
   * Календарь — ТЗ 9.2, доступен без токена.
   *
   * Черновики видны только тем, кто управляет клубом: иначе замысел
   * организатора становится публичным до того, как он готов его показать.
   */
  async list(query: ListTournamentsQuery, userId?: string): Promise<Page<TournamentView>> {
    const managed = await this.managedClubIds(userId);

    const where = {
      AND: [
        { OR: [{ status: { not: 'DRAFT' as const } }, { clubId: { in: managed } }] },
        ...(query.clubId === undefined ? [] : [{ clubId: query.clubId }]),
        ...(query.status === undefined ? [] : [{ status: query.status }]),
        ...(query.city === undefined ? [] : [{ club: { city: query.city } }]),
        ...(query.from === undefined ? [] : [{ startsAt: { gte: new Date(query.from) } }]),
        ...(query.to === undefined ? [] : [{ startsAt: { lte: new Date(query.to) } }]),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.tournament.findMany({
        where,
        select: tournamentFields,
        orderBy: { startsAt: 'asc' },
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.tournament.count({ where }),
    ]);

    return pageOf(rows.map(toTournamentView), total, query);
  }

  async findById(id: string, userId?: string): Promise<TournamentView> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      select: tournamentFields,
    });

    if (tournament === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Tournament not found', { id });
    }

    if (tournament.status === 'DRAFT' && !(await this.isClubStaff(tournament.clubId, userId))) {
      // Тот же отказ, что и для несуществующего: иначе перебором
      // идентификаторов узнаётся, какие черновики существуют.
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Tournament not found', { id });
    }

    return toTournamentView(tournament);
  }

  async create(input: CreateTournamentInput, userId: string): Promise<TournamentView> {
    await this.assertClubStaff(input.clubId, userId);

    const { startsAt, registrationEndsAt, ...rest } = input;

    const created = await this.prisma.tournament.create({
      data: {
        ...defined(rest),
        startsAt: new Date(startsAt),
        ...(registrationEndsAt === undefined
          ? {}
          : { registrationEndsAt: new Date(registrationEndsAt) }),
        publicToken: publicToken(),
      },
      select: tournamentFields,
    });

    return toTournamentView(created);
  }

  /**
   * Правка турнира.
   *
   * После старта запрещена целиком: схема проведения уже развёрнута в сетку,
   * а планки и ограничения уже отработали при записи участников. Менять их
   * задним числом значит получить состав, не соответствующий условиям.
   */
  async update(id: string, input: UpdateTournamentInput, userId: string): Promise<TournamentView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (tournament.startedAt !== null || tournament.status === 'CANCELLED') {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Started tournament cannot be edited', {
        id,
        status: tournament.status,
      });
    }

    const { startsAt, registrationEndsAt, ...rest } = input;
    const nextStartsAt = startsAt === undefined ? tournament.startsAt : new Date(startsAt);
    const nextDeadline =
      registrationEndsAt === undefined
        ? tournament.registrationEndsAt
        : new Date(registrationEndsAt);

    // Вторая половина пары могла прийти не в этом запросе, а лежать в базе:
    // схема сверяет только заданное, здесь сверяется итог.
    if (nextDeadline !== null && nextDeadline > nextStartsAt) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'Registration deadline is after the start',
        {
          id,
        },
      );
    }

    await this.assertConsistentBounds(id, {
      ratingCapMin: rest.ratingCapMin ?? numberOrNull(tournament.ratingCapMin),
      ratingCapMax: rest.ratingCapMax ?? numberOrNull(tournament.ratingCapMax),
      birthYearFrom: rest.birthYearFrom ?? tournament.birthYearFrom,
      birthYearTo: rest.birthYearTo ?? tournament.birthYearTo,
    });

    const updated = await this.prisma.tournament.update({
      where: { id },
      data: {
        ...defined(rest),
        ...(startsAt === undefined ? {} : { startsAt: nextStartsAt }),
        ...(registrationEndsAt === undefined ? {} : { registrationEndsAt: nextDeadline }),
      },
      select: tournamentFields,
    });

    return toTournamentView(updated);
  }

  /**
   * Удаление — только черновика.
   *
   * Опубликованный турнир уже видели игроки и могли на него записаться.
   * Для него в ТЗ 4.1 есть отдельный переход — отмена.
   */
  async remove(id: string, userId: string): Promise<void> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (!isDeletable(tournament.status)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only a draft can be deleted; cancel it instead', {
        id,
        status: tournament.status,
      });
    }

    await this.prisma.tournament.delete({ where: { id } });
  }

  /**
   * «Повторить прошлый» — ТЗ 4.2.
   *
   * Требование там же: создание типового турнира не дольше 30 секунд.
   * Копируются настройки, но не состояние: новый турнир — черновик со своим
   * публичным токеном и без участников.
   */
  async duplicate(
    id: string,
    input: DuplicateTournamentInput,
    userId: string,
  ): Promise<TournamentView> {
    const source = await this.load(id);

    await this.assertClubStaff(source.clubId, userId);

    const startsAt = new Date(input.startsAt);

    const created = await this.prisma.tournament.create({
      data: {
        clubId: source.clubId,
        name: input.name ?? source.name,
        startsAt,
        // Дедлайн у прошлого турнира привязан к его дате. Переносить его
        // как есть означало бы дедлайн в прошлом у нового турнира.
        registrationEndsAt: null,
        entryFee: source.entryFee,
        maxParticipants: source.maxParticipants,
        ratingCapMax: source.ratingCapMax,
        ratingCapMin: source.ratingCapMin,
        birthYearFrom: source.birthYearFrom,
        birthYearTo: source.birthYearTo,
        genderLimit: source.genderLimit,
        level: source.level,
        tableCount: source.tableCount,
        formatConfig: source.formatConfig ?? {},
        // Пустой посев и отсутствие посева — разные вещи для колонки Json:
        // ключ просто не передаётся, если его нет у образца.
        ...(source.seedingConfig === null ? {} : { seedingConfig: source.seedingConfig }),
        description: source.description,
        prizeInfo: source.prizeInfo,
        publicToken: publicToken(),
      },
      select: tournamentFields,
    });

    return toTournamentView(created);
  }

  /** Переход по жизненному циклу — ТЗ 4.1. */
  async transition(id: string, action: TournamentAction, userId: string): Promise<TournamentView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    const target = nextStatus(tournament.status, action);

    if (target === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Transition is not allowed', {
        id,
        from: tournament.status,
        action,
      });
    }

    const updated = await this.prisma.tournament.update({
      where: { id },
      data: { status: target },
      select: tournamentFields,
    });

    return toTournamentView(updated);
  }

  async listRegistrations(id: string, userId?: string): Promise<readonly RegistrationView[]> {
    await this.findById(id, userId);

    const rows = await this.prisma.registration.findMany({
      where: { tournamentId: id },
      select: registrationFields,
      orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toRegistrationView);
  }

  /**
   * Запись на турнир — ТЗ 4.3.
   *
   * Без `playerId` игрок записывает себя. С `playerId` записывает организатор,
   * и тогда он обязан управлять клубом-хозяином: заявить чужого человека на
   * турнир — не то же самое, что заявиться самому.
   *
   * Статус сразу `CONFIRMED`. Взнос — `[V2]`, а ручная галочка «оплатил»
   * запрещена запретом №5, поэтому из определения ТЗ 4.4 сейчас работает
   * только «допущен». См. ADR-018.
   */
  async register(id: string, input: RegisterInput, userId: string): Promise<RegistrationView> {
    const tournament = await this.load(id);

    if (!acceptsRegistrations(tournament.status)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Registration is not open', {
        id,
        status: tournament.status,
      });
    }

    const deadline = tournament.registrationEndsAt ?? tournament.startsAt;

    if (deadline.getTime() <= Date.now()) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Registration deadline has passed', {
        id,
        deadline: deadline.toISOString(),
      });
    }

    const playerId = await this.resolvePlayer(tournament.clubId, input, userId);

    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: playerFields,
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { playerId });
    }

    const problems = checkEligibility(
      {
        rating: Number(player.rating),
        birthYear: player.birthYear,
        gender: player.gender,
      },
      {
        ratingCapMax: numberOrNull(tournament.ratingCapMax),
        ratingCapMin: numberOrNull(tournament.ratingCapMin),
        birthYearFrom: tournament.birthYearFrom,
        birthYearTo: tournament.birthYearTo,
        genderLimit: tournament.genderLimit,
      },
    );

    if (problems.length > 0) {
      // Все причины сразу: узнавать о следующей после устранения предыдущей
      // человек не должен.
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player is not eligible', {
        playerId,
        problems,
      });
    }

    const existing = await this.prisma.registration.findUnique({
      where: { tournamentId_playerId: { tournamentId: id, playerId } },
      select: { id: true },
    });

    if (existing !== null) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player is already registered', {
        playerId,
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const taken = await tx.registration.count({
        where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
      });

      // Лимит достигнут — в лист ожидания (ТЗ 4.3), а не отказ: место
      // освободится при первой же отмене.
      const full = tournament.maxParticipants !== null && taken >= tournament.maxParticipants;

      return tx.registration.create({
        data: {
          tournamentId: id,
          playerId,
          status: full ? 'WAITLIST' : 'CONFIRMED',
        },
        select: registrationFields,
      });
    });

    return toRegistrationView(created);
  }

  /** Правка участника: статус, вне зачёта, посев — ТС 7.5. */
  async updateRegistration(
    id: string,
    registrationId: string,
    input: UpdateRegistrationInput,
    userId: string,
  ): Promise<RegistrationView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    const registration = await this.loadRegistration(id, registrationId);

    if (
      input.status !== undefined &&
      !isOccupying(registration.status) &&
      isOccupying(input.status)
    ) {
      await this.assertHasRoom(id, tournament.maxParticipants);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.registration.update({
        where: { id: registrationId },
        data: defined(input),
        select: registrationFields,
      });

      if (
        input.status !== undefined &&
        isOccupying(registration.status) &&
        !isOccupying(input.status)
      ) {
        await promoteFromWaitlist(tx, id, tournament.maxParticipants);
      }

      // Снятие участника меняет таблицы: несыгранное уходит соперникам
      // технической победой (ADR-009), и снимок консоли обязан это увидеть.
      await bumpVersion(tx, id);

      return result;
    });

    return toRegistrationView(updated);
  }

  /**
   * Отмена записи — ТЗ 4.3.
   *
   * Игрок снимает себя сам до дедлайна; организатор — пока турнир не начат.
   * После старта запись не удаляется: участник уже в сетке, и его исчезновение
   * поменяло бы уже сыгранные встречи. Для этого есть снятие (`WITHDRAWN`),
   * при котором сыгранное остаётся, а несыгранное уходит соперникам
   * технической победой (ТЗ 4.4, ADR-009).
   */
  async removeRegistration(id: string, registrationId: string, userId: string): Promise<void> {
    const tournament = await this.load(id);
    const registration = await this.loadRegistration(id, registrationId);

    if (tournament.startedAt !== null) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Withdraw the participant instead of deleting', {
        id,
        registrationId,
      });
    }

    const own = await this.isOwnPlayer(registration.playerId, userId);

    if (own) {
      const deadline = tournament.registrationEndsAt ?? tournament.startsAt;

      if (deadline.getTime() <= Date.now()) {
        throw new AppError(ERROR_CODES.FORBIDDEN, 'Registration deadline has passed', { id });
      }
    } else {
      await this.assertClubStaff(tournament.clubId, userId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.registration.delete({ where: { id: registrationId } });

      if (isOccupying(registration.status)) {
        await promoteFromWaitlist(tx, id, tournament.maxParticipants);
      }
    });
  }

  /**
   * Жеребьёвка — ТЗ 5.3.
   *
   * Схемы строит движок из общего кода, здесь только раскладка его вывода по
   * моделям. Повторная жеребьёвка стирает предыдущую целиком: ТЗ 5.3 требует
   * пересчёта при снятии участника до начала, а частичная правка сетки
   * оставила бы встречи, которых в новой расстановке не существует.
   */
  async draw(id: string, userId: string): Promise<DrawResult> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (tournament.status !== 'REG_CLOSED') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Close the registration before the draw', {
        id,
        status: tournament.status,
      });
    }

    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
      select: { seed: true, player: { select: { id: true, rating: true, clubId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const participants: DrawParticipant[] = registrations.map((registration) => ({
      playerId: registration.player.id,
      rating: Number(registration.player.rating),
      clubId: registration.player.clubId,
      seed: registration.seed,
    }));

    const config = formatConfigSchema.parse(tournament.formatConfig);
    const seeding: SeedingConfig | null =
      tournament.seedingConfig === null
        ? null
        : seedingConfigSchema.parse(tournament.seedingConfig);

    // Случайность вносится здесь: сама жеребьёвка обязана оставаться чистой
    // и воспроизводимой по той последовательности, которую ей дали.
    const ordered = seeding?.method === 'RANDOM' ? shuffle(participants) : participants;
    const plan = planDraw(config, ordered, seeding, () => randomUUID());

    await this.prisma.$transaction(async (tx) => {
      await tx.stage.deleteMany({ where: { tournamentId: id } });

      for (const stage of plan.stages) {
        await writeStage(tx, id, stage);
      }

      await bumpVersion(tx, id);
    });

    const stages = await this.loadStages(id);

    // Экран зала показывает сетку сразу после жеребьёвки, а не после старта:
    // до первой встречи зрителю интересно как раз то, кто с кем играет.
    this.screen.changed(id);

    return {
      tournamentId: id,
      stages: stages.map(toStageView),
      // Несведённые одноклубники возвращаются всегда, даже пустым списком:
      // организатор обязан увидеть их здесь, а не в зале (ADR-011).
      clubCollisions: [...plan.clubCollisions],
    };
  }

  /**
   * Ручная корректировка жеребьёвки — ТЗ 5.3.
   *
   * Обмен двумя игроками. Структура остаётся той, которую построил движок:
   * меняются имена в готовых встречах, а не размеры групп и не круги сетки.
   * Полная расстановка одним запросом отвергнута — сервер обязан был бы
   * сверять её со схемой заново, а это второй способ ошибиться (ADR-033).
   */
  async swapDraw(id: string, userId: string, input: DrawSwapInput): Promise<DrawResult> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    // Правится расстановка, а не идущий турнир: после старта переставлять
    // игрока значило бы менять уже сыгранное.
    if (tournament.status !== 'REG_CLOSED') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Adjust the draw before the start', {
        id,
        status: tournament.status,
      });
    }

    const stages = await this.loadStages(id);
    const updates = planDrawSwap(
      stages.flatMap((stage) => stage.matches),
      input.playerAId,
      input.playerBId,
    );

    await this.prisma.$transaction(async (tx) => {
      for (const update of updates) {
        await tx.match.update({
          where: { id: update.id },
          data: { playerAId: update.playerAId, playerBId: update.playerBId },
        });
      }

      await bumpVersion(tx, id);
    });

    const changed = await this.loadStages(id);

    // Экран зала показывает сетку сразу после жеребьёвки: перестановку он
    // обязан увидеть так же, иначе в зале будет висеть прежний состав.
    this.screen.changed(id);

    return {
      tournamentId: id,
      stages: changed.map(toStageView),
      clubCollisions: await this.collisionsOf(id, changed),
    };
  }

  /**
   * Несведённые одноклубники по нынешнему составу групп — ADR-011.
   *
   * Считает движок: после ручной перестановки состав уже не тот, что выдала
   * жеребьёвка, а второе описание правила разошлось бы с первым.
   */
  private async collisionsOf(id: string, stages: StageRecord[]): Promise<ClubCollisionView[]> {
    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id },
      select: { player: { select: { id: true, clubId: true } } },
    });

    const clubOf = new Map(
      registrations.map((registration) => [
        registration.player.id,
        registration.player.clubId ?? undefined,
      ]),
    );

    const groups = stages.flatMap((stage) =>
      toStageView(stage).groups.map((group) => ({
        label: group.label,
        participants: group.participants,
      })),
    );

    // Контракт отдаёт изменяемые массивы, движок — readonly: копия здесь
    // дешевле, чем ослабленный тип в контракте.
    return findClubCollisions(groups, clubOf).map((collision) => ({
      club: collision.club,
      group: collision.group,
      participants: [...collision.participants],
    }));
  }

  /**
   * Старт турнира — ТЗ 4.1 и ТС 5.4.
   *
   * Рейтинги фиксируются здесь и только здесь. Без снимка расчёт зависел бы
   * от порядка обработки встреч, и локальный расчёт консоли разошёлся бы
   * с серверным — приоритет №1 брифа.
   */
  async start(id: string, userId: string): Promise<TournamentView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    const target = nextStatus(tournament.status, 'start');

    if (target === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Transition is not allowed', {
        id,
        from: tournament.status,
        action: 'start',
      });
    }

    const stages = await this.prisma.stage.count({ where: { tournamentId: id } });

    if (stages === 0) {
      // ТЗ 4.1: в «Идёт» переводит не только нажатие, но и сформированные
      // группы. Без них турниру нечего вести.
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Draw the tournament before starting', {
        id,
      });
    }

    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
      select: { id: true, player: { select: { rating: true, ratedMatches: true } } },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const registration of registrations) {
        await tx.registration.update({
          where: { id: registration.id },
          data: {
            status: 'PLAYING',
            ratingAtStart: registration.player.rating,
            matchesAtStart: registration.player.ratedMatches,
          },
        });
      }

      // Версия растёт здесь же: старт меняет и статус, и снимки рейтингов.
      return tx.tournament.update({
        where: { id },
        data: { status: target, startedAt: new Date(), version: { increment: 1 } },
        select: tournamentFields,
      });
    });

    this.screen.changed(id);

    return toTournamentView(updated);
  }

  /**
   * Завершение турнира и рейтинг по итогам — ТЗ 4.1, ТЗ 7.3, ТС 7.5.
   *
   * Два перехода за один вызов, но **двумя транзакциями**. ТЗ 4.1 разводит
   * «Завершён» и «Обсчитан» условием «расчёт рейтинга выполнен успешно»,
   * а ТС 7.5 даёт под них один маршрут. Поэтому первая транзакция закрывает
   * турнир, вторая начисляет рейтинг: упавший расчёт оставляет турнир
   * в «Завершён», и повторный вызов доводит дело до конца, ничего не
   * пересчитывая заново.
   *
   * Начисление идёт против рейтингов, зафиксированных на старте (ТС 5.4),
   * а не против текущих. Сам расчёт — в общем коде: офлайн-консоль обязана
   * получить те же числа тем же кодом (запрет №2 брифа).
   */
  async finish(id: string, userId: string): Promise<TournamentView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (tournament.status === 'RUNNING') {
      await this.closeTournament(id, userId);
    } else if (tournament.status !== 'FINISHED') {
      // Из «Обсчитан» второй раз рейтинг не начисляется: он уже разошёлся
      // по журналу и профилям, и повторный проход удвоил бы его.
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Transition is not allowed', {
        id,
        from: tournament.status,
        action: 'finish',
      });
    }

    const rated = await this.applyRating(id, tournament.level, userId);

    this.screen.changed(id);

    return rated;
  }

  /**
   * Первая транзакция: турнир доигран, места определены, переход в «Завершён».
   *
   * Обе проверки — условия ТЗ 4.1 сверх таблицы переходов. Незавершённое
   * равенство останавливает завершение так же жёстко, как несыгранная
   * встреча: результат турнира — это места, а не набор счетов (ADR-008).
   */
  private async closeTournament(id: string, userId: string): Promise<void> {
    const [stages, registrations] = await Promise.all([
      this.loadStages(id),
      this.prisma.registration.findMany({
        where: { tournamentId: id },
        select: registrationFields,
      }),
    ]);

    const withdrawn = withdrawnPlayers(registrations);
    const unfinished = unfinishedMatches(stages, withdrawn);

    if (unfinished.length > 0) {
      throw new AppError(ERROR_CODES.TOURNAMENT_NOT_COMPLETE, 'Tournament has unplayed matches', {
        id,
        matchIds: unfinished,
      });
    }

    const ties = unresolvedTies(
      buildStandings({ tournamentId: id, stages, withdrawn: [...withdrawn] }),
    );

    if (ties.length > 0) {
      throw new AppError(ERROR_CODES.TIES_UNRESOLVED, 'Some ties are not resolved by referee', {
        id,
        groups: ties,
      });
    }

    const outsiders = playersWithoutSnapshot(stages, registrations);

    if (outsiders.length > 0) {
      throw new AppError(
        ERROR_CODES.RATING_SNAPSHOT_MISSING,
        'Some players have no rating snapshot taken at start',
        { id, playerIds: outsiders },
      );
    }

    await this.prisma.tournament.update({
      where: { id },
      data: { status: 'FINISHED', finishedAt: new Date(), version: { increment: 1 } },
      select: { id: true },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: userId,
        action: 'tournament.finished',
        entityType: 'Tournament',
        entityId: id,
      },
    });
  }

  /**
   * Вторая транзакция: журнал рейтинга, проекции игроков, переход в «Обсчитан».
   *
   * Переход служит и замком: он идёт первым и только из «Завершён», поэтому
   * два одновременных вызова не начислят рейтинг дважды — второй не найдёт
   * турнир в нужном статусе и откатится целиком.
   */
  private async applyRating(
    id: string,
    level: TournamentLevel,
    userId: string,
  ): Promise<TournamentView> {
    const [stages, registrations] = await Promise.all([
      this.loadStages(id),
      this.prisma.registration.findMany({
        where: { tournamentId: id },
        select: registrationFields,
      }),
    ]);

    const run = buildRatingRun(level, registrations, stages);
    const result = calculateTournamentRating(run);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tournament.updateMany({
        where: { id, status: 'FINISHED' },
        data: { status: 'RATED', ratedAt: new Date(), version: { increment: 1 } },
      });

      if (claimed.count === 0) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Transition is not allowed', {
          id,
          action: 'rate',
        });
      }

      await tx.ratingEvent.createMany({
        data: result.events.map((event) => ({
          playerId: event.playerId,
          matchId: event.matchId,
          tournamentId: id,
          type: 'MATCH' as const,
          ratingBefore: event.ratingBefore,
          delta: event.delta,
          ratingAfter: event.ratingAfter,
          opponentRating: event.opponentRating,
          kFactor: event.kFactor,
          tFactor: event.tFactor,
          mFactor: event.mFactor,
          expected: event.expected,
          gapMultiplier: event.gapMultiplier,
          imbalance: event.imbalance,
          clamped: event.clamped,
          createdBy: userId,
        })),
      });

      for (const player of result.players) {
        await tx.player.update({
          where: { id: player.playerId },
          data: {
            rating: player.rating,
            ratedMatches: player.ratedMatches,
            isProvisional: player.isProvisional,
          },
        });
      }

      return toTournamentView(
        await tx.tournament.findUniqueOrThrow({ where: { id }, select: tournamentFields }),
      );
    });
  }

  /**
   * Публичные результаты — ТЗ 9.4. Открыты без токена, как и календарь.
   *
   * Отдаётся то, что дала схема проведения: у круговой нет сетки, у олимпийки
   * нет таблиц, а в «группах плюс сетка» часть участников мест не разыгрывает.
   * Пустая секция здесь — ответ, а не пропуск (ADR-023).
   */
  async results(id: string, userId?: string): Promise<TournamentResultsView> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      select: tournamentFields,
    });

    if (
      tournament === null ||
      (tournament.status === 'DRAFT' && !(await this.isClubStaff(tournament.clubId, userId)))
    ) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Tournament not found', { id });
    }

    const [stages, registrations, events] = await Promise.all([
      this.loadStages(id),
      this.prisma.registration.findMany({
        where: { tournamentId: id },
        select: registrationFields,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.ratingEvent.findMany({
        where: { tournamentId: id },
        select: ratingEventFields,
      }),
    ]);

    const withdrawn = withdrawnPlayers(registrations);

    return buildResults({
      tournament,
      stages,
      registrations,
      standings: buildStandings({ tournamentId: id, stages, withdrawn: [...withdrawn] }),
      events,
    });
  }

  /** Групповые таблицы — ТЗ 6.6. Открыты всем, кому открыт сам турнир. */
  async standings(id: string, userId?: string): Promise<TournamentStandingsView> {
    await this.findById(id, userId);

    const [stages, withdrawn] = await Promise.all([
      this.loadStages(id),
      this.prisma.registration.findMany({
        where: { tournamentId: id, status: { in: ['WITHDRAWN', 'NO_SHOW'] } },
        select: { playerId: true },
      }),
    ]);

    return buildStandings({
      tournamentId: id,
      stages,
      withdrawn: withdrawn.map((registration) => registration.playerId),
    });
  }

  /**
   * Решение судьи по равенству в таблице — ADR-008.
   *
   * Движок жребия не бросает: он применяет правила 1–5 ТЗ 6.6 и возвращает
   * неразрешённые группы равенства. Порядок внутри такой группы называет
   * судья, и решение сохраняется как данные — так расчёт остаётся чистым
   * и одинаковым в консоли и на сервере.
   *
   * Разрешённое равенство может открыть следующий этап: пока места в зоне
   * выхода неизвестны, плей-офф сеять нечем.
   */
  async resolveTie(
    id: string,
    input: TieDecisionInput,
    userId: string,
  ): Promise<TieDecisionResult> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (tournament.status !== 'RUNNING') {
      throw new AppError(ERROR_CODES.TOURNAMENT_NOT_RUNNING, 'Tournament is not running', {
        id,
        status: tournament.status,
      });
    }

    const group = await this.prisma.group.findUnique({
      where: { id: input.groupId },
      select: { id: true, stage: { select: { tournamentId: true } } },
    });

    if (group?.stage.tournamentId !== id) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Group not found', { groupId: input.groupId });
    }

    const before = await this.standings(id, userId);
    assertResolvesTie(before, input);

    const next = await this.prisma.$transaction(async (tx) => {
      await tx.tieDecision.create({
        data: {
          groupId: input.groupId,
          orderedIds: [...input.orderedIds],
          decidedBy: userId,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      });

      const advanced = await advanceAfterGroups(tx, id);

      await bumpVersion(tx, id);

      return advanced;
    });

    const stage =
      next.stageId === null
        ? null
        : await this.prisma.stage.findUnique({ where: { id: next.stageId }, select: stageFields });

    this.screen.changed(id);

    return {
      standings: await this.standings(id, userId),
      nextStage: stage === null ? null : toStageView(stage),
      blockedByTies: [...next.blockedByTies],
    };
  }

  private async loadStages(id: string): Promise<StageRecord[]> {
    return this.prisma.stage.findMany({
      where: { tournamentId: id },
      select: stageFields,
      orderBy: { order: 'asc' },
    });
  }

  // ---------- вспомогательное ----------

  private async load(id: string): Promise<TournamentRecord> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      select: tournamentFields,
    });

    if (tournament === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Tournament not found', { id });
    }

    return tournament;
  }

  private async loadRegistration(
    tournamentId: string,
    registrationId: string,
  ): Promise<{ id: string; status: string; playerId: string }> {
    const registration = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      select: { id: true, status: true, playerId: true, tournamentId: true },
    });

    if (registration?.tournamentId !== tournamentId) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Registration not found', {
        tournamentId,
        registrationId,
      });
    }

    return registration;
  }

  /** Клубы, которыми человек управляет. Судья сюда не входит — ADR-014. */
  private async managedClubIds(userId?: string): Promise<string[]> {
    if (userId === undefined) return [];

    const memberships = await this.prisma.clubMember.findMany({
      where: { userId, role: { in: ['OWNER', 'ORGANIZER'] } },
      select: { clubId: true },
    });

    return memberships.map((membership) => membership.clubId);
  }

  private async isClubStaff(clubId: string, userId?: string): Promise<boolean> {
    if (userId === undefined) return false;

    const membership = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } },
      select: { role: true },
    });

    return membership !== null && (membership.role === 'OWNER' || membership.role === 'ORGANIZER');
  }

  private async assertClubStaff(clubId: string, userId: string): Promise<void> {
    if (await this.isClubStaff(clubId, userId)) return;

    // Судья турнир не ведёт: по ТЗ 1 его доступ — консоль конкретного турнира.
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not allowed to manage this club', { clubId });
  }

  private async isOwnPlayer(playerId: string, userId: string): Promise<boolean> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { userId: true },
    });

    return player?.userId === userId;
  }

  private async resolvePlayer(
    clubId: string,
    input: RegisterInput,
    userId: string,
  ): Promise<string> {
    if (input.playerId === undefined) {
      const own = await this.prisma.player.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (own === null) {
        // Профиль заполняется отдельным шагом — ТЗ 2.2, ADR-013.
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player profile is required to register');
      }

      return own.id;
    }

    if (await this.isOwnPlayer(input.playerId, userId)) {
      return input.playerId;
    }

    await this.assertClubStaff(clubId, userId);

    return input.playerId;
  }

  private async assertHasRoom(tournamentId: string, maxParticipants: number | null): Promise<void> {
    if (maxParticipants === null) return;

    const taken = await this.prisma.registration.count({
      where: { tournamentId, status: { in: OCCUPYING_STATUSES } },
    });

    if (taken >= maxParticipants) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Tournament is full', { tournamentId });
    }
  }

  private async assertConsistentBounds(
    id: string,
    bounds: {
      ratingCapMin: number | null;
      ratingCapMax: number | null;
      birthYearFrom: number | null;
      birthYearTo: number | null;
    },
  ): Promise<void> {
    const inverted =
      (bounds.ratingCapMin !== null &&
        bounds.ratingCapMax !== null &&
        bounds.ratingCapMin > bounds.ratingCapMax) ||
      (bounds.birthYearFrom !== null &&
        bounds.birthYearTo !== null &&
        bounds.birthYearFrom > bounds.birthYearTo);

    if (inverted) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Bounds are inverted', { id });
    }

    return Promise.resolve();
  }
}

function isOccupying(status: string): boolean {
  return (OCCUPYING_STATUSES as readonly string[]).includes(status);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Первый из листа ожидания занимает освободившееся место.
 *
 * Без этого список бесполезен: организатору пришлось бы следить за ним руками
 * ровно тогда, когда он занят турниром. Очередь — по времени записи.
 */
async function promoteFromWaitlist(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  maxParticipants: number | null,
): Promise<void> {
  if (maxParticipants === null) return;

  const taken = await tx.registration.count({
    where: { tournamentId, status: { in: OCCUPYING_STATUSES } },
  });

  if (taken >= maxParticipants) return;

  const next = await tx.registration.findFirst({
    where: { tournamentId, status: 'WAITLIST' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (next === null) return;

  await tx.registration.update({ where: { id: next.id }, data: { status: 'CONFIRMED' } });
}

/** Перемешивание для случайного посева. Криптостойкое — своего велосипеда не надо. */
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index + 1);
    const left = result[index];
    const right = result[swap];

    if (left !== undefined && right !== undefined) {
      result[index] = right;
      result[swap] = left;
    }
  }

  return result;
}

/**
 * Решение обязано относиться к настоящему равенству.
 *
 * Иначе судья мог бы переставить любые строки таблицы, а места — расчётная
 * величина, а не мнение. Порядок внутри равенства он назначает, само равенство
 * определяет движок.
 */
function assertResolvesTie(standings: TournamentStandingsView, input: TieDecisionInput): void {
  const group = standings.groups.find((candidate) => candidate.groupId === input.groupId);
  const proposed = [...input.orderedIds].sort();

  const matches = group?.unresolved.some((tie) => {
    const participants = [...tie.participants].sort();

    return (
      participants.length === proposed.length &&
      participants.every((participant, index) => participant === proposed[index])
    );
  });

  if (matches !== true) {
    throw new AppError(
      ERROR_CODES.TIE_DECISION_INVALID,
      'No unresolved tie matches this decision',
      { groupId: input.groupId, orderedIds: input.orderedIds },
    );
  }
}
