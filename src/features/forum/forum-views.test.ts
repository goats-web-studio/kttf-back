import { describe, expect, it } from 'vitest';

import {
  excerptOf,
  toAuthor,
  toPostView,
  toTopicItem,
  type PostRecord,
  type TopicRecord,
} from './forum-views.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POST = '33333333-3333-4333-8333-333333333333';
const TOPIC = '44444444-4444-4444-8444-444444444444';
const IMAGE = {
  url: '/api/v1/files/forum/55555555-5555-4555-8555-555555555555.webp',
  width: 1600,
  height: 1200,
};

const NOW = new Date('2026-10-24T12:00:00.000Z');

const author = {
  id: USER,
  isAdmin: false,
  lastSeenAt: new Date('2026-10-24T11:58:00.000Z'),
  player: {
    id: '66666666-6666-4666-8666-666666666666',
    lastName: 'Иванов',
    firstName: 'Иван',
    photoUrl: null,
    rating: { toString: () => '512.50' },
    club: { id: '77777777-7777-4777-8777-777777777777', name: 'Спин' },
    coachPage: null,
  },
} as unknown as NonNullable<PostRecord['author']>;

function makePost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: POST,
    topicId: TOPIC,
    authorId: USER,
    number: 3,
    body: 'Текст сообщения',
    quotePostId: null,
    quoteText: null,
    images: [IMAGE],
    likesCount: 2,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    editedAt: null,
    deletedAt: null,
    hiddenAt: null,
    hiddenReason: null,
    author,
    quotePost: null,
    ...overrides,
  };
}

describe('toAuthor', () => {
  it('имя, рейтинг и клуб — из профиля игрока', () => {
    expect(toAuthor(author)).toMatchObject({
      userId: USER,
      name: 'Иванов Иван',
      rating: 512.5,
      club: { name: 'Спин' },
      moderator: false,
    });
  });

  it('без аккаунта — null', () => {
    expect(toAuthor(null)).toBeNull();
  });

  it('«в сети» — заходил последние пять минут', () => {
    expect(toAuthor(author, NOW)?.online).toBe(true);
    expect(toAuthor(author, new Date('2026-10-24T12:10:00.000Z'))?.online).toBe(false);
  });

  it('метка «Тренер» — только у опубликованной и не скрытой страницы', () => {
    const coach = (status: string, hiddenAt: Date | null) =>
      ({
        ...author,
        player: { ...author.player, coachPage: { slug: 'ivanov-ivan', status, hiddenAt } },
      }) as unknown as NonNullable<PostRecord['author']>;

    expect(toAuthor(coach('APPROVED', null))?.coachSlug).toBe('ivanov-ivan');
    expect(toAuthor(coach('PENDING', null))?.coachSlug).toBeNull();
    expect(toAuthor(coach('APPROVED', NOW))?.coachSlug).toBeNull();
  });
});

describe('toTopicItem — «новые»', () => {
  const topic = {
    id: TOPIC,
    title: 'Тема',
    authorId: USER,
    subjectType: null,
    subjectId: null,
    createdAt: NOW,
    postsCount: 12,
    viewsCount: 40,
    lastPostAt: NOW,
    pinnedAt: null,
    lockedAt: null,
    hiddenAt: null,
    hiddenReason: null,
    section: { id: TOPIC, slug: 'tennis', title: 'Настольный теннис' },
    author,
    lastPostAuthor: null,
  } as unknown as TopicRecord;

  it('не открывал — не «новая»; открывал — сколько новых и с какого номера', () => {
    expect(toTopicItem(topic, new Map(), new Map()).unread).toBeNull();
    expect(toTopicItem(topic, new Map(), new Map([[TOPIC, 9]]))).toMatchObject({
      unread: 3,
      firstUnread: 10,
    });
    expect(toTopicItem(topic, new Map(), new Map([[TOPIC, 12]]))).toMatchObject({
      unread: 0,
      firstUnread: null,
    });
  });
});

describe('toPostView', () => {
  const stranger = { userId: OTHER, isAdmin: false };

  it('метка стороны — как пришла', () => {
    expect(toPostView(makePost(), stranger, false, 'ORGANIZER').role).toBe('ORGANIZER');
    expect(toPostView(makePost(), stranger, false).role).toBeNull();
  });

  it('обычное сообщение видно всем целиком', () => {
    const view = toPostView(makePost(), stranger, true);

    expect(view.body).toBe('Текст сообщения');
    expect(view.images).toEqual([IMAGE]);
    expect(view.liked).toBe(true);
    expect(view.mine).toBe(false);
  });

  it('скрытое: посторонний видит заглушку с причиной, автор и администратор — текст', () => {
    const hidden = makePost({ hiddenAt: new Date(), hiddenReason: 'оскорбления' });

    expect(toPostView(hidden, stranger, false)).toMatchObject({
      body: '',
      images: [],
      hidden: true,
      hiddenReason: 'оскорбления',
    });
    expect(toPostView(hidden, { userId: USER, isAdmin: false }, false).body).toBe(
      'Текст сообщения',
    );
    expect(toPostView(hidden, { userId: OTHER, isAdmin: true }, false).body).toBe(
      'Текст сообщения',
    );
  });

  it('удалённое автором не видит никто, даже он сам', () => {
    const deleted = makePost({ deletedAt: new Date(), body: '' });

    expect(toPostView(deleted, { userId: USER, isAdmin: true }, false)).toMatchObject({
      body: '',
      deleted: true,
      quote: null,
    });
  });

  it('цитата — снимок текста с номером и автором исходного', () => {
    const view = toPostView(
      makePost({
        quotePostId: OTHER,
        quoteText: 'фрагмент',
        quotePost: { number: 1, author: { player: { lastName: 'Ким', firstName: 'Сергей' } } },
      }),
      stranger,
      false,
    );

    expect(view.quote).toEqual({
      postId: OTHER,
      number: 1,
      authorName: 'Ким Сергей',
      text: 'фрагмент',
    });
  });

  it('фото не по контракту не роняют тему', () => {
    expect(
      toPostView(makePost({ images: [{ url: 'https://evil' }] }), stranger, false).images,
    ).toEqual([]);
  });
});

describe('excerptOf', () => {
  it('короткий текст — как есть, переводы строк схлопнуты', () => {
    expect(excerptOf('раз\n\nдва')).toBe('раз два');
  });

  it('длинный — по границе слова с многоточием', () => {
    expect(excerptOf('слово '.repeat(10), 20)).toBe('слово слово слово…');
  });
});
