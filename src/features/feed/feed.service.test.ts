import {
  FEED_EXCERPT_MAX,
  FEED_POPULAR_POSTS_PER_WEEK,
  FEED_WINDOW_DAYS,
  type FeedFilter,
  type FeedItem,
} from '@kttf/shared/types';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import {
  NO_FOLLOWS,
  type FollowedTargets,
  type FollowsService,
} from '../follows/follows.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import {
  excerpt,
  FEED_HOT_TOPICS,
  FeedService,
  hotTopics,
  matchesFilter,
  popularPosts,
  rankOf,
} from './feed.service.js';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const CITY = 'city-almaty';
const OTHER_CITY = 'city-astana';

const source = {
  kind: 'CLUB',
  id: 'club-1',
  name: 'KTTF Тест',
  imageUrl: null,
  slug: null,
} as const;

function post(id: string, at: string): FeedItem {
  return {
    id,
    type: 'POST',
    at,
    source,
    discussion: null,
    pinned: false,
    hidden: false,
    kind: 'NEWS',
    title: 'Новость',
    excerpt: 'Текст',
    imageUrl: null,
    validUntil: null,
  };
}

function playerPost(id: string, at: string, views: number): FeedItem {
  return {
    id,
    type: 'PLAYER_POST',
    at,
    source: { kind: 'PLAYER', id: `player-${id}`, name: 'Ким Артём', imageUrl: null, slug: null },
    discussion: {
      topicId: '00000000-0000-4000-8000-000000000001',
      postId: null,
      comments: 0,
      likes: 0,
      views,
    },
    pinned: false,
    hidden: false,
    title: 'Запись',
    excerpt: 'Текст',
    images: [],
    archived: false,
    coauthor: null,
    locale: null,
    translations: [],
  };
}

describe('карточка ленты', () => {
  it('длинный текст обрезается по слову и с многоточием', () => {
    const text = 'слово '.repeat(200);
    const short = excerpt(text);

    expect(short.length).toBeLessThanOrEqual(FEED_EXCERPT_MAX + 1);
    expect(short.endsWith('…')).toBe(true);
    expect(short).not.toMatch(/ …$/);
  });

  it('короткий — как есть', () => {
    expect(excerpt('  Абонемент −20%  ')).toBe('Абонемент −20%');
  });

  it('новость клуба держится наверху дольше записи игрока того же часа', () => {
    const at = '2026-10-25T10:00:00.000Z';

    expect(rankOf(post('a', at))).toBeGreaterThan(rankOf(playerPost('b', at, 0)));
  });
});

describe('самые читаемые записи игроков', () => {
  it('за неделю — не больше пяти, по просмотрам', () => {
    const posts = Array.from({ length: 7 }, (_unused, index) =>
      playerPost(`p${String(index)}`, '2026-10-24T10:00:00.000Z', index * 10),
    );

    const popular = popularPosts(posts, NOW);

    expect(popular.size).toBe(5);
    expect(popular.has('p0')).toBe(false);
    expect(popular.has('p6')).toBe(true);
  });

  it('недели считаются отдельно: старая неделя не вытесняет новую', () => {
    const popular = popularPosts(
      [
        playerPost('old', '2026-10-10T10:00:00.000Z', 1000),
        playerPost('new', '2026-10-24T10:00:00.000Z', 1),
      ],
      NOW,
    );

    expect([...popular].sort()).toEqual(['new', 'old']);
  });
});

/** Сервис с подменёнными источниками: проверяется только отбор по вкладкам. */
function makeService(
  candidates: object[],
  followed: FollowedTargets = NO_FOLLOWS,
  me: { id: string; cityId: string } | null = null,
  curations: { itemId: string; pinnedAt: Date | null; hiddenAt: Date | null }[] = [],
): FeedService {
  const prisma = {
    player: { findUnique: vi.fn().mockResolvedValue(me) },
    feedCuration: { findMany: vi.fn().mockResolvedValue(curations) },
  } as unknown as PrismaService;
  const follows = { targetsOf: vi.fn().mockResolvedValue(followed) } as unknown as FollowsService;
  const service = new FeedService(prisma, follows, {} as TournamentsService);
  const sources = [
    'clubPosts',
    'coachPosts',
    'topics',
    'announced',
    'results',
    'levelUps',
    'forumTopics',
  ];

  for (const name of sources) {
    vi.spyOn(service as unknown as Record<string, () => Promise<object[]>>, name).mockResolvedValue(
      [],
    );
  }
  vi.spyOn(
    service as unknown as Record<string, () => Promise<object[]>>,
    'clubPosts',
  ).mockResolvedValue(candidates);

  return service;
}

const clubNews = {
  item: post('club-post:1', '2026-10-24T10:00:00.000Z'),
  cityId: CITY,
  clubs: ['club-1'],
  coaches: [],
  players: [],
};
const otherCityNews = {
  item: post('club-post:2', '2026-10-24T11:00:00.000Z'),
  cityId: OTHER_CITY,
  clubs: ['club-2'],
  coaches: [],
  players: [],
};
const medal = {
  item: { ...post('medal:1', '2026-10-24T09:00:00.000Z'), type: 'ACHIEVEMENT' },
  cityId: CITY,
  clubs: [],
  coaches: [],
  players: ['player-9'],
  personal: true,
};

describe('вкладки ленты — ADR-073', () => {
  const ids = (page: { items: readonly FeedItem[] }) => page.items.map((item) => item.id);

  it('«Все» — без личных медалей', async () => {
    const page = await makeService([clubNews, otherCityNews, medal]).feed(
      { tab: 'ALL', page: 1, limit: 10 },
      undefined,
      NOW,
    );

    expect(ids(page)).toEqual(['club-post:2', 'club-post:1']);
  });

  it('«Подписки» гостю пусты', async () => {
    const page = await makeService([clubNews]).feed(
      { tab: 'FOLLOWING', page: 1, limit: 10 },
      undefined,
      NOW,
    );

    expect(page.total).toBe(0);
  });

  it('«Подписки» — клубы и игроки, на которых подписан, с медалями', async () => {
    const followed = {
      clubs: new Set(['club-1']),
      coaches: new Set<string>(),
      players: new Set(['player-9']),
    };
    const page = await makeService([clubNews, otherCityNews, medal], followed, {
      id: 'me',
      cityId: CITY,
    }).feed({ tab: 'FOLLOWING', page: 1, limit: 10 }, 'user-1', NOW);

    expect(ids(page)).toEqual(['club-post:1', 'medal:1']);
  });

  it('«Для вас» — общее остаётся, свой город поднимается выше свежего чужого', async () => {
    const page = await makeService([clubNews, otherCityNews], NO_FOLLOWS, {
      id: 'me',
      cityId: CITY,
    }).feed({ tab: 'FOR_YOU', page: 1, limit: 10 }, 'user-1', NOW);

    expect(ids(page)).toEqual(['club-post:1', 'club-post:2']);
  });

  it('страницы режут уже упорядоченную ленту', async () => {
    const page = await makeService([clubNews, otherCityNews]).feed(
      { tab: 'ALL', page: 2, limit: 1 },
      undefined,
      NOW,
    );

    expect(ids(page)).toEqual(['club-post:1']);
    expect(page.total).toBe(2);
  });
});

describe('управление лентой — ADR-075', () => {
  const ids = (page: { items: readonly FeedItem[] }) => page.items.map((item) => item.id);

  it('скрытая администратором карточка в ленту не идёт', async () => {
    const page = await makeService([clubNews, otherCityNews], NO_FOLLOWS, null, [
      { itemId: 'club-post:2', pinnedAt: null, hiddenAt: NOW },
    ]).feed({ tab: 'ALL', page: 1, limit: 10 }, undefined, NOW);

    expect(ids(page)).toEqual(['club-post:1']);
  });

  it('закреплённая — над свежей, с отметкой', async () => {
    const page = await makeService([clubNews, otherCityNews], NO_FOLLOWS, null, [
      { itemId: 'club-post:1', pinnedAt: NOW, hiddenAt: null },
    ]).feed({ tab: 'ALL', page: 1, limit: 10 }, undefined, NOW);

    expect(ids(page)).toEqual(['club-post:1', 'club-post:2']);
    expect(page.items[0]?.pinned).toBe(true);
  });

  it('администратор видит и скрытые, фильтром — только их', async () => {
    const service = makeService([clubNews, otherCityNews], NO_FOLLOWS, null, [
      { itemId: 'club-post:2', pinnedAt: null, hiddenAt: NOW },
    ]);

    expect((await service.adminFeed({ page: 1, limit: 20 }, NOW)).total).toBe(2);
    expect(ids(await service.adminFeed({ page: 1, limit: 20, only: 'HIDDEN' }, NOW))).toEqual([
      'club-post:2',
    ]);
  });
});

// ---------------------------------------------------------------- страница «Лента» — ADR-097

function forumTopic(id: string, at: string, authorPlayerId: string | null = null): FeedItem {
  return {
    id,
    type: 'FORUM',
    at,
    source:
      authorPlayerId === null
        ? { kind: 'KTTF', id: null, name: 'Без профиля', imageUrl: null, slug: null }
        : { kind: 'PLAYER', id: authorPlayerId, name: 'Ким Артём', imageUrl: null, slug: null },
    discussion: null,
    pinned: false,
    hidden: false,
    section: { slug: 'tennis', title: 'Настольный теннис' },
    title: 'Тема',
    excerpt: 'Текст',
    isNew: true,
  };
}

function candidate(item: FeedItem, extra: object = {}) {
  return { item, cityId: null, clubs: [], coaches: [], players: [], ...extra };
}

const AT = '2026-10-24T10:00:00.000Z';
const coachNews = candidate(
  {
    ...post('coach-post:1', AT),
    source: { kind: 'COACH', id: 'coach-1', name: 'Ли Тренер', imageUrl: null, slug: 'li' },
  },
  { coaches: ['coach-1'], players: ['player-coach'] },
);
const portalNews = candidate({
  ...playerPost('topic:portal', AT, 0),
  type: 'PORTAL',
  source: { kind: 'KTTF', id: null, name: 'KTTF', imageUrl: null, slug: null },
} as FeedItem);
const announced = candidate({ ...post('tournament:1', AT), type: 'TOURNAMENT' } as FeedItem, {
  clubs: ['club-1'],
});
const result = candidate({ ...post('result:1', AT), type: 'RESULT' } as FeedItem, {
  clubs: ['club-1'],
  players: ['player-9'],
});
const playerPosts = Array.from({ length: FEED_POPULAR_POSTS_PER_WEEK + 1 }, (_unused, index) =>
  candidate(playerPost(`topic:p${String(index)}`, AT, index * 10), {
    players: [`player-p${String(index)}`],
  }),
);
/** Тем больше, чем проходит в ленту без фильтра; у последней ответов за неделю нет. */
const forum = Array.from({ length: FEED_HOT_TOPICS + 2 }, (_unused, index) =>
  candidate(
    forumTopic(
      `forum:${String(index)}`,
      `2026-10-2${String(index % 5)}T08:00:00.000Z`,
      `player-f${String(index)}`,
    ),
    {
      players: [`player-f${String(index)}`],
      weekReplies: index === FEED_HOT_TOPICS + 1 ? 0 : 10 + index,
    },
  ),
);
const everything = [
  clubNews,
  coachNews,
  portalNews,
  announced,
  result,
  medal,
  ...playerPosts,
  ...forum,
];

describe('фильтр ленты — ADR-097', () => {
  const ids = (page: { items: readonly FeedItem[] }) => page.items.map((item) => item.id);
  const types = (page: { items: readonly FeedItem[] }) =>
    [...new Set(page.items.map((item) => item.type))].sort();
  const all = (filter?: FeedFilter) => ({ tab: 'ALL' as const, filter, page: 1, limit: 30 });

  it('каждый фильтр отдаёт только свои карточки и называет себя в ответе', async () => {
    const service = makeService(everything);

    const kttf = await service.feed(all('KTTF'), undefined, NOW);
    expect(ids(kttf)).toEqual(['topic:portal']);
    expect(kttf.filter).toBe('KTTF');

    expect(ids(await service.feed(all('CLUBS'), undefined, NOW))).toEqual(['club-post:1']);
    expect(ids(await service.feed(all('COACHES'), undefined, NOW))).toEqual(['coach-post:1']);
    expect(types(await service.feed(all('PLAYERS'), undefined, NOW))).toEqual(['PLAYER_POST']);
    expect(types(await service.feed(all('TOURNAMENTS'), undefined, NOW))).toEqual([
      'RESULT',
      'TOURNAMENT',
    ]);
    expect(types(await service.feed(all('FORUM'), undefined, NOW))).toEqual(['FORUM']);
  });

  it('без фильтра — всё, `filter: null`', async () => {
    const page = await makeService(everything).feed(all(), undefined, NOW);

    expect(page.filter).toBeNull();
    expect(types(page)).toEqual(['FORUM', 'PLAYER_POST', 'PORTAL', 'POST', 'RESULT', 'TOURNAMENT']);
  });

  it('«Записи игроков» — все записи окна, а не только самые читаемые', async () => {
    const service = makeService(everything);

    const plain = await service.feed(all(), undefined, NOW);
    const players = await service.feed(all('PLAYERS'), undefined, NOW);

    expect(plain.items.filter((item) => item.type === 'PLAYER_POST')).toHaveLength(
      FEED_POPULAR_POSTS_PER_WEEK,
    );
    expect(players.total).toBe(playerPosts.length);
  });

  it('«Турниры»: медали — по-прежнему личное, в «Для вас» — свои', async () => {
    const service = makeService(everything, NO_FOLLOWS, { id: 'player-9', cityId: CITY });

    expect(ids(await service.feed(all('TOURNAMENTS'), 'user-1', NOW))).not.toContain('medal:1');
    expect(
      ids(await service.feed({ ...all('TOURNAMENTS'), tab: 'FOR_YOU' }, 'user-1', NOW)),
    ).toContain('medal:1');
  });

  it('«Форум» — все темы по последнему сообщению; без фильтра — только горячие', async () => {
    const service = makeService(everything);

    const filtered = await service.feed(all('FORUM'), undefined, NOW);
    expect(filtered.total).toBe(forum.length);
    const times = filtered.items.map((item) => Date.parse(item.at));
    expect(times).toEqual([...times].sort((left, right) => right - left));

    const plain = await service.feed(all(), undefined, NOW);
    const mixed = plain.items.filter((item) => item.type === 'FORUM').map((item) => item.id);
    expect(mixed).toHaveLength(FEED_HOT_TOPICS);
    // Тема без ответов за неделю и наименее обсуждаемая из остальных — мимо.
    expect(mixed).not.toContain(`forum:${String(FEED_HOT_TOPICS + 1)}`);
    expect(mixed).not.toContain('forum:0');
  });

  it('форум без фильтра не вытесняет новости клубов того же дня', async () => {
    const page = await makeService([
      candidate(forumTopic('forum:hot', '2026-10-24T11:00:00.000Z'), { weekReplies: 50 }),
      clubNews,
    ]).feed(all(), undefined, NOW);

    expect(ids(page)).toEqual(['club-post:1', 'forum:hot']);
  });

  it('«Подписки» + фильтр — только подписки в своём фильтре', async () => {
    const followed = {
      clubs: new Set(['club-1']),
      coaches: new Set<string>(),
      players: new Set(['player-f0', 'player-f6']),
    };
    const service = makeService(everything, followed, { id: 'me', cityId: CITY });

    const forumPage = await service.feed({ ...all('FORUM'), tab: 'FOLLOWING' }, 'user-1', NOW);
    expect(ids(forumPage).sort()).toEqual(['forum:0', 'forum:6']);
    expect(forumPage.filter).toBe('FORUM');

    expect(ids(await service.feed({ ...all('CLUBS'), tab: 'FOLLOWING' }, 'user-1', NOW))).toEqual([
      'club-post:1',
    ]);
    expect((await service.feed({ ...all('COACHES'), tab: 'FOLLOWING' }, 'user-1', NOW)).total).toBe(
      0,
    );
  });

  it('«Подписки» без фильтра — из тем подписок только горячие', async () => {
    const followed = {
      clubs: new Set<string>(),
      coaches: new Set<string>(),
      players: new Set(['player-f0', 'player-f5', 'player-f6']),
    };
    const service = makeService(everything, followed, { id: 'me', cityId: CITY });

    const following = await service.feed({ ...all(), tab: 'FOLLOWING' }, 'user-1', NOW);
    expect(ids(following).filter((id) => id.startsWith('forum:'))).toEqual(['forum:5']);

    const forYou = await service.feed({ ...all(), tab: 'FOR_YOU' }, 'user-1', NOW);
    expect(forYou.items.filter((item) => item.type === 'FORUM')).toHaveLength(FEED_HOT_TOPICS);
    expect(ids(forYou)).not.toContain('forum:6');
  });

  it('страницы и `total` считаются внутри фильтра', async () => {
    const page = await makeService(everything).feed(
      { tab: 'ALL', filter: 'FORUM', page: 2, limit: 3 },
      undefined,
      NOW,
    );

    expect(page.total).toBe(forum.length);
    expect(page.items).toHaveLength(3);
  });

  it('закреплённая тема форума — над лентой, но только в подходящем фильтре', async () => {
    const curations = [{ itemId: 'forum:6', pinnedAt: NOW, hiddenAt: null }];
    const service = makeService(everything, NO_FOLLOWS, null, curations);

    const plain = await service.feed(all(), undefined, NOW);
    expect(plain.items[0]?.id).toBe('forum:6');
    expect(plain.items[0]?.pinned).toBe(true);

    expect(ids(await service.feed(all('FORUM'), undefined, NOW))[0]).toBe('forum:6');
    expect(ids(await service.feed(all('CLUBS'), undefined, NOW))).toEqual(['club-post:1']);
  });

  it('скрытая тема форума уходит из ленты, её место занимает следующая горячая', async () => {
    const service = makeService(everything, NO_FOLLOWS, null, [
      { itemId: 'forum:5', pinnedAt: null, hiddenAt: NOW },
    ]);

    const plain = await service.feed(all(), undefined, NOW);
    const mixed = plain.items.filter((item) => item.type === 'FORUM').map((item) => item.id);
    expect(mixed).not.toContain('forum:5');
    expect(mixed).toContain('forum:0');
    expect(mixed).toHaveLength(FEED_HOT_TOPICS);

    expect(ids(await service.feed(all('FORUM'), undefined, NOW))).not.toContain('forum:5');
  });

  it('администратор видит темы форума в своей выдаче', async () => {
    const page = await makeService(everything).adminFeed({ page: 1, limit: 30 }, NOW);

    expect(page.filter).toBeNull();
    expect(page.items.filter((item) => item.type === 'FORUM')).toHaveLength(forum.length);
  });

  it('matchesFilter: акции клуба — «Клубы», тренера — «Тренеры», медаль — «Турниры»', () => {
    expect(matchesFilter(clubNews.item, 'CLUBS')).toBe(true);
    expect(matchesFilter(clubNews.item, 'COACHES')).toBe(false);
    expect(matchesFilter(coachNews.item, 'COACHES')).toBe(true);
    expect(matchesFilter(medal.item as FeedItem, 'TOURNAMENTS')).toBe(true);
    expect(matchesFilter(medal.item as FeedItem, 'PLAYERS')).toBe(false);
  });

  it('hotTopics: по ответам за неделю, при равенстве — свежее, без ответов — нет', () => {
    const hot = hotTopics([
      { id: 'a', at: '2026-10-20T10:00:00.000Z', weekReplies: 3 },
      { id: 'b', at: '2026-10-24T10:00:00.000Z', weekReplies: 3 },
      { id: 'c', at: '2026-10-24T10:00:00.000Z', weekReplies: 0 },
      ...Array.from({ length: FEED_HOT_TOPICS - 1 }, (_unused, index) => ({
        id: `x${String(index)}`,
        at: AT,
        weekReplies: 10,
      })),
    ]);

    expect(hot.has('b')).toBe(true);
    expect(hot.has('a')).toBe(false);
    expect(hot.has('c')).toBe(false);
    expect(hot.size).toBe(FEED_HOT_TOPICS);
  });
});

describe('темы форума в ленте — источник', () => {
  const since = new Date(NOW.getTime() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  function forumRow(id: string, overrides: object = {}) {
    return {
      id,
      title: `Тема ${id}`,
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
      lastPostAt: new Date('2026-10-24T18:30:00.000Z'),
      postsCount: 4,
      viewsCount: 40,
      section: { slug: 'tennis', title: 'Настольный теннис' },
      posts: [
        {
          id: `${id}-post`,
          body: 'Какую накладку взять на форхенд?',
          likesCount: 2,
          deletedAt: null,
          hiddenAt: null,
          authoredAs: 'SELF',
        },
      ],
      author: {
        player: { id: 'player-1', lastName: 'Ким', firstName: 'Артём', photoUrl: '/p.webp' },
      },
      ...overrides,
    };
  }

  type ForumSource = (since: Date, now: Date) => Promise<{ item: FeedItem; weekReplies: number }[]>;

  function sourceService(rows: object[], replies: { topicId: string; count: number }[] = []) {
    const prisma = {
      forumTopic: { findMany: vi.fn().mockResolvedValue(rows) },
      forumPost: {
        groupBy: vi
          .fn()
          .mockResolvedValue(
            replies.map((row) => ({ topicId: row.topicId, _count: { _all: row.count } })),
          ),
      },
    };
    const service = new FeedService(
      prisma as unknown as PrismaService,
      {} as FollowsService,
      {} as TournamentsService,
    );
    const source = (service as unknown as { forumTopics: ForumSource }).forumTopics;

    return { prisma, read: source.bind(service) };
  }

  it('берёт видимые темы окна без разделов ленты и без тем новостей клубов и тренеров', async () => {
    const { prisma, read } = sourceService([]);

    await read(since, NOW);

    const args = prisma.forumTopic.findMany.mock.calls[0]?.[0] as {
      where: object;
      orderBy: object;
    };
    expect(args.where).toMatchObject({
      hiddenAt: null,
      archivedAt: null,
      lastPostAt: { gte: since },
      section: { archivedAt: null, slug: { notIn: ['kttf', 'posts'] } },
      OR: [{ subjectType: null }, { subjectType: { notIn: ['CLUB_POST', 'COACH_POST'] } }],
    });
    expect(args.orderBy).toEqual({ lastPostAt: 'desc' });
    expect(prisma.forumPost.groupBy).not.toHaveBeenCalled();
  });

  it('ответы за неделю — без первого сообщения, стёртых и скрытых', async () => {
    const { prisma, read } = sourceService([forumRow('t1')]);

    await read(since, NOW);

    const args = prisma.forumPost.groupBy.mock.calls[0]?.[0] as { where: object };
    expect(args.where).toMatchObject({
      topicId: { in: ['t1'] },
      number: { gt: 1 },
      createdAt: { gte: new Date('2026-10-18T12:00:00.000Z') },
      deletedAt: null,
      hiddenAt: null,
    });
  });

  it('карточка: время — последнее сообщение, автор — игрок, счётчики темы', async () => {
    const { read } = sourceService([forumRow('t1')], [{ topicId: 't1', count: 3 }]);

    const [card] = await read(since, NOW);

    expect(card?.weekReplies).toBe(3);
    expect(card?.item).toMatchObject({
      id: 'forum:t1',
      type: 'FORUM',
      at: '2026-10-24T18:30:00.000Z',
      source: { kind: 'PLAYER', id: 'player-1', name: 'Ким Артём', imageUrl: '/p.webp' },
      discussion: { topicId: 't1', postId: 't1-post', comments: 3, likes: 2, views: 40 },
      section: { slug: 'tennis', title: 'Настольный теннис' },
      title: 'Тема t1',
      excerpt: 'Какую накладку взять на форхенд?',
      isNew: true,
    });
  });

  it('тема старше окна, но с ответом в нём — «Обсуждают», не «Новая»', async () => {
    const { read } = sourceService([
      forumRow('old', { createdAt: new Date('2026-01-10T10:00:00.000Z') }),
    ]);

    const [card] = await read(since, NOW);

    expect(card?.item.type === 'FORUM' && card.item.isNew).toBe(false);
  });

  it('автор без профиля игрока — KTTF с его именем; стёртое первое сообщение — без карточки', async () => {
    const { read } = sourceService([
      forumRow('noprofile', { author: { player: null } }),
      forumRow('deleted', {
        posts: [
          { id: 'x', body: '', likesCount: 0, deletedAt: NOW, hiddenAt: null, authoredAs: 'SELF' },
        ],
      }),
    ]);

    const cards = await read(since, NOW);

    expect(cards.map((card) => card.item.id)).toEqual(['forum:noprofile']);
    expect(cards[0]?.item.source).toEqual({
      kind: 'KTTF',
      id: null,
      name: 'Без профиля',
      imageUrl: null,
      slug: null,
    });
  });
});

describe('от лица KTTF и версии новости — ADR-098', () => {
  const since = new Date(NOW.getTime() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const player = {
    id: 'player-1',
    lastName: 'Аманбаев',
    firstName: 'Арлан',
    photoUrl: '/a.webp',
    cityId: 'city-1',
  };
  const image = {
    url: '/api/v1/files/forum/55555555-5555-4555-8555-555555555555.webp',
    width: 1600,
    height: 900,
  };

  function topicRow(id: string, authoredAs: string, overrides: object = {}) {
    return {
      id,
      title: 'KTTF открыт',
      createdAt: new Date('2026-10-24T10:00:00.000Z'),
      lastPostAt: new Date('2026-10-24T10:00:00.000Z'),
      archivedAt: null,
      postsCount: 1,
      viewsCount: 5,
      locale: 'ru',
      section: { slug: 'tennis', title: 'Настольный теннис' },
      posts: [
        {
          id: `${id}-post`,
          body: 'Платформа открыта',
          images: [],
          likesCount: 0,
          deletedAt: null,
          hiddenAt: null,
          authoredAs,
        },
      ],
      author: { player },
      translations: [],
      ...overrides,
    };
  }

  function service(rows: object[]) {
    const prisma = {
      forumTopic: { findMany: vi.fn().mockResolvedValue(rows), count: vi.fn() },
      forumPost: { groupBy: vi.fn().mockResolvedValue([]) },
    };
    const feed = new FeedService(
      prisma as unknown as PrismaService,
      {} as FollowsService,
      {} as TournamentsService,
    );

    return { prisma, feed };
  }

  type TopicsSource = (section: string, since: Date | null) => Promise<Candidate[]>;
  type ForumSource = (since: Date, now: Date) => Promise<Candidate[]>;
  interface Candidate {
    item: FeedItem;
    players: readonly string[];
  }

  it('новость от KTTF: источник KTTF, человек — только соавтором, подписки на него не поднимают', async () => {
    const { feed } = service([
      topicRow('kttf', 'KTTF'),
      topicRow('co', 'KTTF_WITH_COAUTHOR'),
      topicRow('self', 'SELF'),
    ]);
    const read = (feed as unknown as { topics: TopicsSource }).topics.bind(feed);

    const [kttf, co, self] = await read('kttf', since);

    expect(kttf?.item).toMatchObject({ type: 'PORTAL', source: { kind: 'KTTF', name: 'KTTF' } });
    expect(kttf?.item.type === 'PORTAL' && kttf.item.coauthor).toBeNull();
    expect(kttf?.players).toEqual([]);
    expect(co?.item).toMatchObject({
      source: { kind: 'KTTF' },
      coauthor: { playerId: 'player-1', name: 'Аманбаев Арлан', photoUrl: '/a.webp' },
    });
    // «От себя» в новостях — шапка того, кто написал.
    expect(self?.item.source).toMatchObject({ kind: 'PLAYER', id: 'player-1' });
  });

  it('карточка новости несёт язык оригинала и версии: заголовок, начало текста, обложку', async () => {
    const { feed } = service([
      topicRow('kttf', 'KTTF', {
        translations: [
          { locale: 'kk', title: 'KTTF ашылды', body: 'Платформа **ашық**', image },
          { locale: 'xx', title: 'нет', body: 'нет', image: null },
          { locale: 'en', title: 'KTTF is open', body: 'Open', image: { url: 'bad' } },
        ],
      }),
    ]);
    const read = (feed as unknown as { topics: TopicsSource }).topics.bind(feed);

    const [card] = await read('kttf', since);

    expect(card?.item).toMatchObject({
      locale: 'ru',
      translations: [
        { locale: 'kk', title: 'KTTF ашылды', excerpt: 'Платформа ашық', image },
        { locale: 'en', title: 'KTTF is open', excerpt: 'Open', image: null },
      ],
    });
  });

  it('запись игрока — без версий и языка, даже если строки есть', async () => {
    const { feed } = service([topicRow('p', 'SELF')]);
    const read = (feed as unknown as { topics: TopicsSource }).topics.bind(feed);

    const [card] = await read('posts', since);

    expect(card?.item).toMatchObject({ type: 'PLAYER_POST', locale: null, translations: [] });
  });

  it('тема форума от KTTF — источник KTTF без игрока', async () => {
    const { feed } = service([topicRow('f', 'KTTF')]);
    const read = (feed as unknown as { forumTopics: ForumSource }).forumTopics.bind(feed);

    const [card] = await read(since, NOW);

    expect(card?.item.source).toEqual({
      kind: 'KTTF',
      id: null,
      name: 'KTTF',
      imageUrl: null,
      slug: null,
    });
    expect(card?.players).toEqual([]);
  });

  it('стена игрока не берёт записи от лица KTTF', async () => {
    const prisma = {
      player: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      forumTopic: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    };
    const feed = new FeedService(
      prisma as unknown as PrismaService,
      {} as FollowsService,
      {} as TournamentsService,
    );

    await feed.wall('player-1', { page: 1, limit: 10 });

    const args = prisma.forumTopic.findMany.mock.calls[0]?.[0] as { where: object };
    expect(args.where).toMatchObject({ authorId: 'user-1', authoredAs: 'SELF' });
  });
});
