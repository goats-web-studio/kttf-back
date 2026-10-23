import { describe, expect, it } from 'vitest';

import { excerptOf, toAuthor, toPostView, type PostRecord } from './forum-views.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POST = '33333333-3333-4333-8333-333333333333';
const TOPIC = '44444444-4444-4444-8444-444444444444';
const IMAGE = {
  url: '/api/v1/files/forum/55555555-5555-4555-8555-555555555555.webp',
  width: 1600,
  height: 1200,
};

const author = {
  id: USER,
  isAdmin: false,
  player: {
    id: '66666666-6666-4666-8666-666666666666',
    lastName: 'Иванов',
    firstName: 'Иван',
    photoUrl: null,
    rating: { toString: () => '512.50' },
    club: { id: '77777777-7777-4777-8777-777777777777', name: 'Спин' },
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
});

describe('toPostView', () => {
  const stranger = { userId: OTHER, isAdmin: false };

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
