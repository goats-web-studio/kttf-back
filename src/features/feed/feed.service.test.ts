import { FEED_EXCERPT_MAX, type FeedItem } from '@kttf/shared/types';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import {
  NO_FOLLOWS,
  type FollowedTargets,
  type FollowsService,
} from '../follows/follows.service.js';
import type { TournamentsService } from '../tournaments/tournaments.service.js';
import { excerpt, FeedService, popularPosts, rankOf } from './feed.service.js';

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
  const sources = ['clubPosts', 'coachPosts', 'topics', 'announced', 'results', 'levelUps'];

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
