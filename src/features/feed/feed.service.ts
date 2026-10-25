import { ratingLevel } from '@kttf/shared/rating';
import {
  FEED_EXCERPT_MAX,
  FEED_POPULAR_POSTS_PER_WEEK,
  FEED_PORTAL_SECTION,
  FEED_POSTS_SECTION,
  FEED_WINDOW_DAYS,
  type FeedDiscussion,
  type FeedItem,
  type FeedPage,
  type FeedQuery,
  type FeedSource,
} from '@kttf/shared/types';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { FollowsService, type FollowedTargets } from '../follows/follows.service.js';
import { parseImages } from '../forum/forum-views.js';
import { OCCUPYING_STATUSES } from '../tournaments/tournaments.select.js';
import { TournamentsService } from '../tournaments/tournaments.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Из каждого источника — не больше стольких свежих записей. */
const PER_SOURCE = 100;

/**
 * Насколько дольше карточка держится наверху — в часах. Клубы, тренеры и
 * новости KTTF — главное в ленте; события игроков и их записи — по времени.
 */
const BOOST_HOURS: Readonly<Record<FeedItem['type'], number>> = {
  PORTAL: 72,
  POST: 48,
  TOURNAMENT: 24,
  RESULT: 12,
  ACHIEVEMENT: 0,
  PLAYER_POST: 0,
};

/** На сколько часов «Для вас» поднимает своё: подписки, свой город, своё. */
const RELEVANCE_HOURS = 48;

/** Карточка-кандидат и то, по чему её отбирают вкладки. */
interface Candidate {
  readonly item: FeedItem;
  /** Город карточки — для «Для вас». `null` — карточка не про место. */
  readonly cityId: string | null;
  readonly clubs: readonly string[];
  readonly coaches: readonly string[];
  readonly players: readonly string[];
  /** Запись игрока прошла в общие вкладки — среди самых читаемых за неделю. */
  readonly popular?: boolean;
  /** Видна только подписчикам игрока и ему самому — медаль, новый уровень. */
  readonly personal?: boolean;
}

function fullName(player: { lastName: string; firstName: string }): string {
  return `${player.lastName} ${player.firstName}`;
}

/** Начало текста карточки: по границе слова, с многоточием. */
export function excerpt(text: string): string {
  const clean = text.replace(/\s+\n/g, '\n').trim();
  if (clean.length <= FEED_EXCERPT_MAX) return clean;

  const cut = clean.slice(0, FEED_EXCERPT_MAX);
  const space = cut.lastIndexOf(' ');

  return `${(space > FEED_EXCERPT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Порядок ленты: время карточки плюс вес источника. */
export function rankOf(item: FeedItem): number {
  return Date.parse(item.at) + BOOST_HOURS[item.type] * HOUR_MS;
}

/**
 * Самые читаемые записи игроков — по неделям от текущего момента: просмотры,
 * «нравится» и ответы с весами. Остальные видны подписчикам автора и на
 * форуме, но не в общей ленте.
 */
export function popularPosts(
  posts: readonly { id: string; at: string; discussion: FeedDiscussion | null }[],
  now: Date,
): Set<string> {
  const weeks = new Map<number, { id: string; score: number }[]>();

  for (const post of posts) {
    const week = Math.floor((now.getTime() - Date.parse(post.at)) / (7 * DAY_MS));
    const stats = post.discussion;
    const score = stats === null ? 0 : stats.views + 5 * stats.likes + 3 * stats.comments;
    weeks.set(week, [...(weeks.get(week) ?? []), { id: post.id, score }]);
  }

  return new Set(
    [...weeks.values()].flatMap((group) =>
      group
        .sort((left, right) => right.score - left.score)
        .slice(0, FEED_POPULAR_POSTS_PER_WEEK)
        .map((post) => post.id),
    ),
  );
}

/**
 * Лента главной — ADR-073.
 *
 * Собирается на лету из своих таблиц за окно в 60 дней: на пилотной базе это
 * несколько сотен строк. Когда источников станет много, это место для
 * витрины `FeedItem`, которую пишут сами события.
 */
@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly follows: FollowsService,
    private readonly tournaments: TournamentsService,
  ) {}

  async feed(query: FeedQuery, userId?: string, now = new Date()): Promise<FeedPage> {
    const since = new Date(now.getTime() - FEED_WINDOW_DAYS * DAY_MS);
    const [followed, me] = await Promise.all([
      this.follows.targetsOf(userId),
      userId === undefined
        ? null
        : this.prisma.player.findUnique({ where: { userId }, select: { id: true, cityId: true } }),
    ]);

    const batches = await Promise.all([
      this.clubPosts(since),
      this.coachPosts(since),
      this.topics(FEED_PORTAL_SECTION, since),
      this.topics(FEED_POSTS_SECTION, since),
      this.announced(since, now),
      this.results(since),
      this.levelUps(since),
    ]);
    const candidates = batches.flat();
    const popular = popularPosts(
      candidates.filter((c) => c.item.type === 'PLAYER_POST').map((c) => c.item),
      now,
    );
    const withPopular = candidates.map((c) =>
      c.item.type === 'PLAYER_POST' ? { ...c, popular: popular.has(c.item.id) } : c,
    );

    // «Для вас» не прячет общее, а поднимает своё: подписки, свой город и
    // своё — на сутки-двое выше. Иначе у новичка из другого города лента
    // пустела бы до первой подписки.
    const lift = (c: Candidate) =>
      query.tab === 'FOR_YOU' && relevant(c, followed, me) ? RELEVANCE_HOURS * HOUR_MS : 0;
    const chosen = withPopular
      .filter((c) => this.fits(c, query.tab, followed, me, userId !== undefined))
      .map((c) => ({ item: c.item, rank: rankOf(c.item) + lift(c) }))
      .sort((left, right) => right.rank - left.rank)
      .map((entry) => entry.item);
    const start = (query.page - 1) * query.limit;

    return {
      tab: query.tab,
      items: chosen.slice(start, start + query.limit),
      total: chosen.length,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Попадает ли карточка во вкладку. */
  private fits(
    candidate: Candidate,
    tab: FeedQuery['tab'],
    followed: FollowedTargets,
    me: { id: string; cityId: string } | null,
    signedIn: boolean,
  ): boolean {
    const mine = me !== null && candidate.players.includes(me.id);
    const follows =
      candidate.clubs.some((id) => followed.clubs.has(id)) ||
      candidate.coaches.some((id) => followed.coaches.has(id)) ||
      candidate.players.some((id) => followed.players.has(id));

    if (tab === 'FOLLOWING') return signedIn && follows;

    // Медаль и уровень — личное: подписчикам игрока и ему самому.
    if (candidate.personal === true) return tab === 'FOR_YOU' && (follows || mine);

    const general = candidate.item.type !== 'PLAYER_POST' || candidate.popular === true;

    // «Для вас» — всё общее и записи тех, на кого подписан; своё
    // поднимается выше при сортировке.
    return general || (tab === 'FOR_YOU' && (follows || mine));
  }

  // ------------------------------------------------------------ источники

  private async clubPosts(since: Date): Promise<Candidate[]> {
    const rows = await this.prisma.clubPost.findMany({
      where: { hiddenAt: null, publishedAt: { gte: since }, club: { hiddenAt: null } },
      orderBy: { publishedAt: 'desc' },
      take: PER_SOURCE,
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        imageUrl: true,
        validUntil: true,
        publishedAt: true,
        club: { select: { id: true, name: true, logoUrl: true, cityId: true } },
      },
    });
    const discussions = await this.discussions(
      'CLUB_POST',
      rows.map((row) => row.id),
    );

    return rows.map((row) => ({
      item: {
        id: `club-post:${row.id}`,
        type: 'POST',
        at: row.publishedAt.toISOString(),
        source: {
          kind: 'CLUB',
          id: row.club.id,
          name: row.club.name,
          imageUrl: row.club.logoUrl,
          slug: null,
        },
        discussion: discussions.get(row.id) ?? null,
        kind: row.kind,
        title: row.title,
        excerpt: excerpt(row.body),
        imageUrl: row.imageUrl,
        validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
      },
      cityId: row.club.cityId,
      clubs: [row.club.id],
      coaches: [],
      players: [],
    }));
  }

  private async coachPosts(since: Date): Promise<Candidate[]> {
    const rows = await this.prisma.coachPost.findMany({
      where: {
        hiddenAt: null,
        publishedAt: { gte: since },
        coach: { status: 'APPROVED', hiddenAt: null },
      },
      orderBy: { publishedAt: 'desc' },
      take: PER_SOURCE,
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        imageUrl: true,
        validUntil: true,
        publishedAt: true,
        coach: {
          select: {
            id: true,
            slug: true,
            photoUrl: true,
            cityId: true,
            player: { select: { id: true, lastName: true, firstName: true, photoUrl: true } },
          },
        },
      },
    });
    const discussions = await this.discussions(
      'COACH_POST',
      rows.map((row) => row.id),
    );

    return rows.map((row) => ({
      item: {
        id: `coach-post:${row.id}`,
        type: 'POST',
        at: row.publishedAt.toISOString(),
        source: {
          kind: 'COACH',
          id: row.coach.id,
          name: fullName(row.coach.player),
          imageUrl: row.coach.photoUrl ?? row.coach.player.photoUrl,
          slug: row.coach.slug,
        },
        discussion: discussions.get(row.id) ?? null,
        kind: row.kind,
        title: row.title,
        excerpt: excerpt(row.body),
        imageUrl: row.imageUrl,
        validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
      },
      cityId: row.coach.cityId,
      clubs: [],
      coaches: [row.coach.id],
      players: [row.coach.player.id],
    }));
  }

  /** Новости KTTF и записи игроков — темы своих разделов форума. */
  private async topics(section: string, since: Date): Promise<Candidate[]> {
    const portal = section === FEED_PORTAL_SECTION;
    const rows = await this.prisma.forumTopic.findMany({
      where: { section: { slug: section }, hiddenAt: null, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: PER_SOURCE,
      select: {
        id: true,
        title: true,
        createdAt: true,
        postsCount: true,
        viewsCount: true,
        posts: {
          where: { number: 1 },
          select: { body: true, images: true, likesCount: true, deletedAt: true, hiddenAt: true },
        },
        author: {
          select: {
            player: {
              select: {
                id: true,
                lastName: true,
                firstName: true,
                photoUrl: true,
                cityId: true,
              },
            },
          },
        },
      },
    });

    return rows.flatMap((row): Candidate[] => {
      const first = row.posts[0];
      const player = row.author?.player ?? null;

      // Первое сообщение стёрто или скрыто — показывать в карточке нечего.
      if (first?.deletedAt !== null || first.hiddenAt !== null) return [];
      if (!portal && player === null) return [];

      const source: FeedSource =
        portal || player === null
          ? { kind: 'KTTF', id: null, name: 'KTTF', imageUrl: null, slug: null }
          : {
              kind: 'PLAYER',
              id: player.id,
              name: fullName(player),
              imageUrl: player.photoUrl,
              slug: null,
            };

      return [
        {
          item: {
            id: `topic:${row.id}`,
            type: portal ? 'PORTAL' : 'PLAYER_POST',
            at: row.createdAt.toISOString(),
            source,
            discussion: {
              topicId: row.id,
              comments: Math.max(0, row.postsCount - 1),
              likes: first.likesCount,
              views: row.viewsCount,
            },
            title: row.title,
            excerpt: excerpt(first.body),
            images: parseImages(first.images),
          },
          cityId: portal ? null : (player?.cityId ?? null),
          clubs: [],
          coaches: [],
          players: portal || player === null ? [] : [player.id],
        },
      ];
    });
  }

  /** Объявленные турниры, которые ещё впереди. */
  private async announced(since: Date, now: Date): Promise<Candidate[]> {
    const rows = await this.prisma.tournament.findMany({
      where: {
        status: { in: ['PUBLISHED', 'REG_OPEN', 'REG_CLOSED'] },
        startsAt: { gte: now },
        createdAt: { gte: since },
        club: { hiddenAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take: PER_SOURCE,
      select: {
        id: true,
        name: true,
        startsAt: true,
        status: true,
        createdAt: true,
        ratingCapMin: true,
        ratingCapMax: true,
        maxParticipants: true,
        club: { select: { id: true, name: true, logoUrl: true, cityId: true } },
        _count: { select: { registrations: { where: { status: { in: OCCUPYING_STATUSES } } } } },
      },
    });

    return rows.map((row) => ({
      item: {
        id: `tournament:${row.id}`,
        type: 'TOURNAMENT',
        at: row.createdAt.toISOString(),
        source: clubSource(row.club),
        discussion: null,
        tournament: {
          id: row.id,
          name: row.name,
          startsAt: row.startsAt.toISOString(),
          status: row.status,
          club: { id: row.club.id, name: row.club.name },
          ratingCapMin: row.ratingCapMin?.toString() ?? null,
          ratingCapMax: row.ratingCapMax?.toString() ?? null,
          participants: row._count.registrations,
          maxParticipants: row.maxParticipants,
        },
      },
      cityId: row.club.cityId,
      clubs: [row.club.id],
      coaches: [],
      players: [],
    }));
  }

  /** Итоги турниров с тройкой и медали призёров — отдельными личными карточками. */
  private async results(since: Date): Promise<Candidate[]> {
    const finished = await this.prisma.tournament.findMany({
      where: { status: { in: ['FINISHED', 'RATED'] }, finishedAt: { gte: since } },
      orderBy: { finishedAt: 'desc' },
      take: PER_SOURCE,
      select: { id: true },
    });
    const ids = finished.map((row) => row.id);

    // Турниры, завершённые до ADR-048, мест не записали — досчитываются.
    await this.tournaments.ensurePlaces(ids);

    const rows = await this.prisma.tournament.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        startsAt: true,
        finishedAt: true,
        club: { select: { id: true, name: true, logoUrl: true, cityId: true } },
        _count: { select: { registrations: { where: { status: { in: OCCUPYING_STATUSES } } } } },
        registrations: {
          where: { place: { lte: 3 } },
          orderBy: { place: 'asc' },
          select: {
            place: true,
            placeTo: true,
            player: {
              select: { id: true, lastName: true, firstName: true, photoUrl: true },
            },
          },
        },
      },
    });

    return rows.flatMap((row): Candidate[] => {
      if (row.registrations.length === 0) return [];

      const at = (row.finishedAt ?? row.startsAt).toISOString();
      const tournament = { id: row.id, name: row.name, startsAt: row.startsAt.toISOString() };
      const podium = row.registrations.flatMap((registration) =>
        registration.place === null ? [] : [{ ...registration, place: registration.place }],
      );

      const result: Candidate = {
        item: {
          id: `result:${row.id}`,
          type: 'RESULT',
          at,
          source: clubSource(row.club),
          discussion: null,
          tournament: { ...tournament, club: { id: row.club.id, name: row.club.name } },
          participants: row._count.registrations,
          places: podium.map((entry) => ({
            place: entry.place,
            placeTo: entry.placeTo,
            playerId: entry.player.id,
            name: fullName(entry.player),
          })),
        },
        cityId: row.club.cityId,
        clubs: [row.club.id],
        coaches: [],
        players: podium.map((entry) => entry.player.id),
      };

      const medals = podium.flatMap((entry): Candidate[] =>
        entry.place > 3
          ? []
          : [
              {
                item: {
                  id: `medal:${row.id}:${entry.player.id}`,
                  type: 'ACHIEVEMENT',
                  at,
                  source: playerSource(entry.player),
                  discussion: null,
                  achievement: { kind: 'MEDAL', place: entry.place, tournament },
                },
                cityId: row.club.cityId,
                clubs: [],
                coaches: [],
                players: [entry.player.id],
                personal: true,
              },
            ],
      );

      return [result, ...medals];
    });
  }

  /**
   * Новый уровень (ADR-070) — по журналу: рейтинг до первого и после
   * последнего события турнира или дуэли. Стартовая оценка организатора —
   * не достижение, её нет.
   */
  private async levelUps(since: Date): Promise<Candidate[]> {
    const events = await this.prisma.ratingEvent.findMany({
      where: { createdAt: { gte: since }, type: { not: 'INITIAL' } },
      orderBy: { createdAt: 'asc' },
      select: {
        playerId: true,
        tournamentId: true,
        duelId: true,
        ratingBefore: true,
        ratingAfter: true,
        createdAt: true,
        tournament: { select: { id: true, name: true, startsAt: true } },
      },
    });

    const runs = new Map<string, (typeof events)[number][]>();
    for (const event of events) {
      const key = `${event.playerId}:${event.tournamentId ?? event.duelId ?? event.createdAt.toISOString()}`;
      runs.set(key, [...(runs.get(key) ?? []), event]);
    }

    // Уровень — новый, только если выше всего, что игрок уже держал: упал
    // и вернулся — не достижение. Серии идут по времени своего конца.
    const best = new Map<string, number>();
    const ups = [...runs.values()]
      .sort(
        (left, right) =>
          (left.at(-1)?.createdAt.getTime() ?? 0) - (right.at(-1)?.createdAt.getTime() ?? 0),
      )
      .flatMap((run) => {
        const first = run[0];
        const last = run.at(-1);
        if (first === undefined || last === undefined) return [];

        const held = best.get(first.playerId) ?? ratingLevel(Number(first.ratingBefore));
        const after = ratingLevel(Number(last.ratingAfter));
        best.set(first.playerId, Math.max(held, after));

        return after > held ? [{ last, level: after }] : [];
      });
    const players = await this.prisma.player.findMany({
      where: { id: { in: [...new Set(ups.map((up) => up.last.playerId))] } },
      select: { id: true, lastName: true, firstName: true, photoUrl: true, cityId: true },
    });
    const byId = new Map(players.map((player) => [player.id, player]));

    return ups.flatMap(({ last, level }): Candidate[] => {
      const player = byId.get(last.playerId);
      if (player === undefined) return [];

      return [
        {
          item: {
            id: `level:${last.playerId}:${last.tournamentId ?? last.duelId ?? last.createdAt.toISOString()}`,
            type: 'ACHIEVEMENT',
            at: last.createdAt.toISOString(),
            source: playerSource(player),
            discussion: null,
            achievement: {
              kind: 'LEVEL_UP',
              level,
              rating: last.ratingAfter.toString(),
              tournament:
                last.tournament === null
                  ? null
                  : {
                      id: last.tournament.id,
                      name: last.tournament.name,
                      startsAt: last.tournament.startsAt.toISOString(),
                    },
            },
          },
          cityId: player.cityId,
          clubs: [],
          coaches: [],
          players: [player.id],
          // Уровней за турнир — десяток; в общей ленте они заслонили бы всё.
          personal: true,
        },
      ];
    });
  }

  /** Тема обсуждения записи клуба или тренера и её счётчики. */
  private async discussions(
    type: 'CLUB_POST' | 'COACH_POST',
    ids: readonly string[],
  ): Promise<Map<string, FeedDiscussion>> {
    if (ids.length === 0) return new Map();

    const topics = await this.prisma.forumTopic.findMany({
      where: { subjectType: type, subjectId: { in: [...ids] }, hiddenAt: null },
      select: {
        id: true,
        subjectId: true,
        postsCount: true,
        viewsCount: true,
        posts: { where: { number: 1 }, select: { likesCount: true } },
      },
    });

    return new Map(
      topics.flatMap((topic) =>
        topic.subjectId === null
          ? []
          : [
              [
                topic.subjectId,
                {
                  topicId: topic.id,
                  comments: Math.max(0, topic.postsCount - 1),
                  likes: topic.posts[0]?.likesCount ?? 0,
                  views: topic.viewsCount,
                },
              ] as const,
            ],
      ),
    );
  }
}

function clubSource(club: { id: string; name: string; logoUrl: string | null }): FeedSource {
  return { kind: 'CLUB', id: club.id, name: club.name, imageUrl: club.logoUrl, slug: null };
}

function playerSource(player: {
  id: string;
  lastName: string;
  firstName: string;
  photoUrl: string | null;
}): FeedSource {
  return {
    kind: 'PLAYER',
    id: player.id,
    name: fullName(player),
    imageUrl: player.photoUrl,
    slug: null,
  };
}

/** Своё для «Для вас»: подписки, свой город или сам человек в карточке. */
function relevant(
  candidate: Candidate,
  followed: FollowedTargets,
  me: { id: string; cityId: string } | null,
): boolean {
  return (
    candidate.clubs.some((id) => followed.clubs.has(id)) ||
    candidate.coaches.some((id) => followed.coaches.has(id)) ||
    candidate.players.some((id) => followed.players.has(id)) ||
    (me !== null && (candidate.players.includes(me.id) || candidate.cityId === me.cityId))
  );
}
