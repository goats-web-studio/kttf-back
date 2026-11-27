import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { checkEligibility } from '@kttf/shared/eligibility';
import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { findClubCollisions, scheduleRoundRobin } from '@kttf/shared/brackets';
import {
  calculateTournamentRating,
  NOVICE_TOURNAMENTS,
  type RatingEventDraft,
} from '@kttf/shared/rating';
import {
  formatConfigSchema,
  seedingConfigSchema,
  type ClubCollisionView,
  type FormatConfig,
  type DrawResult,
  type DrawMoveInput,
  type DrawNewGroupInput,
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
  ReplaceRegistrationInput,
  SetRegistrationCoachInput,
  TournamentListItemView,
  TournamentView,
  UpdateRegistrationInput,
  UpdateTournamentInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { assertCoachExists } from '../players/coach-ref.js';
import { ScreenEventsService } from '../screen/screen-events.service.js';

import { advanceAfterGroups } from './advance.js';
import { type DrawParticipant, planDraw } from './draw.js';
import { planDrawSwap } from './draw-swap.js';
import {
  type EditableGroup,
  type GroupEdit,
  planDisband,
  planMove,
  planNewGroup,
} from './draw-edit.js';
import {
  buildRatingRun,
  playersWithoutSnapshot,
  unfinishedMatches,
  unresolvedTies,
  withdrawnPlayers,
} from './finish.js';
import { buildResults } from './results.js';
import { buildStandings } from './standings.js';
import { matchSetsToWin, stageLengths } from './stage-config.js';
import { bumpVersion } from './tournament-state.js';
import { writeStage } from './stage-writer.js';
import {
  acceptsRegistrations,
  isCoachEditable,
  isDeletable,
  nextStatus,
  type TournamentAction,
} from './tournament-lifecycle.js';
import { toRegistrationView, toStageView, toTournamentView } from './tournaments.mapper.js';
import { placeLateEntry } from './late-entry.js';
import { settleWithdrawals, withdrawalOrder } from './withdrawal.js';
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

/** Живая заявка: игрок в составе или ждёт решения. */
const ACTIVE_ENTRY = ['REGISTERED', 'PENDING', 'WAITLIST', 'CONFIRMED', 'PLAYING'] as const;

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
  async list(query: ListTournamentsQuery, userId?: string): Promise<Page<TournamentListItemView>> {
    const managed = await this.managedClubIds(userId);

    const where = {
      AND: [
        { OR: [{ status: { not: 'DRAFT' as const } }, { clubId: { in: managed } }] },
        ...(query.clubId === undefined ? [] : [{ clubId: query.clubId }]),
        // «Мои турниры» (ADR-048): заявка жива — не снята и не отклонена.
        ...(query.playerId === undefined
          ? []
          : [
              {
                registrations: {
                  some: { playerId: query.playerId, status: { in: [...ACTIVE_ENTRY] } },
                },
              },
            ]),
        // Несколько статусов — любой из них (ADR-051): «Завершён» в календаре —
        // это и доигранные, и обсчитанные.
        ...(query.status === undefined ? [] : [{ status: { in: query.status } }]),
        // Несколько городов — любой из них; область раскрывает клиент (ADR-096).
        ...(query.cityId === undefined ? [] : [{ club: { cityId: { in: query.cityId } } }]),
        ...(query.from === undefined ? [] : [{ startsAt: { gte: new Date(query.from) } }]),
        ...(query.to === undefined ? [] : [{ startsAt: { lte: new Date(query.to) } }]),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.tournament.findMany({
        where,
        select: {
          ...tournamentFields,
          // Сыгранные встречи считает база — как и участников (ADR-052).
          _count: {
            select: {
              ...tournamentFields._count.select,
              matches: { where: { setsA: { not: null } } },
            },
          },
        },
        // Ровный порядок при равной дате: иначе турниры одного часа
        // переставлялись бы между страницами.
        orderBy: [{ startsAt: query.order }, { id: query.order }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.tournament.count({ where }),
    ]);

    const averages = await this.fieldAverages(rows);

    return pageOf(
      rows.map((row) => ({
        ...toTournamentView(row),
        averageRating: averages.get(row.id)?.rating ?? null,
        averageAge: averages.get(row.id)?.age ?? null,
        matchesPlayed: row._count.matches,
      })),
      total,
      query,
    );
  }

  /**
   * Средний рейтинг участников страницы одним запросом — ADR-052.
   *
   * У начатого турнира — рейтинг на старте: он и шёл в расчёт. У будущего
   * снимка ещё нет, берётся нынешний рейтинг записанного. Снятые и
   * отклонённые заявки в поле не входят. Округление до целого: это мера
   * силы поля, а не чей-то рейтинг.
   *
   * Средний возраст — ADR-094: год турнира минус год рождения, как при
   * допуске в категорию, тоже до целого.
   */
  private async fieldAverages(
    tournaments: readonly { id: string; startsAt: Date }[],
  ): Promise<Map<string, { rating: number; age: number }>> {
    const ids = tournaments.map((tournament) => tournament.id);
    const yearOf = new Map(
      tournaments.map((tournament) => [tournament.id, tournament.startsAt.getUTCFullYear()]),
    );

    if (ids.length === 0) {
      return new Map();
    }

    const entries = await this.prisma.registration.findMany({
      where: { tournamentId: { in: [...ids] }, status: { in: OCCUPYING_STATUSES } },
      select: {
        tournamentId: true,
        ratingAtStart: true,
        player: { select: { rating: true, birthYear: true } },
      },
    });
    const sums = new Map<string, { sum: Prisma.Decimal; ages: number; count: number }>();

    for (const entry of entries) {
      const rating = entry.ratingAtStart ?? entry.player.rating;
      const current = sums.get(entry.tournamentId) ?? {
        sum: new Prisma.Decimal(0),
        ages: 0,
        count: 0,
      };
      const age = (yearOf.get(entry.tournamentId) ?? 0) - entry.player.birthYear;
      // Через строку: Decimal из базы складывается точно, а значение другого
      // вида (заглушка, число из соседнего кода) не роняет календарь.
      sums.set(entry.tournamentId, {
        sum: current.sum.plus(rating.toString()),
        ages: current.ages + age,
        count: current.count + 1,
      });
    }

    return new Map(
      [...sums].map(([id, { sum, ages, count }]) => [
        id,
        {
          rating: sum.dividedBy(count).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
          age: Math.max(0, Math.round(ages / count)),
        },
      ]),
    );
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
   * После старта — только то, что зал меняет по ходу (`updateRunning`): схема
   * проведения уже развёрнута в сетку, а планки и ограничения уже отработали
   * при записи участников. Менять их задним числом значит получить состав,
   * не соответствующий условиям. После завершения не правится ничего.
   */
  async update(id: string, input: UpdateTournamentInput, userId: string): Promise<TournamentView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (tournament.status === 'RUNNING') return this.updateRunning(tournament, input);

    if (tournament.startedAt !== null || tournament.status === 'CANCELLED') {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Started tournament cannot be edited', {
        id,
        status: tournament.status,
      });
    }

    const { startsAt, registrationEndsAt, seedingConfig, ...rest } = input;
    const nextStartsAt = startsAt === undefined ? tournament.startsAt : new Date(startsAt);
    // `null` — дедлайн стёрт (ADR-044): запись идёт до начала турнира.
    const nextDeadline =
      registrationEndsAt === undefined
        ? tournament.registrationEndsAt
        : registrationEndsAt === null
          ? null
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

    // Не пришедшее в запросе берётся из базы, а `null` — стёртая граница,
    // и подставлять вместо неё прежнее значение нельзя.
    await this.assertConsistentBounds(id, {
      ratingCapMin: orStored(rest.ratingCapMin, numberOrNull(tournament.ratingCapMin)),
      ratingCapMax: orStored(rest.ratingCapMax, numberOrNull(tournament.ratingCapMax)),
      birthYearFrom: orStored(rest.birthYearFrom, tournament.birthYearFrom),
      birthYearTo: orStored(rest.birthYearTo, tournament.birthYearTo),
    });

    // Жеребьёвка разложена по прежней схеме: после смены групп или сетки она
    // перестала бы соответствовать настройкам турнира, и до старта проще всего
    // жеребить заново (ТЗ 5.3). Длины встреч и распределение по финалам
    // (ADR-124) группы не трогают: расстановка, поправленная руками, остаётся.
    const format =
      rest.formatConfig === undefined
        ? 'NONE'
        : formatChangeOf(formatConfigSchema.parse(tournament.formatConfig), rest.formatConfig);
    const seedingChanged =
      seedingConfig !== undefined &&
      JSON.stringify(canonical(seedingConfig)) !==
        JSON.stringify(canonical(tournament.seedingConfig));
    const resetsDraw = format === 'STRUCTURE' || seedingChanged;

    if (format === 'NEXT_STAGE' && rest.formatConfig !== undefined) {
      assertAdvancing(await this.loadStages(id), rest.formatConfig);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (resetsDraw) {
        await tx.stage.deleteMany({ where: { tournamentId: id } });
      } else if (rest.formatConfig !== undefined && format !== 'NONE') {
        await this.applyLengths(tx, id, rest.formatConfig);
        await syncAdvance(tx, id, rest.formatConfig);
      }

      // Лимит подняли или сняли — ждали восемь, пришли шестнадцать: лист
      // ожидания поднимается сам, по времени записи, а не по одному руками.
      if (rest.maxParticipants !== undefined) {
        await lockRegistrations(tx, id);

        const lifted = await promoteAllFromWaitlist(tx, id, rest.maxParticipants);

        if (lifted > 0) await resetDraw(tx, id);
      }

      return tx.tournament.update({
        where: { id },
        data: {
          ...defined(rest),
          ...(startsAt === undefined ? {} : { startsAt: nextStartsAt }),
          ...(registrationEndsAt === undefined ? {} : { registrationEndsAt: nextDeadline }),
          ...(seedingConfig === undefined ? {} : { seedingConfig: seedingConfig ?? Prisma.DbNull }),
          ...(resetsDraw ? { version: { increment: 1 } } : {}),
        },
        select: tournamentFields,
      });
    });

    return toTournamentView(updated);
  }

  /**
   * Правка идущего турнира — ADR-061.
   *
   * Сломался стол, освободился соседний зал, турнир затянулся и финал хотят
   * играть до трёх побед вместо четырёх — это решается по ходу, без сброса
   * жеребьёвки. Поэтому меняются только число столов, описание и длины встреч,
   * а остальное отвергается, как и раньше.
   *
   * - Стол убрать нельзя, пока за ним играют.
   * - Длина меняется только у встреч, которые ещё не начаты: длину каждой
   *   встречи этапа до и после правки считает одно правило
   *   (`matchSetsToWin`), и начатые встречи, где она разошлась бы, называются
   *   в отказе. Новая длина ложится и в схему турнира (её читает офлайн-
   *   консоль), и в этапы (их читает сервер, ADR-044).
   */
  private async updateRunning(
    tournament: TournamentRecord,
    input: UpdateTournamentInput,
  ): Promise<TournamentView> {
    const { tableCount, description, formatConfig, seedingConfig, ...rest } = input;
    const locked = Object.keys(defined(rest));
    const current = formatConfigSchema.parse(tournament.formatConfig);

    // Схема или посев другие — пришло не столько, сколько ждали (ADR-101).
    // Пока ни одна встреча не начата, жеребьёвка строится заново.
    // Распределение по финалам — сколько выходит из группы, сетка за места,
    // за третье, на все места — меняется, пока следующий этап не начат
    // (ADR-124, у RTTF «Изменить распределение игроков по финалам»). Группы
    // при этом не трогаются, даже если в них уже играют.
    if (
      locked.length === 0 &&
      seedingConfig === undefined &&
      formatConfig !== undefined &&
      formatChangeOf(current, formatConfig) === 'NEXT_STAGE'
    ) {
      return this.changeNextStage(tournament, formatConfig, defined({ tableCount, description }));
    }

    const reshaped =
      (formatConfig !== undefined && !sameExceptLengths(current, formatConfig)) ||
      seedingConfig !== undefined;

    if (locked.length === 0 && reshaped) {
      return this.redrawRunning(tournament, {
        formatConfig: formatConfig ?? current,
        ...(seedingConfig === undefined ? {} : { seedingConfig }),
        ...defined({ tableCount, description }),
      });
    }

    if (locked.length > 0 || reshaped) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Only tables, description and lengths change', {
        id: tournament.id,
        fields: formatConfig === undefined ? locked : [...locked, 'formatConfig'],
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (tableCount !== undefined && tableCount < tournament.tableCount) {
        const busy = await tx.match.findFirst({
          where: {
            tournamentId: tournament.id,
            status: 'PLAYING',
            tableNumber: { gt: tableCount },
          },
          select: { id: true, tableNumber: true },
        });

        if (busy !== null) {
          throw new AppError(ERROR_CODES.TABLE_BUSY, 'A match is playing at a removed table', {
            tableNumber: busy.tableNumber,
            matchId: busy.id,
          });
        }
      }

      if (formatConfig !== undefined) {
        await this.applyLengths(tx, tournament.id, formatConfig);
      }

      return tx.tournament.update({
        where: { id: tournament.id },
        data: {
          ...defined({ tableCount, description, formatConfig }),
          version: { increment: 1 },
        },
        select: tournamentFields,
      });
    });

    // Экран зала рисует столы по их числу: правка обязана доехать до зала.
    this.screen.changed(tournament.id);

    return toTournamentView(updated);
  }

  /**
   * Распределение по финалам у идущего турнира — ADR-124.
   *
   * Следующий этап ещё не начат: он сносится и, если группы уже доиграны,
   * строится заново по новому распределению. Начат — отказ: у вышедших уже
   * есть результаты, и переложить их некуда.
   */
  private async changeNextStage(
    tournament: TournamentRecord,
    formatConfig: FormatConfig,
    extra: { readonly tableCount?: number; readonly description?: string | null },
  ): Promise<TournamentView> {
    const id = tournament.id;
    const stages = await this.loadStages(id);
    const later = stages.filter((stage) => stage.order > 0);

    assertAdvancing(stages, formatConfig);
    for (const stage of later) assertStageNotStarted(stage);

    const updated = await this.prisma.$transaction(async (tx) => {
      await assertStagesStillOpen(
        tx,
        later.map((stage) => stage.id),
      );

      if (later.length > 0) {
        await tx.stage.deleteMany({ where: { id: { in: later.map((stage) => stage.id) } } });
      }

      await tx.tournament.update({ where: { id }, data: { formatConfig, ...extra } });
      await this.applyLengths(tx, id, formatConfig);
      await syncAdvance(tx, id, formatConfig);
      await advanceAfterGroups(tx, id);
      await settleWithdrawals(tx, id);
      await bumpVersion(tx, id);

      return tx.tournament.findUniqueOrThrow({ where: { id }, select: tournamentFields });
    });

    this.screen.changed(id);

    return toTournamentView(updated);
  }

  /**
   * Другая схема у идущего турнира — ADR-101.
   *
   * Записалось 32, пришли 4: схема на группы не подходит, а старт уже нажат.
   * Пока ни одна встреча не вызвана к столу и не сыграна, отменять старт
   * незачем — жеребьёвка строится заново по новой схеме из тех, кто играет.
   * Посев — по рейтингу на старте: снимок уже сделан (ТС 5.4), и новый
   * расклад обязан опираться на те же числа, что и рейтинг турнира.
   */
  private async redrawRunning(
    tournament: TournamentRecord,
    change: {
      readonly formatConfig: FormatConfig;
      readonly seedingConfig?: SeedingConfig | null;
      readonly tableCount?: number;
      readonly description?: string | null;
    },
  ): Promise<TournamentView> {
    const id = tournament.id;
    const seeding =
      change.seedingConfig !== undefined
        ? change.seedingConfig
        : tournament.seedingConfig === null
          ? null
          : seedingConfigSchema.parse(tournament.seedingConfig);

    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
      select: {
        seed: true,
        ratingAtStart: true,
        player: { select: { id: true, rating: true, clubId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const participants: DrawParticipant[] = registrations.map((registration) => ({
      playerId: registration.player.id,
      rating: Number(registration.ratingAtStart ?? registration.player.rating),
      clubId: registration.player.clubId,
      seed: registration.seed,
    }));
    const ordered = seeding?.method === 'RANDOM' ? shuffle(participants) : participants;
    const plan = planDraw(change.formatConfig, ordered, seeding, () => randomUUID());

    const updated = await this.prisma.$transaction(async (tx) => {
      // Проверка внутри транзакции: судья мог вызвать пару, пока организатор
      // выбирал схему. Начатая или сыгранная встреча — уже история турнира.
      const started = await tx.match.findFirst({
        where: {
          tournamentId: id,
          OR: [{ status: { in: ['PLAYING', 'FINISHED'] } }, { setsA: { not: null } }],
        },
        select: { id: true },
      });

      if (started !== null) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          'The format changes only before the first match',
          { id, matchId: started.id, reason: 'MATCH_STARTED' },
        );
      }

      await tx.stage.deleteMany({ where: { tournamentId: id } });

      for (const stage of plan.stages) {
        await writeStage(tx, id, stage);
      }

      return tx.tournament.update({
        where: { id },
        data: {
          formatConfig: change.formatConfig,
          ...(change.seedingConfig === undefined
            ? {}
            : { seedingConfig: change.seedingConfig ?? Prisma.DbNull }),
          ...defined({ tableCount: change.tableCount, description: change.description }),
          version: { increment: 1 },
        },
        select: tournamentFields,
      });
    });

    // Экран зала и консоль показывают группы и очередь — новый расклад
    // обязан доехать до зала сразу.
    this.screen.changed(id);

    return toTournamentView(updated);
  }

  /** Новые длины — в этапы, если ни одна начатая встреча от этого не меняется. */
  private async applyLengths(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    format: FormatConfig,
  ): Promise<void> {
    const stages = await tx.stage.findMany({ where: { tournamentId }, select: stageFields });
    const changes: { id: string; config: Record<string, unknown> }[] = [];
    const lockedMatches: string[] = [];

    for (const stage of stages) {
      const before = asRecord(stage.config);
      // Длины по кругам целиком из новой схемы: стёртые там стираются и здесь.
      const base = Object.fromEntries(
        Object.entries(before).filter(([key]) => key !== 'playoffSetsToWin'),
      );
      const config: Record<string, unknown> = { ...base, ...stageLengths(format, stage.type) };

      for (const match of stage.matches) {
        const started = match.status === 'PLAYING' || match.setsA !== null;

        if (started && matchSetsToWin(before, match) !== matchSetsToWin(config, match)) {
          lockedMatches.push(match.id);
        }
      }

      if (JSON.stringify(canonical(config)) !== JSON.stringify(canonical(before))) {
        changes.push({ id: stage.id, config });
      }
    }

    if (lockedMatches.length > 0) {
      throw new AppError(ERROR_CODES.MATCH_LENGTH_LOCKED, 'Started matches keep their length', {
        matchIds: lockedMatches,
      });
    }

    for (const change of changes) {
      await tx.stage.update({
        where: { id: change.id },
        data: { config: change.config as Prisma.InputJsonObject },
      });
    }
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
    const tournament = await this.findById(id, userId);
    // Оплату видит только организатор клуба (ADR-062).
    const payment = userId !== undefined && (await this.isClubStaff(tournament.clubId, userId));

    const rows = await this.prisma.registration.findMany({
      where: { tournamentId: id },
      select: registrationFields,
      orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((row) => toRegistrationView(row, { payment }));
  }

  /**
   * Запись на турнир — ТЗ 4.3.
   *
   * Без `playerId` игрок записывает себя. С `playerId` записывает организатор,
   * и тогда он обязан управлять клубом-хозяином: заявить чужого человека на
   * турнир — не то же самое, что заявиться самому.
   *
   * Статус сразу `CONFIRMED`. Онлайн-взнос — `[V2]`; наличные организатор
   * отмечает отдельно, «Оплатил» с журналом (ADR-062). См. ADR-018.
   *
   * После закрытия записи и после старта чужого игрока добавляет организатор
   * — поздняя запись (ADR-062, `registerLate`).
   */
  async register(id: string, input: RegisterInput, userId: string): Promise<RegistrationView> {
    const tournament = await this.load(id);
    // Свободная запись — ADR-076: пока организатор держит запись открытой.
    // Срок действует, только если его задали явно; без него запись
    // закрывает сам организатор, а время старта её не обрывает.
    const deadline = tournament.registrationEndsAt;
    const open =
      acceptsRegistrations(tournament.status) &&
      (deadline === null || deadline.getTime() > Date.now());
    // Поздняя запись (ADR-062): чужого игрока после закрытия записи и после
    // старта добавляет организатор. Себя после закрытия записать нельзя.
    const late =
      !open &&
      LATE_ENTRY_STATUSES.includes(tournament.status) &&
      input.playerId !== undefined &&
      !(await this.isOwnPlayer(input.playerId, userId));

    if (!open && !late) {
      if (!acceptsRegistrations(tournament.status)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Registration is not open', {
          id,
          status: tournament.status,
          reason: 'REGISTRATION_CLOSED',
        });
      }

      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Registration deadline has passed', {
        id,
        deadline: deadline?.toISOString() ?? null,
        reason: 'DEADLINE_PASSED',
      });
    }

    const playerId = await this.resolvePlayer(tournament.clubId, input, userId);

    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { ...playerFields, coachPlayerId: true, coachName: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { playerId });
    }

    assertConfirmed(player);

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

    // Планку рейтинга организатор может разрешить переступать по заявке
    // (ADR-044). Возраст и пол — нет: это условия самого турнира, а не
    // уровня игры.
    const reviewable =
      tournament.reviewOutOfRating &&
      problems.every((problem) => problem === 'RATING_TOO_HIGH' || problem === 'RATING_TOO_LOW');

    if (problems.length > 0 && !reviewable) {
      // Все причины сразу: узнавать о следующей после устранения предыдущей
      // человек не должен.
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player is not eligible', {
        playerId,
        problems,
      });
    }

    // Игрок вне планки ждёт решения. Организатор, записывающий его сам, это
    // решение уже принял — ждать ему некого.
    const byOrganizer =
      input.playerId !== undefined && !(await this.isOwnPlayer(input.playerId, userId));
    const pending = problems.length > 0 && !byOrganizer;

    const existing = await this.prisma.registration.findUnique({
      where: { tournamentId_playerId: { tournamentId: id, playerId } },
      select: { id: true },
    });

    if (existing !== null) throw alreadyRegistered(playerId);

    if (late) return this.registerLate(tournament, playerId, player, input.groupId);

    const { created, reset } = await this.prisma
      .$transaction(async (tx) => {
        // Запись по одной на турнир: две одновременные иначе обе видят
        // свободное последнее место, и в составе оказывается больше лимита.
        await lockRegistrations(tx, id);

        const taken = await tx.registration.count({
          where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
        });

        // Лимит достигнут — в лист ожидания (ТЗ 4.3), а не отказ: место
        // освободится при первой же отмене.
        const full = tournament.maxParticipants !== null && taken >= tournament.maxParticipants;
        const status = pending ? 'PENDING' : full ? 'WAITLIST' : 'CONFIRMED';

        const registration = await tx.registration.create({
          data: {
            tournamentId: id,
            playerId,
            status,
            // Тренера в записи нет, пока его не укажут (ADR-089): он решает,
            // кому засчитаются медали, и молча брать его из анкеты нельзя.
          },
          select: registrationFields,
        });

        // Запись открыли заново после жеребьёвки: новый участник в ней не
        // стоит, и расстановка больше не про этот состав (ТЗ 5.3).
        return {
          created: registration,
          reset: isOccupying(status) && (await resetDraw(tx, id)),
        };
      })
      .catch((error: unknown) => {
        // Двойное нажатие «Записаться»: второй запрос проходит проверку выше
        // раньше, чем первый успел записать, и упирается в уникальный ключ.
        // Человеку это то же «уже записан», а не ошибка сервера.
        if (isUniqueViolation(error)) throw alreadyRegistered(playerId);
        throw error;
      });

    if (reset) this.screen.changed(id);

    return toRegistrationView(created);
  }

  /**
   * Поздняя запись — ADR-062.
   *
   * Организатор игрока уже допустил: ни листа ожидания, ни решения по заявке.
   * После старта — сразу «играет» со снимком рейтинга (ТС 5.4), и встаёт в
   * группу текущего этапа (`placeLateEntry`).
   */
  private async registerLate(
    tournament: TournamentRecord,
    playerId: string,
    player: {
      readonly rating: Prisma.Decimal;
      readonly ratedMatches: number;
      readonly ratedTournaments: number;
    } & {
      readonly coachPlayerId: string | null;
      readonly coachName: string | null;
    },
    groupId: string | undefined,
  ): Promise<RegistrationView> {
    const started = tournament.startedAt !== null;

    const created = await this.prisma
      .$transaction(async (tx) => {
        await lockRegistrations(tx, tournament.id);
        await placeLateEntry(tx, tournament.id, playerId, groupId);

        const registration = await tx.registration.create({
          data: {
            tournamentId: tournament.id,
            playerId,
            status: started ? 'PLAYING' : 'CONFIRMED',
            ...(started ? snapshotFields(player) : {}),
          },
          select: registrationFields,
        });

        await bumpVersion(tx, tournament.id);

        return registration;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw alreadyRegistered(playerId);
        throw error;
      });

    this.screen.changed(tournament.id);

    return toRegistrationView(created, { payment: true });
  }

  /**
   * Замена участника — ADR-062.
   *
   * Пришёл резервный игрок вместо неявившегося: новый занимает его место в
   * расстановке — все встречи заменённого переходят к нему, посев тоже.
   * Заменённый снимается. Только пока заменённый не сыграл ни одной встречи:
   * иначе его результаты пришлось бы либо отдать другому человеку, либо
   * стереть.
   */
  async replaceParticipant(
    id: string,
    registrationId: string,
    input: ReplaceRegistrationInput,
    userId: string,
  ): Promise<RegistrationView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    const drawn = (await this.prisma.stage.count({ where: { tournamentId: id } })) > 0;

    if (!LATE_ENTRY_STATUSES.includes(tournament.status) || !drawn) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Replacement needs a draw', {
        id,
        status: tournament.status,
      });
    }

    const replaced = await this.loadRegistration(id, registrationId);
    const player = await this.prisma.player.findUnique({
      where: { id: input.playerId },
      select: {
        id: true,
        rating: true,
        ratedMatches: true,
        ratedTournaments: true,
        coachPlayerId: true,
        coachName: true,
        confirmedAt: true,
      },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { playerId: input.playerId });
    }

    assertConfirmed(player);

    const existing = await this.prisma.registration.findUnique({
      where: { tournamentId_playerId: { tournamentId: id, playerId: input.playerId } },
      select: { id: true, status: true },
    });

    // Из листа ожидания замена берёт его же запись; записанный иначе уже
    // стоит в составе, и место в расстановке ему не нужно.
    if (existing !== null && existing.status !== 'WAITLIST') {
      throw alreadyRegistered(input.playerId);
    }

    const started = tournament.startedAt !== null;

    const created = await this.prisma.$transaction(async (tx) => {
      const matches = await tx.match.findMany({
        where: {
          tournamentId: id,
          OR: [{ playerAId: replaced.playerId }, { playerBId: replaced.playerId }],
        },
        select: { id: true, setsA: true },
      });
      const played = matches.filter((match) => match.setsA !== null).map((match) => match.id);

      if (played.length > 0) {
        throw new AppError(ERROR_CODES.REPLACEMENT_LOCKED, 'The replaced player has played', {
          matchIds: played,
        });
      }

      await tx.match.updateMany({
        where: { tournamentId: id, playerAId: replaced.playerId },
        data: { playerAId: input.playerId },
      });
      await tx.match.updateMany({
        where: { tournamentId: id, playerBId: replaced.playerId },
        data: { playerBId: input.playerId },
      });
      await tx.registration.update({
        where: { id: replaced.id },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
      });

      const data = {
        status: started ? ('PLAYING' as const) : ('CONFIRMED' as const),
        seed: replaced.seed,
        ...(started ? snapshotFields(player) : {}),
        coachPlayerId: player.coachPlayerId,
        coachName: player.coachName,
      };
      const registration =
        existing === null
          ? await tx.registration.create({
              data: { tournamentId: id, playerId: input.playerId, ...data },
              select: registrationFields,
            })
          : await tx.registration.update({
              where: { id: existing.id },
              data,
              select: registrationFields,
            });

      // Встреча нового игрока могла стать решённой снятием и наоборот.
      await settleWithdrawals(tx, id);
      await bumpVersion(tx, id);

      return registration;
    });

    this.screen.changed(id);

    return toRegistrationView(created, { payment: true });
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
    const reviewing = registration.status === 'PENDING';
    const { paid, ...change } = input;

    // Отказ — решение по заявке, а не способ снять участника: для этого есть
    // снятие, при котором сыгранное остаётся (ТЗ 4.4).
    if (input.status === 'REJECTED' && !reviewing) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'Only a pending application can be rejected',
        {
          registrationId,
          status: registration.status,
        },
      );
    }

    const started = tournament.startedAt !== null;

    // После старта сетка уже разложена, и принятому в ней места нет.
    if (reviewing && started) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Tournament has already started', {
        id,
        registrationId,
      });
    }

    let status: UpdateRegistrationInput['status'] | 'PLAYING' = input.status;
    const restoring =
      started && status !== undefined && !isOccupying(registration.status) && isOccupying(status);

    if (restoring) {
      // После старта в игру возвращают только того, кто есть в расстановке:
      // снятого или отмеченного неявкой по ошибке (ADR-061). Места за ним в
      // сетке и так есть, лимит состава здесь ни при чём. Из листа ожидания
      // в идущий турнир не взять — встреч у него нет.
      await this.assertInDraw(id, registration.playerId);
      status = 'PLAYING';
    } else if (status !== undefined && !isOccupying(registration.status) && isOccupying(status)) {
      // Принятая заявка при полном составе встаёт в лист ожидания, а не
      // отвергается: организатор сказал «да», место освободится при отмене.
      if (
        reviewing &&
        status === 'CONFIRMED' &&
        !(await this.hasRoom(id, tournament.maxParticipants))
      ) {
        status = 'WAITLIST';
      } else {
        await this.assertHasRoom(id, tournament.maxParticipants);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.registration.update({
        where: { id: registrationId },
        data: defined({
          ...change,
          status,
          // Время снятия — порядок технических побед (ADR-077); вернули в
          // игру — времени снятия больше нет.
          ...(status !== undefined && status !== registration.status
            ? {
                withdrawnAt: status === 'WITHDRAWN' || status === 'NO_SHOW' ? new Date() : null,
              }
            : {}),
          ...(restoring ? await snapshotOf(tx, registrationId) : {}),
          ...(await this.paymentChange(tx, registration, paid, userId)),
        }),
        select: registrationFields,
      });

      // После старта освободившееся место никому не отдаётся: сетка уже
      // разложена, и поднятый из очереди оказался бы участником без встреч.
      if (
        !started &&
        input.status !== undefined &&
        isOccupying(registration.status) &&
        !isOccupying(input.status)
      ) {
        await promoteFromWaitlist(tx, id, tournament.maxParticipants);
      }

      // До старта состав изменился — снят, неявка, принят из листа ожидания
      // или по заявке. Жеребьёвка разложена по прежнему составу: снятый
      // остался бы в группе, поднятый из очереди не попал бы никуда и после
      // старта «играл» бы без единой встречи. ТЗ 5.3 велит жеребить заново.
      const recomposed =
        !started &&
        status !== undefined &&
        isOccupying(registration.status) !== isOccupying(status) &&
        (await resetDraw(tx, id));

      // По ходу турнира снятие решает встречи: в группе — расчётом таблицы
      // (ADR-009), в сетке — технической победой соперника (ADR-061). Если
      // группам больше нечего доигрывать, плей-офф достраивается здесь же,
      // как после последнего счёта (ADR-020).
      if (started && status !== undefined && status !== registration.status) {
        await advanceAfterGroups(tx, id);
        await settleWithdrawals(tx, id);
      }

      // Снятие участника меняет таблицы, и снимок консоли обязан это увидеть.
      await bumpVersion(tx, id);

      return { result, recomposed };
    });

    if (started || updated.recomposed) this.screen.changed(id);

    return toRegistrationView(updated.result, { payment: true });
  }

  /**
   * Тренер участника на турнире — ADR-059, T3.
   *
   * Правят сам игрок и организатор, только до старта: после него запись —
   * история, по ней считаются медали учеников. Поправленный руками тренер
   * больше не идёт за анкетой. Версия турнира не растёт: консоли тренер не
   * нужен, а до старта снимок всё равно обновится при старте.
   */
  async setRegistrationCoach(
    id: string,
    registrationId: string,
    input: SetRegistrationCoachInput,
    userId: string,
  ): Promise<RegistrationView> {
    const tournament = await this.load(id);
    const registration = await this.loadRegistration(id, registrationId);

    if (!(await this.isOwnPlayer(registration.playerId, userId))) {
      await this.assertClubStaff(tournament.clubId, userId);
    }

    if (!isCoachEditable(tournament.status)) {
      throw new AppError(
        ERROR_CODES.REGISTRATION_COACH_LOCKED,
        'Coach is fixed once the tournament has started',
        { id, registrationId, status: tournament.status },
      );
    }

    await assertCoachExists(this.prisma, input.coachPlayerId ?? undefined, registration.playerId);

    const updated = await this.prisma.registration.update({
      where: { id: registrationId },
      data: { coachPlayerId: input.coachPlayerId, coachName: input.coachName, coachManual: true },
      select: registrationFields,
    });

    return toRegistrationView(updated);
  }

  /**
   * Отмена записи — ТЗ 4.3.
   *
   * Игрок снимает себя сам до жеребьёвки (ADR-076); организатор — пока турнир не начат.
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
      // Сняться самому — свободно до жеребьёвки (ADR-076): срок записи этому
      // не мешает. После жеребьёвки человек уже стоит в группе или сетке, и
      // его уход перестраивает этап — это решает организатор.
      const drawn = (await this.prisma.stage.count({ where: { tournamentId: id } })) > 0;

      if (drawn) {
        throw new AppError(ERROR_CODES.FORBIDDEN, 'The draw is done: ask the organizer', {
          id,
          reason: 'DRAWN',
        });
      }
    } else {
      await this.assertClubStaff(tournament.clubId, userId);
    }

    const reset = await this.prisma.$transaction(async (tx) => {
      await tx.registration.delete({ where: { id: registrationId } });

      if (!isOccupying(registration.status)) return false;

      await promoteFromWaitlist(tx, id, tournament.maxParticipants);

      // Удалённый из состава после жеребьёвки остался бы во встречах без
      // записи на турнир (ТЗ 5.3: состав изменился — жеребьёвка заново).
      return resetDraw(tx, id);
    });

    if (reset) this.screen.changed(id);
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
        reason: 'REGISTRATION_OPEN',
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

    assertDrawEditable(tournament);

    // «Поменять местами» у RTTF — до первой вызванной встречи этапа (ADR-124).
    // У каждого игрока берётся последний этап, где он стоит: после групп это
    // сетка. Меняться можно внутри этапа и между этапами одной ступени —
    // основной сеткой и сеткой за места, как «между финалами» у RTTF.
    const stages = await this.loadStages(id);
    const stageA = lastStageOf(stages, input.playerAId);
    const stageB = lastStageOf(stages, input.playerBId);
    const involved = [...new Set([stageA, stageB])];

    if (stageA !== stageB && (stageA.order === 0 || stageB.order === 0)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Players are in different stages', {
        id,
        reason: 'DIFFERENT_STAGES',
      });
    }

    for (const stage of involved) assertStageNotStarted(stage);

    const updates = planDrawSwap(
      involved.flatMap((stage) => stage.matches),
      input.playerAId,
      input.playerBId,
    );

    await this.prisma.$transaction(async (tx) => {
      await assertStagesStillOpen(
        tx,
        involved.map((stage) => stage.id),
      );

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

  /** Перенести игрока в другую группу — ADR-124. */
  async moveInDraw(id: string, userId: string, input: DrawMoveInput): Promise<DrawResult> {
    return this.editGroups(
      id,
      userId,
      (stage) => stageHolds(stage, input.playerId),
      (groups) => planMove(groups, input.playerId, input.groupId),
    );
  }

  /** Новая группа из выбранных игроков — ADR-124. */
  async newGroupInDraw(id: string, userId: string, input: DrawNewGroupInput): Promise<DrawResult> {
    return this.editGroups(
      id,
      userId,
      (stage) => input.playerIds.every((player) => stageHolds(stage, player)),
      (groups) => planNewGroup(groups, input.playerIds),
    );
  }

  /** Расформировать группу — ADR-124. */
  async disbandGroup(id: string, userId: string, groupId: string): Promise<DrawResult> {
    return this.editGroups(
      id,
      userId,
      (stage) => stage.groups.some((group) => group.id === groupId),
      (groups) => planDisband(groups, groupId),
    );
  }

  /**
   * Общий ход ручной правки групп — ADR-124.
   *
   * Правится групповой этап, пока в нём не начата ни одна встреча: до старта
   * или после, как у RTTF. Встречи затронутых групп строятся заново круговой
   * схемой этапа, игроки в группе — по рейтингу, первым сильнейший (номер
   * строки у RTTF). Новую группу и расформирование правят только первый
   * групповой этап: финальные группы собираются по местам, и номер группы у
   * них — диапазон мест.
   */
  private async editGroups(
    id: string,
    userId: string,
    holds: (stage: StageRecord) => boolean,
    plan: (groups: EditableGroup[]) => GroupEdit,
  ): Promise<DrawResult> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);
    assertDrawEditable(tournament);

    const stages = await this.loadStages(id);
    const stage = [...stages].reverse().find((item) => item.type === 'GROUPS' && holds(item));

    if (stage === undefined) {
      throw new AppError(ERROR_CODES.DRAW_POSITION_NOT_FOUND, 'No group stage holds the players', {
        id,
      });
    }

    assertStageNotStarted(stage);

    const groups: EditableGroup[] = stage.groups.map((group) => ({
      id: group.id,
      order: group.order,
      label: group.label,
      participants: membersOf(stage, group.id),
    }));
    const edit = plan(groups);

    if ((edit.created !== undefined || edit.removed !== undefined) && stage.order !== 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Final groups are formed by places', {
        id,
        reason: 'FINAL_GROUPS',
      });
    }

    const ratings = await this.drawRatings(id);
    const byRating = (members: readonly string[]): string[] =>
      [...members].sort(
        (left, right) =>
          (ratings.get(right) ?? 0) - (ratings.get(left) ?? 0) || left.localeCompare(right),
      );
    const rounds = asRecord(stage.config).rounds === 2 ? 2 : 1;

    await this.prisma.$transaction(async (tx) => {
      await assertStagesStillOpen(tx, [stage.id]);

      for (const [groupId, members] of edit.changed) {
        await rewriteGroup(tx, id, stage.id, groupId, byRating(members), rounds);
      }

      if (edit.created !== undefined) {
        const order = groups.reduce((max, group) => Math.max(max, group.order), -1) + 1;
        const created = await tx.group.create({
          data: { stageId: stage.id, order, label: `гр. ${String(order + 1)}` },
          select: { id: true },
        });

        await rewriteGroup(tx, id, stage.id, created.id, byRating(edit.created), rounds);
      }

      if (edit.removed !== undefined) {
        await tx.match.deleteMany({ where: { groupId: edit.removed } });
        await tx.group.delete({ where: { id: edit.removed } });
        await renumberGroups(tx, stage.id);
      }

      await bumpVersion(tx, id);
    });

    this.screen.changed(id);

    const changed = await this.loadStages(id);

    return {
      tournamentId: id,
      stages: changed.map(toStageView),
      clubCollisions: await this.collisionsOf(id, changed),
    };
  }

  /** Рейтинг для порядка в группе: снимок на старте, до старта — текущий. */
  private async drawRatings(id: string): Promise<Map<string, number>> {
    const rows = await this.prisma.registration.findMany({
      where: { tournamentId: id },
      select: { playerId: true, ratingAtStart: true, player: { select: { rating: true } } },
    });

    return new Map(
      rows.map((row) => [row.playerId, Number(row.ratingAtStart ?? row.player.rating)]),
    );
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
        reason: 'NOT_DRAWN',
      });
    }

    await this.assertDrawCurrent(id);

    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
      select: {
        id: true,
        player: { select: { rating: true, ratedMatches: true, ratedTournaments: true } },
      },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const registration of registrations) {
        await tx.registration.update({
          where: { id: registration.id },
          data: {
            status: 'PLAYING',
            ...snapshotFields(registration.player),
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
   * Расстановка совпадает с составом — проверка перед стартом.
   *
   * Жеребьёвка сбрасывается при каждом изменении состава (ТЗ 5.3), но старт
   * — последняя точка, где расхождение ещё ничего не стоит: участник вне
   * расстановки после старта «играет» без единой встречи и остаётся без
   * места, а снятый, но оставшийся во встречах, раздаёт технические победы.
   */
  private async assertDrawCurrent(id: string): Promise<void> {
    const [first] = await this.loadStages(id);

    if (first === undefined) return;

    const drawn = new Set(
      first.matches
        .flatMap((match) => [match.playerAId, match.playerBId])
        .filter((player): player is string => player !== null),
    );
    const registered = await this.prisma.registration.findMany({
      where: { tournamentId: id, status: { in: OCCUPYING_STATUSES } },
      select: { playerId: true },
    });
    const occupying = new Set(registered.map((registration) => registration.playerId));
    const missing = [...occupying].filter((player) => !drawn.has(player));
    const extra = [...drawn].filter((player) => !occupying.has(player));

    if (missing.length > 0 || extra.length > 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The draw does not match the roster', {
        id,
        reason: 'DRAW_STALE',
        missing,
        extra,
      });
    }
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

    // Места — до рейтинга: они от него не зависят, а профиль игрока
    // показывает их сразу после завершения (ADR-048).
    await this.recordPlaces(id);

    const rated = await this.applyRating(id, userId);

    this.screen.changed(id);

    return rated;
  }

  /**
   * Исправление результатов после завершения — ADR-135, «Корректировка»
   * турнир-менеджера RTTF.
   *
   * Турнир возвращается в «Идёт»: судья правит счёт в консоли и завершает
   * заново, рейтинг считается ещё раз. Начисленное откатывается целиком —
   * журнал турнира удаляется, игрокам возвращаются рейтинг, число встреч и
   * турниров со старта турнира (снимок ТС 5.4, против него и считалось).
   *
   * Откат безопасен, только пока после этого турнира у его игроков не было
   * других начислений: следующий турнир или дуэль считались от рейтинга,
   * который сейчас изменится, и их пришлось бы пересчитать цепочкой. Такого
   * пересчёта пока нет, поэтому сервер отказывает и называет, что мешает.
   * Удалённый журнал сохраняется в аудите — видно, что было до правки.
   */
  async reopen(id: string, userId: string): Promise<TournamentView> {
    const tournament = await this.load(id);

    await this.assertClubStaff(tournament.clubId, userId);

    if (nextStatus(tournament.status, 'reopen') === undefined) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Transition is not allowed', {
        id,
        from: tournament.status,
        action: 'reopen',
      });
    }

    const events = await this.prisma.ratingEvent.findMany({
      where: { tournamentId: id },
      select: {
        id: true,
        playerId: true,
        matchId: true,
        type: true,
        ratingBefore: true,
        delta: true,
        ratingAfter: true,
        createdAt: true,
      },
    });
    const players = [...new Set(events.map((event) => event.playerId))];
    const ratedAt = events.reduce<Date | null>(
      (min, event) => (min === null || event.createdAt < min ? event.createdAt : min),
      null,
    );

    if (ratedAt !== null && players.length > 0) {
      const later = await this.prisma.ratingEvent.findMany({
        where: {
          playerId: { in: players },
          createdAt: { gt: ratedAt },
          OR: [{ tournamentId: null }, { tournamentId: { not: id } }],
        },
        select: { tournamentId: true, tournament: { select: { name: true } } },
        distinct: ['tournamentId'],
        take: 10,
      });

      if (later.length > 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          'Players were rated after this tournament',
          {
            id,
            reason: 'LATER_RATED',
            tournaments: later.flatMap((event) =>
              event.tournament === null ? [] : [event.tournament.name],
            ),
            duels: later.some((event) => event.tournamentId === null),
          },
        );
      }
    }

    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id, playerId: { in: players } },
      select: {
        playerId: true,
        ratingAtStart: true,
        matchesAtStart: true,
        tournamentsAtStart: true,
      },
    });

    const reopened = await this.prisma.$transaction(async (tx) => {
      // Переход — и замок: два одновременных вызова не откатят дважды.
      const claimed = await tx.tournament.updateMany({
        where: { id, status: { in: ['FINISHED', 'RATED'] } },
        data: {
          status: 'RUNNING',
          finishedAt: null,
          ratedAt: null,
          placesAt: null,
          version: { increment: 1 },
        },
      });

      if (claimed.count === 0) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Transition is not allowed', {
          id,
          action: 'reopen',
        });
      }

      for (const registration of registrations) {
        if (registration.ratingAtStart === null) continue;
        const tournaments = registration.tournamentsAtStart ?? 0;

        await tx.player.update({
          where: { id: registration.playerId },
          data: {
            rating: registration.ratingAtStart,
            ...(registration.matchesAtStart === null
              ? {}
              : { ratedMatches: registration.matchesAtStart }),
            ratedTournaments: tournaments,
            isProvisional: tournaments < NOVICE_TOURNAMENTS,
          },
        });
      }

      await tx.ratingEvent.deleteMany({ where: { tournamentId: id } });
      await tx.registration.updateMany({
        where: { tournamentId: id },
        data: { place: null, placeTo: null },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: 'tournament.reopened',
          entityType: 'Tournament',
          entityId: id,
          before: {
            status: tournament.status,
            events: events.map((event) => ({
              playerId: event.playerId,
              matchId: event.matchId,
              type: event.type,
              ratingBefore: event.ratingBefore.toString(),
              delta: event.delta.toString(),
              ratingAfter: event.ratingAfter.toString(),
            })),
          } as Prisma.InputJsonValue,
          after: { status: 'RUNNING' },
        },
      });

      return tx.tournament.findUniqueOrThrow({ where: { id }, select: tournamentFields });
    });

    this.screen.changed(id);

    return toTournamentView(reopened);
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
      buildStandings({
        tournamentId: id,
        stages,
        withdrawn: [...withdrawn],
        order: withdrawalOrder(
          registrations.map((registration) => ({
            playerId: registration.player.id,
            withdrawnAt: registration.withdrawnAt,
          })),
        ),
      }),
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
  private async applyRating(id: string, userId: string): Promise<TournamentView> {
    const [stages, registrations] = await Promise.all([
      this.loadStages(id),
      this.prisma.registration.findMany({
        where: { tournamentId: id },
        select: registrationFields,
      }),
    ]);

    const run = buildRatingRun(registrations, stages);
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
          type: event.type,
          ratingBefore: event.ratingBefore,
          delta: event.delta,
          ratingAfter: event.ratingAfter,
          opponentRating: event.opponentRating,
          kFactor: event.kFactor,
          tFactor: event.tFactor,
          mFactor: event.mFactor,
          imbalance: event.imbalance,
          reason: bonusReason(event),
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
            ratedTournaments: player.ratedTournaments,
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

    return this.computeResults(tournament);
  }

  /**
   * Итоговые места — в заявки, ADR-048.
   *
   * Места считаются из сетки и таблиц, и считать их на каждый показ профиля
   * игрока значило бы поднимать весь турнир ради одного числа. Записываются
   * один раз при завершении: после него сетка и таблицы уже не меняются.
   * Делённое место — диапазоном: «5–8» у проигравших в 1/4.
   */
  async recordPlaces(id: string): Promise<void> {
    const tournament = await this.load(id);
    const results = await this.computeResults(tournament);
    const range = new Map<string, { place: number | null; placeTo: number | null }>();

    for (const participant of results.participants) {
      if (participant.place !== null) {
        range.set(participant.player.id, { place: participant.place, placeTo: null });
      }
    }

    for (const tie of results.shared) {
      const place = Math.min(...tie.places);
      const placeTo = Math.max(...tie.places);

      for (const playerId of tie.participants) {
        range.set(playerId, { place, placeTo: placeTo === place ? null : placeTo });
      }
    }

    const registrations = await this.prisma.registration.findMany({
      where: { tournamentId: id },
      select: { id: true, playerId: true },
    });

    await this.prisma.$transaction([
      ...registrations.map((registration) =>
        this.prisma.registration.update({
          where: { id: registration.id },
          data: range.get(registration.playerId) ?? { place: null, placeTo: null },
          select: { id: true },
        }),
      ),
      this.prisma.tournament.update({
        where: { id },
        data: { placesAt: new Date() },
        select: { id: true },
      }),
    ]);
  }

  /**
   * Места турниров, завершённых до ADR-048: досчитываются при первом
   * обращении и записываются. Повторно не считаются — отметка `placesAt`
   * стоит, даже если у кого-то места нет (снялся, не доиграл).
   */
  async ensurePlaces(ids: readonly string[]): Promise<void> {
    const missing = await this.prisma.tournament.findMany({
      where: { id: { in: [...ids] }, status: { in: ['FINISHED', 'RATED'] }, placesAt: null },
      select: { id: true },
    });

    for (const tournament of missing) {
      await this.recordPlaces(tournament.id);
    }
  }

  private async computeResults(tournament: TournamentRecord): Promise<TournamentResultsView> {
    const id = tournament.id;
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
      standings: buildStandings({
        tournamentId: id,
        stages,
        withdrawn: [...withdrawn],
        order: withdrawalOrder(
          registrations.map((registration) => ({
            playerId: registration.player.id,
            withdrawnAt: registration.withdrawnAt,
          })),
        ),
      }),
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
        select: { playerId: true, withdrawnAt: true },
      }),
    ]);

    return buildStandings({
      tournamentId: id,
      stages,
      withdrawn: withdrawn.map((registration) => registration.playerId),
      order: withdrawalOrder(withdrawn),
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
      // Достроенная сетка могла посадить снявшегося напротив соперника (ADR-061).
      await settleWithdrawals(tx, id);

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

  /**
   * Отметка «Оплатил» — ADR-062: учёт наличных в зале, а не платёж.
   *
   * Время ставится при первой отметке и не сдвигается повторной; снятая
   * отметка его стирает. Каждое изменение — в журнал: деньги в зале — то
   * место, где спорят, и «кто отметил» обязан находиться.
   */
  private async paymentChange(
    tx: Prisma.TransactionClient,
    registration: { readonly id: string; readonly paidAt: Date | null },
    paid: boolean | undefined,
    userId: string,
  ): Promise<{ paidAt?: Date | null }> {
    const wasPaid = registration.paidAt !== null;

    if (paid === undefined || paid === wasPaid) return {};

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: 'registration.paid',
        entityType: 'Registration',
        entityId: registration.id,
        before: { paid: wasPaid },
        after: { paid },
      },
    });

    return { paidAt: paid ? new Date() : null };
  }

  /** Есть ли игрок во встречах турнира — то есть в расстановке. */
  private async assertInDraw(tournamentId: string, playerId: string): Promise<void> {
    const matches = await this.prisma.match.count({
      where: { tournamentId, OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    });

    if (matches === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player is not in the draw', {
        tournamentId,
        playerId,
      });
    }
  }

  private async loadRegistration(
    tournamentId: string,
    registrationId: string,
  ): Promise<{
    id: string;
    status: string;
    playerId: string;
    paidAt: Date | null;
    seed: number | null;
  }> {
    const registration = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      select: {
        id: true,
        status: true,
        playerId: true,
        tournamentId: true,
        paidAt: true,
        seed: true,
      },
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
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          'Player profile is required to register',
          {
            reason: 'PROFILE_REQUIRED',
          },
        );
      }

      return own.id;
    }

    if (await this.isOwnPlayer(input.playerId, userId)) {
      return input.playerId;
    }

    await this.assertClubStaff(clubId, userId);

    return input.playerId;
  }

  private async hasRoom(tournamentId: string, maxParticipants: number | null): Promise<boolean> {
    if (maxParticipants === null) return true;

    const taken = await this.prisma.registration.count({
      where: { tournamentId, status: { in: OCCUPYING_STATUSES } },
    });

    return taken < maxParticipants;
  }

  private async assertHasRoom(tournamentId: string, maxParticipants: number | null): Promise<void> {
    if (!(await this.hasRoom(tournamentId, maxParticipants))) {
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

/**
 * Снимок рейтинга для вернувшегося в игру после старта (ТС 5.4).
 *
 * Отмеченный неявкой до старта снимка не получил: старт снимает только
 * занимающих место. Без него обсчёт остановился бы на первой же встрече.
 */
async function snapshotOf(
  tx: Prisma.TransactionClient,
  registrationId: string,
): Promise<Partial<ReturnType<typeof snapshotFields>>> {
  const row = await tx.registration.findUnique({
    where: { id: registrationId },
    select: {
      ratingAtStart: true,
      player: { select: { rating: true, ratedMatches: true, ratedTournaments: true } },
    },
  });

  if (row?.ratingAtStart !== null) return {};

  return snapshotFields(row.player);
}

/**
 * Снимок рейтинга на старте — ТС 5.4. Одно место на все пути старта:
 * общий старт, поздняя запись, замена, неявка до старта. Забытый счётчик
 * турниров молча сделал бы игрока новичком (ADR-069).
 */
function snapshotFields(player: {
  readonly rating: Prisma.Decimal;
  readonly ratedMatches: number;
  readonly ratedTournaments: number;
}): { ratingAtStart: Prisma.Decimal; matchesAtStart: number; tournamentsAtStart: number } {
  return {
    ratingAtStart: player.rating,
    matchesAtStart: player.ratedMatches,
    tournamentsAtStart: player.ratedTournaments,
  };
}

/** Бонус призёру читается в журнале без встречи: место и процент — словами. */
function bonusReason(event: RatingEventDraft): string | null {
  if (event.type !== 'BONUS') return null;

  return `Бонус за ${String(event.place)} место: ${String(event.bonusPercent)} % от рейтинга на старте`;
}

/** Схемы совпадают во всём, кроме длин встреч — их одних и можно менять по ходу. */
function sameExceptLengths(left: FormatConfig, right: FormatConfig): boolean {
  return (
    JSON.stringify(canonical(withoutLengths(left))) ===
    JSON.stringify(canonical(withoutLengths(right)))
  );
}

/**
 * Что меняет правка схемы — ADR-124.
 *
 * `LENGTHS` — только длины встреч; `NEXT_STAGE` — только то, как выходят из
 * групп дальше (у RTTF «распределение по финалам»); `STRUCTURE` — сами группы
 * или сетка, тогда жеребьёвка строится заново.
 */
function formatChangeOf(
  current: FormatConfig,
  next: FormatConfig,
): 'NONE' | 'LENGTHS' | 'NEXT_STAGE' | 'STRUCTURE' {
  const same = (left: unknown, right: unknown): boolean =>
    JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

  if (same(current, next)) return 'NONE';
  if (sameExceptLengths(current, next)) return 'LENGTHS';

  const grouped =
    current.type === next.type &&
    (current.type === 'GROUPS_KNOCKOUT' || current.type === 'GROUPS_FINAL_GROUPS');
  const groupsPart = (format: FormatConfig): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(withoutLengths(format)).filter(([key]) => !NEXT_STAGE_FIELDS.has(key)),
    );

  return grouped && same(groupsPart(current), groupsPart(next)) ? 'NEXT_STAGE' : 'STRUCTURE';
}

const NEXT_STAGE_FIELDS = new Set([
  'advancePerGroup',
  'thirdPlace',
  'exitBracket',
  'allPlaces',
  'extraFinals',
  'composition',
  'carryOver',
  'finalGroupCount',
]);

/** Из групп выходит хотя бы двое — иначе сетку не построить (как при жеребьёвке). */
function assertAdvancing(stages: readonly StageRecord[], format: FormatConfig): void {
  const first = stages.find((stage) => stage.order === 0 && stage.type === 'GROUPS');

  if (first === undefined || !('advancePerGroup' in format)) return;

  const advancing = first.groups.reduce(
    (total, group) => total + Math.min(membersOf(first, group.id).length, format.advancePerGroup),
    0,
  );

  if (advancing < 2) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Too few participants advance from groups', {
      advancing,
      advancePerGroup: format.advancePerGroup,
      groups: first.groups.length,
      reason: 'TOO_FEW_ADVANCE',
    });
  }
}

/** Зона выхода в конфиге группового этапа — её показывают таблицы. */
async function syncAdvance(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  format: FormatConfig,
): Promise<void> {
  if (!('advancePerGroup' in format)) return;

  const first = await tx.stage.findFirst({
    where: { tournamentId, order: 0, type: 'GROUPS' },
    select: { id: true, config: true },
  });

  if (first === null) return;

  await tx.stage.update({
    where: { id: first.id },
    data: { config: { ...asRecord(first.config), advancePerGroup: format.advancePerGroup } },
  });
}

const LENGTH_FIELDS = new Set(['setsToWin', 'groupSetsToWin', 'koSetsToWin', 'playoffSetsToWin']);

function withoutLengths(format: FormatConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(format).filter(([key]) => !LENGTH_FIELDS.has(key)));
}

/** Ключи по алфавиту: порядок полей в `Json` от правки к правке не держится. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Когда организатор ещё может добавить опоздавшего или заменить игрока. */
const LATE_ENTRY_STATUSES: readonly string[] = ['REG_OPEN', 'REG_CLOSED', 'RUNNING'];

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

/** Расстановку правят до старта (запись закрыта) и по ходу турнира. */
function assertDrawEditable(tournament: { readonly id: string; readonly status: string }): void {
  if (tournament.status !== 'REG_CLOSED' && tournament.status !== 'RUNNING') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The draw cannot be adjusted now', {
      id: tournament.id,
      status: tournament.status,
      reason: 'DRAW_LOCKED',
    });
  }
}

/** Этап начат: встреча вызвана к столу, сыграна или со счётом. */
function stageStarted(stage: StageRecord): boolean {
  return stage.matches.some(
    (match) => match.status === 'PLAYING' || match.status === 'FINISHED' || match.setsA !== null,
  );
}

function assertStageNotStarted(stage: StageRecord): void {
  if (stageStarted(stage)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The stage has already started', {
      stageId: stage.id,
      reason: 'STAGE_STARTED',
    });
  }
}

/** Та же проверка внутри транзакции: судья мог вызвать пару, пока правили. */
async function assertStagesStillOpen(
  tx: Prisma.TransactionClient,
  stageIds: readonly string[],
): Promise<void> {
  const started = await tx.match.findFirst({
    where: {
      stageId: { in: [...stageIds] },
      OR: [{ status: { in: ['PLAYING', 'FINISHED'] } }, { setsA: { not: null } }],
    },
    select: { stageId: true },
  });

  if (started !== null) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The stage has already started', {
      stageId: started.stageId,
      reason: 'STAGE_STARTED',
    });
  }
}

function stageHolds(stage: StageRecord, playerId: string): boolean {
  return stage.matches.some(
    (match) => match.playerAId === playerId || match.playerBId === playerId,
  );
}

/** Последний этап, где стоит игрок; нет нигде — его нет в расстановке. */
function lastStageOf(stages: readonly StageRecord[], playerId: string): StageRecord {
  const found = [...stages].reverse().find((stage) => stageHolds(stage, playerId));

  if (found === undefined) {
    throw new AppError(ERROR_CODES.DRAW_POSITION_NOT_FOUND, 'Player is not in the draw', {
      playerId,
    });
  }

  return found;
}

/** Состав группы — из её встреч, в порядке появления. */
function membersOf(stage: StageRecord, groupId: string): string[] {
  return [
    ...new Set(
      stage.matches
        .filter((match) => match.groupId === groupId)
        .flatMap((match) => [match.playerAId, match.playerBId])
        .filter((player): player is string => player !== null),
    ),
  ];
}

/** Встречи группы заново: каждый с каждым, кругов — как у этапа. */
async function rewriteGroup(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  stageId: string,
  groupId: string,
  members: readonly string[],
  rounds: 1 | 2,
): Promise<void> {
  await tx.match.deleteMany({ where: { groupId } });
  await tx.tieDecision.deleteMany({ where: { groupId } });
  await tx.match.createMany({
    data: scheduleRoundRobin(members, rounds).map((match) => ({
      id: randomUUID(),
      tournamentId,
      stageId,
      groupId,
      playerAId: match.a,
      playerBId: match.b,
      bracketRound: match.round,
    })),
  });
}

/**
 * Номера групп подряд после расформирования: «гр. 1, гр. 3» читалось бы как
 * потерянная группа. Порядок уникален в этапе — сначала уводится в минус.
 */
async function renumberGroups(tx: Prisma.TransactionClient, stageId: string): Promise<void> {
  const groups = await tx.group.findMany({
    where: { stageId },
    orderBy: { order: 'asc' },
    select: { id: true, label: true },
  });

  for (const [index, group] of groups.entries()) {
    await tx.group.update({ where: { id: group.id }, data: { order: -1 - index } });
  }

  for (const [index, group] of groups.entries()) {
    await tx.group.update({
      where: { id: group.id },
      data: {
        order: index,
        ...(/^гр\. \d+$/.test(group.label) ? { label: `гр. ${String(index + 1)}` } : {}),
      },
    });
  }
}

/**
 * Поднять из листа ожидания всех, кому хватает места, — после подъёма или
 * снятия лимита. Возвращает, скольких подняли.
 */
async function promoteAllFromWaitlist(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  maxParticipants: number | null,
): Promise<number> {
  const waiting = await tx.registration.findMany({
    where: { tournamentId, status: 'WAITLIST' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (waiting.length === 0) return 0;

  const taken = await tx.registration.count({
    where: { tournamentId, status: { in: OCCUPYING_STATUSES } },
  });
  const room = maxParticipants === null ? waiting.length : Math.max(0, maxParticipants - taken);
  const lifted = waiting.slice(0, room).map((registration) => registration.id);

  if (lifted.length > 0) {
    await tx.registration.updateMany({
      where: { id: { in: lifted } },
      data: { status: 'CONFIRMED' },
    });
  }

  return lifted.length;
}

/**
 * Сбросить жеребьёвку, если она была, — состав до старта изменился (ТЗ 5.3).
 * Версия растёт: экран зала и консоль обязаны перестать показывать прежнюю.
 */
async function resetDraw(tx: Prisma.TransactionClient, tournamentId: string): Promise<boolean> {
  const removed = await tx.stage.deleteMany({ where: { tournamentId } });

  if (removed.count === 0) return false;

  await bumpVersion(tx, tournamentId);

  return true;
}

/** Записи одного турнира идут по одной — до конца транзакции. */
async function lockRegistrations(
  tx: Prisma.TransactionClient,
  tournamentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'registrations:' + tournamentId}))`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function alreadyRegistered(playerId: string): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player is already registered', {
    playerId,
    reason: 'ALREADY_REGISTERED',
  });
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

/** Значение из запроса, а если поля в нём не было — из базы. `null` — стёрто. */
function orStored<T>(sent: T | null | undefined, stored: T | null): T | null {
  return sent === undefined ? stored : sent;
}

/**
 * На турнир — только игровой профиль (ADR-072). Анкету без рейтинга
 * организатор сначала подтверждает, задав рейтинг по уровню игры: иначе
 * человек входит в посев и в расчёт с умолчанием 250, а не со своей игрой.
 */
function assertConfirmed(player: { readonly id: string; readonly confirmedAt: Date | null }): void {
  if (player.confirmedAt === null) {
    throw new AppError(ERROR_CODES.PLAYER_NOT_CONFIRMED, 'Player is not confirmed', {
      playerId: player.id,
    });
  }
}
