import { AppError, ERROR_CODES } from '@kttf/shared/errors';
import { START_RATING } from '@kttf/shared/rating';
import {
  ONLINE_WINDOW_MS,
  type CityRef,
  type CoachStatus,
  type CoachVisibility,
  type ConfirmPlayerInput,
  type CreatePlayerInput,
  type EquipmentLabel,
  type HeadToHeadView,
  type ListPlayersQuery,
  type Page,
  type PlayerMatchesQuery,
  type PlayerListItemView,
  type PlayerMatchView,
  type PlayerProfileView,
  type PlayerView,
  type ProductCategory,
  type ProductListItemView,
  type RatingHistoryQuery,
  type RatingHistoryView,
  type UpdatePlayerInput,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { defined } from '../../common/objects.js';
import { pageOf, skipOf } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { cityRefFields } from '../places/place.fields.js';
import { PlacesService } from '../places/places.service.js';

import { countPlayers } from '../catalog/catalog-players.js';
import {
  VISIBLE,
  isVisible,
  listItemFields,
  toListItemView,
  type ListItemRecord,
} from '../catalog/catalog-views.js';
import { assertCoachExists, publicCoachSlug } from './coach-ref.js';
import { followProfileCoach, switchCoach } from './coach-tenure.js';
import { buildRatingPoints, ratingEventRowFields, summarize, toPlayerMatch } from './history.js';
import { ratingBounds } from './rating-band.js';

export const playerFields = {
  id: true,
  userId: true,
  lastName: true,
  firstName: true,
  middleName: true,
  birthYear: true,
  gender: true,
  city: { select: cityRefFields },
  photoUrl: true,
  clubId: true,
  rating: true,
  ratedMatches: true,
  isProvisional: true,
  confirmedAt: true,
  createdAt: true,
} as const;

/**
 * Полный профиль — ТЗ 2.2.
 *
 * Читается там, где анкету показывают: страница игрока и её правка. Списки
 * и снимок консоли обходятся `playerFields`: анкета каждого участника
 * раздула бы офлайн-снимок на десятки килобайт (ADR-035).
 */
const profileFields = {
  ...playerFields,
  birthDate: true,
  birthYearOnly: true,
  playingHand: true,
  grip: true,
  blade: true,
  rubberForehand: true,
  rubberBackhand: true,
  // Инвентарь из каталога — ADR-058. Скрытый товар в профиле не показывается.
  bladeProduct: { select: listItemFields },
  rubberForehandProduct: { select: listItemFields },
  rubberBackhandProduct: { select: listItemFields },
  bio: true,
  coachPlayerId: true,
  coachName: true,
  coachVisibility: true,
  // Имя выбранного тренера подставляется в ответ: экрану нужно одно поле,
  // а не развилка в каждом месте, где тренер выводится.
  // Опубликованная страница тренера — ссылкой на профиле (ADR-059).
  coach: {
    select: {
      lastName: true,
      firstName: true,
      coachPage: { select: { slug: true, status: true, hiddenAt: true } },
    },
  },
  // Своя страница тренера — бейдж «Тренер KTTF» в шапке профиля (ADR-059).
  coachPage: { select: { slug: true, status: true, hiddenAt: true } },
  // «В сети» и последнее посещение — с аккаунта, а не с игрока (ADR-050).
  user: { select: { lastSeenAt: true } },
  // История тренеров — T2 (ADR-059): открытый период текущего и прежние.
  coachTenures: {
    select: {
      coachPlayerId: true,
      from: true,
      to: true,
      coachPlayer: {
        select: {
          lastName: true,
          firstName: true,
          coachPage: { select: { slug: true, status: true, hiddenAt: true } },
        },
      },
    },
    orderBy: { from: 'desc' },
  },
} as const;

/** Товар в строке списка: подпись и адрес, без фото и характеристик. */
const labelProduct = {
  select: {
    slug: true,
    name: true,
    status: true,
    hiddenAt: true,
    brand: { select: { name: true } },
  },
} as const;

/**
 * Строка списка игроков — таблица «основание / справа / слева», как у RTTF
 * (ADR-058). Товары приходят связью той же выборки, без запроса на игрока.
 */
const listFields = {
  ...playerFields,
  blade: true,
  rubberForehand: true,
  rubberBackhand: true,
  bladeProduct: labelProduct,
  rubberForehandProduct: labelProduct,
  rubberBackhandProduct: labelProduct,
} as const;

type LabelProduct = Prisma.ProductGetPayload<typeof labelProduct>;

/** Слоты инвентаря и категория товара, которая в них допустима. */
const EQUIPMENT_SLOTS = [
  ['bladeProductId', 'BLADE'],
  ['rubberForehandProductId', 'RUBBER'],
  ['rubberBackhandProductId', 'RUBBER'],
] as const satisfies readonly (readonly [string, ProductCategory])[];

type EquipmentIds = Partial<Record<(typeof EQUIPMENT_SLOTS)[number][0], string | null | undefined>>;

/** Сыгранная встреча этого игрока: без результата в истории показывать нечего. */
function playedBy(playerId: string) {
  return {
    OR: [{ playerAId: playerId }, { playerBId: playerId }],
    setsA: { not: null },
  };
}

/** Поля встречи для истории. Дельта берётся только своя — журнал общий. */
function matchFields(playerId: string) {
  return {
    id: true,
    tournamentId: true,
    playerAId: true,
    playerBId: true,
    setsA: true,
    setsB: true,
    resultType: true,
    finishedAt: true,
    tournament: { select: { name: true } },
    stage: { select: { name: true } },
    ratingEvents: { where: { playerId }, select: { delta: true } },
  } as const;
}

type MatchRow = Prisma.MatchGetPayload<{ select: ReturnType<typeof matchFields> }>;

@Injectable()
export class PlayersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly places: PlacesService,
  ) {}

  async list(query: ListPlayersQuery): Promise<Page<PlayerListItemView>> {
    const where = {
      ...(query.cityId === undefined ? {} : { cityId: { in: query.cityId } }),
      ...(query.clubId === undefined ? {} : { clubId: query.clubId }),
      ...(query.gender === undefined ? {} : { gender: query.gender }),
      ...(query.playingHand === undefined ? {} : { playingHand: query.playingHand }),
      ...ratingRange(query.ratingFrom, query.ratingTo),
      // Игроки без кабинета — список для выбора себя при регистрации
      // (ADR-034). Без фильтра это был бы список всех игроков страны, то
      // есть приглашение занять чужую историю.
      ...(query.withoutAccount === true ? { userId: null } : {}),
      // Анкеты без рейтинга (ADR-072) — не игроки рейтинга. Их видит только
      // организатор, который ищет пришедшего, чтобы подтвердить анкету.
      ...(query.withUnconfirmed === true ? {} : { confirmedAt: { not: null } }),
      // Тренер — тот, на кого уже сослались хотя бы раз: роли тренера в
      // продукте ещё нет, и список берётся из самих данных, а не из
      // выдуманной колонки.
      ...(query.coachesOnly === true ? { students: { some: {} } } : {}),
      ...(query.search === undefined ? {} : { AND: nameWords(query.search) }),
      // «Кто играет» — ADR-058. Накладка — с любой стороны.
      ...(query.bladeId === undefined ? {} : { bladeProductId: query.bladeId }),
      ...(query.rubberId === undefined
        ? {}
        : {
            OR: [
              { rubberForehandProductId: query.rubberId },
              { rubberBackhandProductId: query.rubberId },
            ],
          }),
    };
    const order = query.order ?? 'desc';

    const [rows, total] = await Promise.all([
      this.prisma.player.findMany({
        where,
        select: listFields,
        // По рейтингу: список игроков читают как таблицу силы.
        orderBy: [{ rating: order }, { lastName: 'asc' }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.player.count({ where }),
    ]);

    // «Обновлён» — последнее событие журнала (ADR-054). Одним запросом на
    // страницу по индексу (playerId, createdAt), без колонки в проекции.
    const updated =
      rows.length === 0
        ? []
        : await this.prisma.ratingEvent.groupBy({
            by: ['playerId'],
            where: { playerId: { in: rows.map((row) => row.id) } },
            _max: { createdAt: true },
          });
    const updatedAt = new Map(updated.map((entry) => [entry.playerId, entry._max.createdAt]));

    return pageOf(
      rows.map((row) => ({
        ...toPlayerView(row),
        ratingUpdatedAt: updatedAt.get(row.id)?.toISOString() ?? null,
        blade: equipmentLabel(row.bladeProduct, row.blade),
        rubberForehand: equipmentLabel(row.rubberForehandProduct, row.rubberForehand),
        rubberBackhand: equipmentLabel(row.rubberBackhandProduct, row.rubberBackhand),
      })),
      total,
      query,
    );
  }

  /**
   * Кривая рейтинга — ТЗ 9.3, ТС 7.2.
   *
   * Отдаётся журнал, свёрнутый по турнирам, и текущее значение проекции.
   * Мест в турнирах здесь нет намеренно: их считает движок по таблицам и
   * сетке всего турнира (ADR-023), и повторять этот расчёт для каждого
   * турнира истории значило бы читать пол-базы ради одной колонки. Место
   * показывает страница результатов турнира, куда ведёт ссылка.
   */
  async ratingHistory(id: string, query: RatingHistoryQuery): Promise<RatingHistoryView> {
    const player = await this.load(id);

    const events = await this.prisma.ratingEvent.findMany({
      where: {
        playerId: id,
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              createdAt: {
                ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
                ...(query.to === undefined ? {} : { lte: new Date(query.to) }),
              },
            }),
      },
      select: ratingEventRowFields,
      orderBy: { createdAt: 'asc' },
    });

    return {
      playerId: id,
      current: player.rating.toString(),
      points: buildRatingPoints(events, id),
    };
  }

  /** История встреч — ТЗ 9.3, ТС 7.2. Свежие сверху: их и смотрят. */
  async matches(id: string, query: PlayerMatchesQuery): Promise<Page<PlayerMatchView>> {
    await this.load(id);

    const where = playedBy(id);

    const [rows, total] = await Promise.all([
      this.prisma.match.findMany({
        where,
        select: matchFields(id),
        orderBy: [{ finishedAt: { sort: 'desc', nulls: 'last' } }],
        skip: skipOf(query),
        take: query.limit,
      }),
      this.prisma.match.count({ where }),
    ]);

    return pageOf(await this.withOpponents(rows, id), total, query);
  }

  /**
   * Личный счёт против соперника — ТЗ 9.3, ТС 7.2.
   *
   * Встречи не разбиваются на страницы: их между двумя игроками единицы,
   * а итог обязан считаться по всем — по странице он был бы неверным.
   */
  async headToHead(id: string, opponentId: string): Promise<HeadToHeadView> {
    await this.load(id);
    const opponent = await this.findCompactById(opponentId);

    const rows = await this.prisma.match.findMany({
      where: {
        AND: [playedBy(id), playedBy(opponentId)],
      },
      select: matchFields(id),
      orderBy: [{ finishedAt: { sort: 'desc', nulls: 'last' } }],
    });

    const matches = await this.withOpponents(rows, id);

    return { playerId: id, opponent, ...summarize(matches), matches };
  }

  /**
   * Страница игрока — полный профиль вместе с анкетой ТЗ 2.2.
   *
   * Дата рождения (ADR-037) и тренер (ADR-066) прячутся от посторонних,
   * если игрок этого просил. Прячутся именно здесь, а не на экране:
   * спрятанное только в интерфейсе поле видно всякому, кто открыл сетевую
   * вкладку, — то есть не спрятано вовсе.
   */
  async findById(id: string, viewerId?: string): Promise<PlayerProfileView> {
    const player = await this.prisma.player.findUnique({ where: { id }, select: profileFields });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });
    }

    return this.profileView(player, await this.isInsider(player, viewerId));
  }

  /** Профиль с инвентарём: игроки товаров считаются одним запросом на все три слота. */
  private async profileView(player: ProfileRecord, insider = true): Promise<PlayerProfileView> {
    const products = [
      player.bladeProduct,
      player.rubberForehandProduct,
      player.rubberBackhandProduct,
    ].filter((product): product is ListItemRecord => product !== null && isVisible(product));
    const players = await countPlayers(this.prisma, [
      ...new Set(products.map((product) => product.id)),
    ]);

    return toProfileView(player, players, insider);
  }

  /**
   * Свои — сам игрок и организаторы его клуба: им видно спрятанное от
   * посторонних (ADR-037, ADR-066).
   *
   * Тот же круг, что вправе править профиль: организатор заводит игрока и
   * заполняет за него анкету, и прятать от него то, что он сам вписал,
   * бессмысленно. Форма правки к тому же получила бы пустое поле, и
   * сохранение стёрло бы спрятанное.
   */
  private async isInsider(
    player: {
      userId: string | null;
      clubId: string | null;
      birthYearOnly: boolean;
      coachVisibility: CoachVisibility;
    },
    viewerId: string | undefined,
  ): Promise<boolean> {
    // Прятать нечего — и клуб спрашивать незачем.
    if (!player.birthYearOnly && player.coachVisibility === 'ALL') return true;
    if (viewerId === undefined) return false;
    if (player.userId === viewerId) return true;

    return player.clubId !== null && (await this.isClubStaff(player.clubId, viewerId));
  }

  /** Краткий вид — для встраивания в чужой ответ. */
  private async findCompactById(id: string): Promise<PlayerView> {
    const player = await this.prisma.player.findUnique({ where: { id }, select: playerFields });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });
    }

    return toPlayerView(player);
  }

  /**
   * Заведение игрока — ТС 7.2.
   *
   * Контракт описывает этот маршрут как «создание организатором», но другого
   * способа завести профиль в нём нет, а ТЗ 2.2 требует профиль при
   * регистрации. Поэтому маршрут закрывает оба случая, и какой из них — решает
   * наличие профиля у вызывающего. Расхождение записано как ОВ-14.
   *
   * 1. У вызывающего профиля ещё нет — заводится его собственный, `userId`
   *    проставляется. Это регистрация по ТЗ 2.2
   * 2. Профиль есть — заводится чужой, без аккаунта, и тогда вызывающий обязан
   *    быть владельцем или организатором указанного клуба. `userId` остаётся
   *    пустым: это штатное состояние по комментарию к модели, связывание
   *    произойдёт, когда человек войдёт по своему телефону
   *
   * Свой профиль — анкета без рейтинга (ADR-072): рейтинг, турниры и место
   * в списке появятся, когда организатор её подтвердит или человек
   * привяжется к профилю, который организатор завёл ему на турнире. Чужой —
   * игровой профиль сразу, и стартовый рейтинг по уровню игры у него
   * обязателен (ADR-062).
   */
  async create(input: CreatePlayerInput, actorId: string): Promise<PlayerProfileView> {
    const { startRating, ...profile } = input;

    await this.places.assertCityAvailable(profile.cityId);
    await this.assertClubExists(profile.clubId);
    await this.assertCoachExists(profile.coachPlayerId);
    await this.assertEquipment(profile);

    const own = await this.prisma.player.findUnique({
      where: { userId: actorId },
      select: { id: true },
    });
    // Стартовый рейтинг задаёт организатор другому человеку (ADR-062):
    // такой профиль не становится своим, даже если своего у него ещё нет.
    const forSomeoneElse = own !== null || startRating !== undefined;

    if (forSomeoneElse) {
      if (input.clubId === undefined) {
        throw new AppError(
          ERROR_CODES.FORBIDDEN,
          'Creating a player for someone else requires a club',
        );
      }

      await this.assertClubStaff(input.clubId, actorId);

      if (startRating === undefined) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Start rating is required', {
          field: 'startRating',
        });
      }
    }

    // Тренер из анкеты открывает период истории — той же транзакцией (ADR-059).
    const created = await this.prisma.$transaction(async (tx) => {
      const player = await tx.player.create({
        data: {
          ...defined(profile),
          ...toBirthDate(profile.birthDate),
          ...(forSomeoneElse ? { confirmedAt: new Date() } : { userId: actorId }),
          ...(startRating === undefined ? {} : { rating: startRating }),
        },
        select: { id: true, coachPlayerId: true },
      });

      // Рейтинг меняется только через журнал (запрет №3 брифа): стартовая
      // оценка — событие INITIAL от общего старта, и пересчёт истории даёт то
      // же значение, что лежит в проекции.
      if (startRating !== undefined) {
        await tx.ratingEvent.create({
          data: {
            playerId: player.id,
            type: 'INITIAL',
            ratingBefore: START_RATING,
            delta: startRating - START_RATING,
            ratingAfter: startRating,
          },
        });
      }

      await switchCoach(tx, player.id, null, player.coachPlayerId);

      return tx.player.findUniqueOrThrow({ where: { id: player.id }, select: profileFields });
    });

    return this.profileView(created);
  }

  /**
   * Подтверждение анкеты организатором — ADR-072.
   *
   * Человек завёл анкету сам и пришёл на турнир. Второй профиль ему не
   * заводится: организатор подтверждает этот и задаёт рейтинг по уровню игры
   * — тем же событием INITIAL, что и при заведении (ADR-062).
   */
  async confirm(
    id: string,
    input: ConfirmPlayerInput,
    actorId: string,
  ): Promise<PlayerProfileView> {
    await this.assertClubStaff(input.clubId, actorId);

    const confirmed = await this.prisma.$transaction(async (tx) => {
      // Условие на пустоту: второе подтверждение переписало бы рейтинг мимо
      // журнала, а два организатора в зале нажимают одновременно.
      const changed = await tx.player.updateMany({
        where: { id, confirmedAt: null },
        data: { confirmedAt: new Date(), rating: input.startRating },
      });

      if (changed.count === 0) {
        const exists = await tx.player.findUnique({ where: { id }, select: { id: true } });

        throw exists === null
          ? new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id })
          : new AppError(ERROR_CODES.VALIDATION_FAILED, 'Player is already confirmed', { id });
      }

      await tx.ratingEvent.create({
        data: {
          playerId: id,
          type: 'INITIAL',
          ratingBefore: START_RATING,
          delta: input.startRating - START_RATING,
          ratingAfter: input.startRating,
        },
      });

      return tx.player.findUniqueOrThrow({ where: { id }, select: profileFields });
    });

    return this.profileView(confirmed);
  }

  /**
   * Привязка к игровому профилю — ADR-072, как «Мой рейтинг» у RTTF.
   *
   * Организатор завёл человеку профиль на турнире, а человек нашёл в нём
   * себя — при регистрации или позже. Своя анкета без рейтинга, если она
   * была, вливается в найденный профиль (`mergeInto`). Спортивное — имя, год,
   * пол, рейтинг — остаётся у профиля организатора: его видели в зале.
   */
  async claim(id: string, actorId: string): Promise<PlayerProfileView> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const target = await tx.player.findUnique({ where: { id }, select: mergeFields });

      if (target === null) throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });

      if (target.userId !== null) throw claimInvalid('TAKEN');

      if (target.confirmedAt === null) throw claimInvalid('NOT_CONFIRMED');

      const own = await tx.player.findUnique({ where: { userId: actorId }, select: mergeFields });

      if (own !== null) {
        if (own.confirmedAt !== null) throw claimInvalid('OWN_CONFIRMED');

        await mergeInto(tx, own, target);
      }

      // Условие на пустоту: между чтением и записью тем же профилем мог
      // назваться кто-то ещё.
      const linked = await tx.player.updateMany({
        where: { id, userId: null },
        data: { userId: actorId },
      });

      if (linked.count === 0) throw claimInvalid('TAKEN');

      return tx.player.findUniqueOrThrow({ where: { id }, select: profileFields });
    });

    return this.profileView(claimed);
  }

  async update(id: string, input: UpdatePlayerInput): Promise<PlayerProfileView> {
    const current = await this.findById(id);
    await this.places.assertCityAvailable(input.cityId, current.city.id);
    await this.assertClubExists(input.clubId ?? undefined);
    await this.assertCoachExists(input.coachPlayerId ?? undefined, id);
    await this.assertEquipment(
      input,
      await this.prisma.player.findUnique({
        where: { id },
        select: {
          bladeProductId: true,
          rubberForehandProductId: true,
          rubberBackhandProductId: true,
        },
      }),
    );

    // Смена тренера пишет историю и правит записи на турниры до старта той
    // же транзакцией (ADR-059, T3).
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.player.findUniqueOrThrow({
        where: { id },
        select: { coachPlayerId: true, coachName: true },
      });
      const after = await tx.player.update({
        where: { id },
        data: { ...defined(input), ...toBirthDate(input.birthDate) },
        select: { coachPlayerId: true, coachName: true },
      });

      await switchCoach(tx, id, before.coachPlayerId, after.coachPlayerId);

      if (before.coachPlayerId !== after.coachPlayerId || before.coachName !== after.coachName) {
        await followProfileCoach(tx, id, after);
      }

      return tx.player.findUniqueOrThrow({ where: { id }, select: profileFields });
    });

    return this.profileView(updated);
  }

  /**
   * Кто вправе править профиль: сам игрок или организатор его клуба.
   *
   * Проверка живёт в сервисе, а не в guard'е: она зависит от клуба, который
   * записан у игрока, а не от параметра маршрута. Guard'у пришлось бы читать
   * ту же строку из базы, и проверка раздвоилась бы.
   */
  async assertCanEdit(playerId: string, userId: string): Promise<void> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { userId: true, clubId: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id: playerId });
    }

    if (player.userId === userId) return;

    if (player.clubId !== null && (await this.isClubStaff(player.clubId, userId))) return;

    throw new AppError(ERROR_CODES.FORBIDDEN, 'Not allowed to edit this player', { id: playerId });
  }

  /**
   * Владелец или организатор клуба.
   *
   * Судья не в счёт: по ТЗ 1 он ведёт конкретный турнир, управление клубом в
   * его доступ не входит.
   */
  private async isClubStaff(clubId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } },
      select: { role: true },
    });

    return membership !== null && membership.role !== 'REFEREE';
  }

  private async assertClubStaff(clubId: string, userId: string): Promise<void> {
    if (!(await this.isClubStaff(clubId, userId))) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Insufficient club role', { clubId });
    }
  }

  private async assertCoachExists(coachId: string | undefined, playerId?: string): Promise<void> {
    await assertCoachExists(this.prisma, coachId, playerId);
  }

  /**
   * Инвентарь из каталога: товар существует, виден в каталоге и подходит
   * слоту — основание BLADE, накладки RUBBER (ADR-058). Уже записанный товар
   * остаётся и после скрытия: повторная отправка той же формы не падает.
   */
  private async assertEquipment(input: EquipmentIds, current?: EquipmentIds | null): Promise<void> {
    const wanted = EQUIPMENT_SLOTS.flatMap(([field, category]) => {
      const id = input[field];

      return typeof id === 'string' && id !== current?.[field] ? [{ field, category, id }] : [];
    });

    if (wanted.length === 0) return;

    const products = await this.prisma.product.findMany({
      where: { id: { in: wanted.map((slot) => slot.id) }, ...VISIBLE },
      select: { id: true, category: true },
    });
    const categories = new Map(products.map((product) => [product.id, product.category]));

    for (const slot of wanted) {
      if (categories.get(slot.id) !== slot.category) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Product does not fit the slot', {
          field: slot.field,
        });
      }
    }
  }

  /** Ссылка на несуществующий клуб иначе упала бы отказом внешнего ключа. */
  /**
   * Подстановка соперников одним запросом.
   *
   * Иначе на странице в двадцать встреч уходит двадцать запросов, а игрок
   * в турнире встречается с одними и теми же людьми не по разу.
   */
  private async withOpponents(
    rows: readonly MatchRow[],
    playerId: string,
  ): Promise<PlayerMatchView[]> {
    const ids = [
      ...new Set(
        rows
          .map((row) => (row.playerAId === playerId ? row.playerBId : row.playerAId))
          .filter((id): id is string => id !== null),
      ),
    ];

    const players = await this.prisma.player.findMany({
      where: { id: { in: ids } },
      select: playerFields,
    });

    const byId = new Map(players.map((player) => [player.id, toPlayerView(player)]));

    return rows.map((row) => toPlayerMatch(row, playerId, byId));
  }

  private async load(id: string): Promise<{ id: string; rating: Prisma.Decimal }> {
    const player = await this.prisma.player.findUnique({
      where: { id },
      select: { id: true, rating: true },
    });

    if (player === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Player not found', { id });
    }

    return player;
  }

  private async assertClubExists(clubId: string | undefined): Promise<void> {
    if (clubId === undefined) return;

    const club = await this.prisma.club.findUnique({ where: { id: clubId }, select: { id: true } });

    if (club === null) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Club not found', { clubId });
    }
  }
}

/** Поля анкеты, которые при привязке переносятся в пустые места профиля. */
const MERGED_FIELDS = [
  'middleName',
  'photoUrl',
  'clubId',
  'playingHand',
  'grip',
  'blade',
  'rubberForehand',
  'rubberBackhand',
  'bladeProductId',
  'rubberForehandProductId',
  'rubberBackhandProductId',
  'bio',
] as const;

const mergeFields = {
  id: true,
  userId: true,
  confirmedAt: true,
  birthYear: true,
  birthDate: true,
  birthYearOnly: true,
  coachPlayerId: true,
  coachName: true,
  coachVisibility: true,
  coachPage: { select: { id: true } },
  middleName: true,
  photoUrl: true,
  clubId: true,
  playingHand: true,
  grip: true,
  blade: true,
  rubberForehand: true,
  rubberBackhand: true,
  bladeProductId: true,
  rubberForehandProductId: true,
  rubberBackhandProductId: true,
  bio: true,
} as const satisfies Prisma.PlayerSelect & Record<(typeof MERGED_FIELDS)[number], true>;

type MergeRecord = Prisma.PlayerGetPayload<{ select: typeof mergeFields }>;

function claimInvalid(
  reason: 'TAKEN' | 'OWN_CONFIRMED' | 'NOT_CONFIRMED' | 'COACH_PAGE',
): AppError {
  return new AppError(ERROR_CODES.PLAYER_CLAIM_INVALID, 'Cannot claim this player', { reason });
}

/**
 * Анкета вливается в профиль организатора — ADR-072.
 *
 * Анкета без рейтинга не бывает ни в турнирах, ни в журнале, поэтому
 * переносить приходится только то, что живёт вне спорта: пустые поля
 * анкеты, тренера с историей, страницу тренера, учеников и дуэли. Остальное
 * уходит каскадом вместе с самой анкетой.
 */
async function mergeInto(
  tx: Prisma.TransactionClient,
  own: MergeRecord,
  target: MergeRecord,
): Promise<void> {
  if (own.coachPage !== null && target.coachPage !== null) throw claimInvalid('COACH_PAGE');

  const data: Prisma.PlayerUncheckedUpdateInput = {};

  for (const field of MERGED_FIELDS) {
    if (target[field] === null && own[field] !== null) Object.assign(data, { [field]: own[field] });
  }

  // Дата — только того же года: год у профиля организатора, и расходиться
  // с ним дата не вправе (createPlayerSchema).
  if (
    target.birthDate === null &&
    own.birthDate !== null &&
    own.birthDate.getUTCFullYear() === target.birthYear
  ) {
    data.birthDate = own.birthDate;
    data.birthYearOnly = own.birthYearOnly;
  }

  // Тренер — парой и вместе с историей: анкета хранит одно из двух.
  const takesCoach =
    target.coachPlayerId === null &&
    target.coachName === null &&
    (own.coachPlayerId !== null || own.coachName !== null) &&
    own.coachPlayerId !== target.id;

  if (takesCoach) {
    data.coachPlayerId = own.coachPlayerId;
    data.coachName = own.coachName;
    data.coachVisibility = own.coachVisibility;
    await tx.coachTenure.updateMany({ where: { playerId: own.id }, data: { playerId: target.id } });
  }

  await tx.coach.updateMany({ where: { playerId: own.id }, data: { playerId: target.id } });
  await tx.coachTenure.updateMany({
    where: { coachPlayerId: own.id, playerId: { not: target.id } },
    data: { coachPlayerId: target.id },
  });
  await tx.player.updateMany({
    where: { coachPlayerId: own.id, id: { not: target.id } },
    data: { coachPlayerId: target.id },
  });
  await tx.registration.updateMany({
    where: { coachPlayerId: own.id },
    data: { coachPlayerId: target.id },
  });
  await tx.duel.updateMany({ where: { authorId: own.id }, data: { authorId: target.id } });
  await tx.duel.updateMany({ where: { opponentId: own.id }, data: { opponentId: target.id } });
  await tx.duelResponse.updateMany({ where: { playerId: own.id }, data: { playerId: target.id } });
  // Анкета освобождает аккаунт раньше, чем профиль его получит: userId уникален.
  await tx.player.delete({ where: { id: own.id } });

  if (Object.keys(data).length > 0) await tx.player.update({ where: { id: target.id }, data });
}

export interface PlayerRecord {
  id: string;
  userId: string | null;
  lastName: string;
  firstName: string;
  middleName: string | null;
  birthYear: number;
  gender: string;
  city: CityRef;
  photoUrl: string | null;
  clubId: string | null;
  rating: { toString: () => string };
  ratedMatches: number;
  isProvisional: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
}

interface ProfileRecord extends PlayerRecord {
  birthDate: Date | null;
  birthYearOnly: boolean;
  playingHand: string | null;
  grip: string | null;
  blade: string | null;
  rubberForehand: string | null;
  rubberBackhand: string | null;
  bladeProduct: ListItemRecord | null;
  rubberForehandProduct: ListItemRecord | null;
  rubberBackhandProduct: ListItemRecord | null;
  bio: string | null;
  coachPlayerId: string | null;
  coachName: string | null;
  coachVisibility: CoachVisibility;
  coach: {
    lastName: string;
    firstName: string;
    coachPage: { slug: string; status: CoachStatus; hiddenAt: Date | null } | null;
  } | null;
  coachPage: { slug: string; status: CoachStatus; hiddenAt: Date | null } | null;
  user: { lastSeenAt: Date | null } | null;
  coachTenures: TenureRecord[];
}

interface TenureRecord {
  coachPlayerId: string;
  from: Date;
  to: Date | null;
  coachPlayer: {
    lastName: string;
    firstName: string;
    coachPage: { slug: string; status: CoachStatus; hiddenAt: Date | null } | null;
  };
}

/**
 * Дата рождения приходит строкой `YYYY-MM-DD`, а колонка — `DATE`.
 *
 * Полночь по UTC, а не по местному времени: `new Date('2001-04-12')` в поясе
 * Алматы легла бы в базу одиннадцатым апреля.
 */
function toBirthDate(value: string | null | undefined): { birthDate?: Date | null } {
  if (value === undefined) return {};

  return { birthDate: value === null ? null : new Date(`${value}T00:00:00.000Z`) };
}

/**
 * Подпись инвентаря в списке: товар каталога со ссылкой, иначе строка анкеты.
 * Скрытый товар — как будто его нет: остаётся строка, если она есть.
 */
export function equipmentLabel(
  product: LabelProduct | null,
  text: string | null,
): EquipmentLabel | null {
  if (product !== null && isVisible(product)) {
    return { label: `${product.brand.name} ${product.name}`, slug: product.slug };
  }

  return text === null ? null : { label: text, slug: null };
}

function equipmentProduct(
  product: ListItemRecord | null,
  players: ReadonlyMap<string, number>,
): ProductListItemView | null {
  return product === null || !isVisible(product)
    ? null
    : toListItemView(product, players.get(product.id) ?? 0);
}

/**
 * `insider` — смотрит сам игрок или организатор его клуба: им видно всё.
 * Постороннему спрятанное приходит пустым, как незаполненное: иначе ответ
 * сообщает, что прятать было что (ADR-037, ADR-066).
 */
function toProfileView(
  player: ProfileRecord,
  players: ReadonlyMap<string, number>,
  insider = true,
  now: Date = new Date(),
): PlayerProfileView {
  const lastSeenAt = player.user?.lastSeenAt ?? null;
  const showCoach = insider || player.coachVisibility !== 'NONE';
  const showHistory = insider || player.coachVisibility === 'ALL';

  return {
    ...toPlayerView(player),
    // Скрытая дата и незаполненная выглядят одинаково — `null`. Постороннему
    // они и обязаны выглядеть одинаково: иначе ответ сообщает, что дата есть.
    birthDate:
      player.birthDate === null || (player.birthYearOnly && !insider)
        ? null
        : player.birthDate.toISOString().slice(0, 10),
    birthYearOnly: player.birthYearOnly,
    playingHand: player.playingHand,
    grip: player.grip,
    blade: player.blade,
    rubberForehand: player.rubberForehand,
    rubberBackhand: player.rubberBackhand,
    bladeProduct: equipmentProduct(player.bladeProduct, players),
    rubberForehandProduct: equipmentProduct(player.rubberForehandProduct, players),
    rubberBackhandProduct: equipmentProduct(player.rubberBackhandProduct, players),
    bio: player.bio,
    ...(showCoach ? currentCoach(player) : NO_COACH),
    // Прежние тренеры, последние первыми.
    coachHistory: (showHistory ? player.coachTenures : [])
      .flatMap((tenure) => (tenure.to === null ? [] : [{ ...tenure, to: tenure.to }]))
      .sort((a, b) => b.to.getTime() - a.to.getTime())
      .map((tenure) => ({
        coachPlayerId: tenure.coachPlayerId,
        name: `${tenure.coachPlayer.lastName} ${tenure.coachPlayer.firstName}`,
        slug: publicCoachSlug(tenure.coachPlayer.coachPage),
        from: tenure.from.toISOString(),
        to: tenure.to.toISOString(),
      })),
    coachVisibility: player.coachVisibility,
    ownCoachSlug: publicCoachSlug(player.coachPage),
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    online: isOnline(lastSeenAt, now),
  };
}

type CurrentCoach = Pick<
  PlayerProfileView,
  'coachPlayerId' | 'coachName' | 'coachSlug' | 'coachSince'
>;

/** Тренер, спрятанный от постороннего (ADR-066), — как не указанный. */
const NO_COACH: CurrentCoach = {
  coachPlayerId: null,
  coachName: null,
  coachSlug: null,
  coachSince: null,
};

function currentCoach(player: ProfileRecord): CurrentCoach {
  return {
    coachPlayerId: player.coachPlayerId,
    // Выбранный из списка тренер подставляется по связи, вписанный руками
    // отдаётся как есть: экран показывает одно поле, а не развилку.
    coachName:
      player.coach === null
        ? player.coachName
        : `${player.coach.lastName} ${player.coach.firstName}`,
    coachSlug: publicCoachSlug(player.coach?.coachPage ?? null),
    coachSince:
      player.coachTenures
        .find((tenure) => tenure.to === null && tenure.coachPlayerId === player.coachPlayerId)
        ?.from.toISOString() ?? null,
  };
}

/**
 * «В сети» — посещение в окне пяти минут. Отметка из будущего (часы базы
 * и API разошлись) тоже считается присутствием: человек точно только что был.
 */
export function isOnline(lastSeenAt: Date | null, now: Date): boolean {
  return lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < ONLINE_WINDOW_MS;
}

/** Условие рейтинга списка — правило границ в `ratingBounds`. */
function ratingRange(from: number | undefined, to: number | undefined) {
  if (from === undefined && to === undefined) {
    return {};
  }

  return { rating: ratingBounds(from, to) };
}

/**
 * Поиск по ФИО словами — ADR-054.
 *
 * «Ким Артём» и «Артём Ким» находят одного человека: каждое слово обязано
 * найтись в фамилии, имени или отчестве, порядок не важен. Составное поле в
 * базе не хранится.
 */
export function nameWords(search: string) {
  return search
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => ({
      OR: [
        { lastName: { contains: word, mode: 'insensitive' as const } },
        { firstName: { contains: word, mode: 'insensitive' as const } },
        { middleName: { contains: word, mode: 'insensitive' as const } },
      ],
    }));
}

export function toPlayerView(player: PlayerRecord): PlayerView {
  return {
    id: player.id,
    userId: player.userId,
    lastName: player.lastName,
    firstName: player.firstName,
    middleName: player.middleName,
    birthYear: player.birthYear,
    gender: player.gender,
    city: player.city,
    photoUrl: player.photoUrl,
    clubId: player.clubId,
    // Рейтинг приходит из Decimal и уезжает строкой. Через number он потерял
    // бы точность — а бриф ставит корректность рейтинга приоритетом №1.
    rating: player.rating.toString(),
    ratedMatches: player.ratedMatches,
    isProvisional: player.isProvisional,
    confirmed: player.confirmedAt !== null,
    createdAt: player.createdAt.toISOString(),
  };
}
