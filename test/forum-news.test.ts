import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { AuthModule } from '../src/features/auth/auth.module.js';
import { ForumModule } from '../src/features/forum/forum.module.js';
import { ConfigModule } from '../src/infra/config/config.module.js';
import { ENV, type Env } from '../src/infra/config/env.js';
import { PrismaModule } from '../src/infra/prisma/prisma.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

/**
 * Новости KTTF через настоящее приложение — ADR-098: голос KTTF только у
 * модератора, публично человек скрыт, профиль его не собирает; версии на
 * языках ведёт модератор и только у новостей.
 */
const env: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'test_secret_at_least_32_characters_long',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'kttf-media',
  S3_REGION: 'us-east-1',
};

const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_ID = '44444444-4444-4444-8444-444444444444';
const NEWS_SECTION = '55555555-5555-4555-8555-555555555555';
const POSTS_SECTION = '66666666-6666-4666-8666-666666666666';
const TOPIC_ID = '77777777-7777-4777-8777-777777777777';
const POST_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-11-20T10:00:00.000Z');

const author = {
  id: USER_ID,
  isAdmin: true,
  lastSeenAt: null,
  player: {
    id: PLAYER_ID,
    lastName: 'Аманбаев',
    firstName: 'Арлан',
    photoUrl: null,
    rating: { toString: () => '250.00' },
    club: null,
    coachPage: null,
  },
};

function topicRow(overrides: object = {}) {
  return {
    id: TOPIC_ID,
    title: 'KTTF открыт',
    authorId: USER_ID,
    subjectType: null,
    subjectId: null,
    createdAt: NOW,
    postsCount: 1,
    viewsCount: 0,
    lastPostAt: NOW,
    pinnedAt: null,
    lockedAt: null,
    hiddenAt: null,
    hiddenReason: null,
    authoredAs: 'KTTF',
    lastPostAuthoredAs: 'KTTF',
    locale: 'ru',
    section: { id: NEWS_SECTION, slug: 'kttf', title: 'Новости KTTF' },
    author,
    lastPostAuthor: { player: { lastName: 'Аманбаев', firstName: 'Арлан' } },
    ...overrides,
  };
}

function postRow(overrides: object = {}) {
  return {
    id: POST_ID,
    topicId: TOPIC_ID,
    authorId: USER_ID,
    number: 1,
    body: 'Платформа открыта',
    quotePostId: null,
    quoteText: null,
    images: [],
    likesCount: 0,
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
    hiddenAt: null,
    hiddenReason: null,
    authoredAs: 'KTTF',
    author,
    quotePost: null,
    topic: { ...topicRow(), subjectType: null, subjectId: null },
    ...overrides,
  };
}

const translation = {
  topicId: TOPIC_ID,
  locale: 'kk',
  title: 'KTTF ашылды',
  body: 'Платформа ашық',
  images: [],
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const photo = (n: number) => ({
  url: `/api/v1/files/forum/9999999${String(n)}-9999-4999-8999-999999999999.webp`,
  width: 1600,
  height: 900,
});

function makePrisma() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        isAdmin: false,
        player: { lastName: 'Иванов', firstName: 'Иван' },
        forumMute: null,
      }),
    },
    forumSection: { findUnique: vi.fn() },
    forumTopic: {
      create: vi.fn().mockResolvedValue({
        id: TOPIC_ID,
        title: 'KTTF открыт',
        subjectType: null,
        subjectId: null,
      }),
      update: vi.fn().mockResolvedValue({ postsCount: 1 }),
      findUnique: vi.fn().mockResolvedValue(topicRow()),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn(),
    },
    forumPost: {
      create: vi.fn().mockResolvedValue({ id: POST_ID }),
      findUnique: vi.fn().mockResolvedValue(postRow()),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    forumSubscription: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    forumTopicRead: { upsert: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    forumLike: { findMany: vi.fn().mockResolvedValue([]) },
    forumTopicTranslation: {
      findMany: vi.fn().mockResolvedValue([translation]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _max: { position: null } }),
    },
    notification: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => Promise<unknown>) =>
    work(prisma),
  );

  return prisma;
}

let app: INestApplication | undefined;
let prisma: ReturnType<typeof makePrisma>;
let root: string;
let token: string;

beforeEach(async () => {
  prisma = makePrisma();

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, AuthModule, ForumModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  root = `${await app.getUrl()}/api/v1`;
  token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: USER_ID }, { expiresIn: 600 });
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

async function call(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
) {
  const response = await fetch(`${root}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.auth === true ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();

  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

function asAdmin(): void {
  prisma.user.findUnique.mockResolvedValue({
    isAdmin: true,
    player: { lastName: 'Аманбаев', firstName: 'Арлан' },
    forumMute: null,
  });
}

const forbidden = { status: 403, body: { error: { code: 'FORBIDDEN' } } };
const invalid = { status: 400, body: { error: { code: 'VALIDATION_FAILED' } } };

describe('от чьего лица — права (ADR-098)', () => {
  it('тема от KTTF не от модератора — 403, тема не заводится', async () => {
    prisma.forumSection.findUnique.mockResolvedValue({
      id: POSTS_SECTION,
      slug: 'tennis',
      archivedAt: null,
      manualTopics: true,
    });

    const response = await call('POST', '/forum/topics', {
      auth: true,
      body: { sectionId: POSTS_SECTION, title: 'Тема', body: 'Текст', authoredAs: 'KTTF' },
    });

    expect(response).toMatchObject(forbidden);
    expect(prisma.forumTopic.create).not.toHaveBeenCalled();
  });

  it('ответ от KTTF не от модератора — 403', async () => {
    const response = await call('POST', `/forum/topics/${TOPIC_ID}/posts`, {
      auth: true,
      body: { body: 'Ответ', authoredAs: 'KTTF_WITH_COAUTHOR' },
    });

    expect(response).toMatchObject(forbidden);
    expect(prisma.forumPost.create).not.toHaveBeenCalled();
  });

  it('новость модератора без режима — от KTTF, язык оригинала — русский', async () => {
    asAdmin();
    prisma.forumSection.findUnique.mockResolvedValue({
      id: NEWS_SECTION,
      slug: 'kttf',
      archivedAt: null,
      manualTopics: false,
    });

    const response = await call('POST', '/forum/topics', {
      auth: true,
      body: { sectionId: NEWS_SECTION, title: 'KTTF открыт', body: 'Платформа открыта' },
    });

    expect(response.status).toBe(201);
    expect(prisma.forumTopic.create.mock.calls[0]?.[0]).toMatchObject({
      data: { authoredAs: 'KTTF', locale: 'ru' },
    });
    expect(prisma.forumPost.create.mock.calls[0]?.[0]).toMatchObject({
      data: { authorId: USER_ID, authoredAs: 'KTTF' },
    });
    // Уведомления подписаны «KTTF», а не именем модератора.
    expect(prisma.forumTopic.update.mock.calls[0]?.[0]).toMatchObject({
      data: { lastPostAuthoredAs: 'KTTF' },
    });
  });

  it('модератор может выбрать «от себя» и язык оригинала', async () => {
    asAdmin();
    prisma.forumSection.findUnique.mockResolvedValue({
      id: NEWS_SECTION,
      slug: 'kttf',
      archivedAt: null,
      manualTopics: false,
    });

    await call('POST', '/forum/topics', {
      auth: true,
      body: {
        sectionId: NEWS_SECTION,
        title: 'KTTF ашылды',
        body: 'Мәтін',
        authoredAs: 'SELF',
        locale: 'kk',
      },
    });

    expect(prisma.forumTopic.create.mock.calls[0]?.[0]).toMatchObject({
      data: { authoredAs: 'SELF', locale: 'kk' },
    });
  });

  it('запись игрока от KTTF и язык у обычной темы — ошибка поля', async () => {
    asAdmin();
    prisma.forumSection.findUnique.mockResolvedValue({
      id: POSTS_SECTION,
      slug: 'posts',
      archivedAt: null,
      manualTopics: true,
    });

    expect(
      await call('POST', '/forum/topics', {
        auth: true,
        body: { sectionId: POSTS_SECTION, title: 'Запись', body: 'Текст', authoredAs: 'KTTF' },
      }),
    ).toMatchObject(invalid);
    expect(
      await call('POST', '/forum/topics', {
        auth: true,
        body: { sectionId: POSTS_SECTION, title: 'Запись', body: 'Текст', locale: 'kk' },
      }),
    ).toMatchObject(invalid);
  });
});

describe('публично человек скрыт (ADR-098)', () => {
  it('гость видит знак KTTF: автора нет ни у темы, ни у статьи', async () => {
    const response = await call('GET', `/forum/topics/${TOPIC_ID}`);

    expect(response).toMatchObject({
      status: 200,
      body: {
        author: null,
        authoredAs: 'KTTF',
        coauthor: null,
        lastAuthorName: 'KTTF',
        firstPost: { author: null, authoredAs: 'KTTF', coauthor: null, role: null },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('Аманбаев');
  });

  it('соавтор — ссылкой на профиль, но не как автор', async () => {
    prisma.forumTopic.findUnique.mockResolvedValue(topicRow({ authoredAs: 'KTTF_WITH_COAUTHOR' }));
    prisma.forumPost.findUnique.mockResolvedValue(postRow({ authoredAs: 'KTTF_WITH_COAUTHOR' }));

    const response = await call('GET', `/forum/topics/${TOPIC_ID}`);

    expect(response.body).toMatchObject({
      author: null,
      coauthor: { playerId: PLAYER_ID, name: 'Аманбаев Арлан' },
      firstPost: { author: null, coauthor: { playerId: PLAYER_ID } },
    });
  });

  it('модератор видит настоящего автора', async () => {
    asAdmin();

    const response = await call('GET', `/forum/topics/${TOPIC_ID}`, { auth: true });

    expect(response.body).toMatchObject({
      author: { name: 'Аманбаев Арлан' },
      firstPost: { author: { name: 'Аманбаев Арлан' }, authoredAs: 'KTTF' },
    });
  });

  it('тема несёт язык оригинала и все версии', async () => {
    const response = await call('GET', `/forum/topics/${TOPIC_ID}`);

    expect(response.body).toMatchObject({
      locale: 'ru',
      translations: [
        { locale: 'kk', title: 'KTTF ашылды', body: 'Платформа ашық', images: [], image: null },
      ],
    });
  });

  it('«На форуме» и фильтр по автору не берут сообщений и тем KTTF', async () => {
    await call('GET', `/forum/posts?authorPlayerId=${PLAYER_ID}`);
    await call('GET', `/forum/topics?authorPlayerId=${PLAYER_ID}`);

    expect(prisma.forumPost.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { authoredAs: 'SELF', author: { player: { id: PLAYER_ID } } },
    });
    expect(prisma.forumTopic.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { authoredAs: 'SELF', author: { player: { id: PLAYER_ID } } },
    });
  });

  it('без фильтра по автору лента сообщений KTTF не прячет', async () => {
    await call('GET', '/forum/posts');

    const args = prisma.forumPost.findMany.mock.calls[0]?.[0] as { where: object };
    expect(args.where).not.toHaveProperty('authoredAs');
  });
});

describe('правка режима (ADR-098)', () => {
  it('сообщение KTTF правит другой модератор; режим можно сменить на соавторский', async () => {
    asAdmin();
    token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: OTHER_ID }, { expiresIn: 600 });

    const response = await call('PATCH', `/forum/posts/${POST_ID}`, {
      auth: true,
      body: { body: 'Новый текст', authoredAs: 'KTTF_WITH_COAUTHOR' },
    });

    expect(response.status).toBe(200);
    expect(prisma.forumPost.update.mock.calls[0]?.[0]).toMatchObject({
      data: { body: 'Новый текст', authoredAs: 'KTTF_WITH_COAUTHOR' },
    });
    // Первое и последнее сообщение — зеркала темы обновлены.
    expect(prisma.forumTopic.update.mock.calls[0]?.[0]).toMatchObject({
      data: { authoredAs: 'KTTF_WITH_COAUTHOR', lastPostAuthoredAs: 'KTTF_WITH_COAUTHOR' },
    });
  });

  it('чужое сообщение KTTF сделать личным нельзя', async () => {
    asAdmin();
    token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: OTHER_ID }, { expiresIn: 600 });

    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', authoredAs: 'SELF' },
      }),
    ).toMatchObject(forbidden);
  });

  it('не модератор не правит сообщение KTTF и не переводит своё в KTTF', async () => {
    token = new JwtService({ secret: env.JWT_SECRET }).sign({ sub: OTHER_ID }, { expiresIn: 600 });

    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, { auth: true, body: { body: 'Текст' } }),
    ).toMatchObject(forbidden);

    prisma.forumPost.findUnique.mockResolvedValue(
      postRow({ authorId: OTHER_ID, authoredAs: 'SELF' }),
    );

    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', authoredAs: 'KTTF' },
      }),
    ).toMatchObject(forbidden);
    expect(prisma.forumPost.update).not.toHaveBeenCalled();
  });
});

describe('версии новости (ADR-098)', () => {
  const version = { title: 'KTTF is open', body: 'The platform is open' };

  it('не модератор — 403', async () => {
    expect(
      await call('PUT', `/forum/topics/${TOPIC_ID}/translations/en`, {
        auth: true,
        body: version,
      }),
    ).toMatchObject(forbidden);
    expect(
      await call('DELETE', `/forum/topics/${TOPIC_ID}/translations/kk`, { auth: true }),
    ).toMatchObject(forbidden);
    expect(prisma.forumTopicTranslation.upsert).not.toHaveBeenCalled();
    expect(prisma.forumTopicTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('без входа — 401', async () => {
    expect(
      (await call('PUT', `/forum/topics/${TOPIC_ID}/translations/en`, { body: version })).status,
    ).toBe(401);
  });

  it('модератор добавляет версию: без фото — пустой список, место — в конце', async () => {
    asAdmin();
    prisma.forumTopicTranslation.aggregate.mockResolvedValue({ _max: { position: 1 } });

    const response = await call('PUT', `/forum/topics/${TOPIC_ID}/translations/en`, {
      auth: true,
      body: version,
    });

    expect(response.status).toBe(200);
    const args = prisma.forumTopicTranslation.upsert.mock.calls[0]?.[0] as {
      where: object;
      create: object;
      update: object;
    };
    expect(args.where).toEqual({ topicId_locale: { topicId: TOPIC_ID, locale: 'en' } });
    expect(args.create).toMatchObject({
      topicId: TOPIC_ID,
      locale: 'en',
      title: 'KTTF is open',
      images: [],
      position: 2,
      updatedById: USER_ID,
    });
    // Существующая версия остаётся на своём месте.
    expect(args.update).not.toHaveProperty('position');
    expect(args.update).toMatchObject({ title: 'KTTF is open', body: 'The platform is open' });
  });

  it('с фото — фото форума по порядку (ADR-099)', async () => {
    asAdmin();

    await call('PUT', `/forum/topics/${TOPIC_ID}/translations/zh`, {
      auth: true,
      body: { ...version, images: [photo(2), photo(1)] },
    });

    expect(prisma.forumTopicTranslation.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { images: [photo(2), photo(1)] },
      update: { images: [photo(2), photo(1)] },
    });
  });

  it('язык оригинала, язык вне списка, пустой текст и не новость — ошибка', async () => {
    asAdmin();

    expect(
      await call('PUT', `/forum/topics/${TOPIC_ID}/translations/ru`, { auth: true, body: version }),
    ).toMatchObject(invalid);
    expect(
      await call('PUT', `/forum/topics/${TOPIC_ID}/translations/de`, { auth: true, body: version }),
    ).toMatchObject(invalid);
    expect(
      await call('PUT', `/forum/topics/${TOPIC_ID}/translations/en`, {
        auth: true,
        body: { title: 'KTTF', body: '  ' },
      }),
    ).toMatchObject(invalid);

    prisma.forumTopic.findUnique.mockResolvedValue(
      topicRow({ locale: null, section: { id: POSTS_SECTION, slug: 'tennis', title: 'Теннис' } }),
    );

    expect(
      await call('PUT', `/forum/topics/${TOPIC_ID}/translations/en`, { auth: true, body: version }),
    ).toMatchObject(invalid);
    expect(prisma.forumTopicTranslation.upsert).not.toHaveBeenCalled();
  });

  it('модератор убирает версию', async () => {
    asAdmin();

    expect(
      await call('DELETE', `/forum/topics/${TOPIC_ID}/translations/kk`, { auth: true }),
    ).toMatchObject({ status: 204 });
    expect(prisma.forumTopicTranslation.deleteMany).toHaveBeenCalledWith({
      where: { topicId: TOPIC_ID, locale: 'kk' },
    });
  });

  it('язык оригинала меняется, но не на язык существующей версии', async () => {
    asAdmin();

    expect(
      (
        await call('PUT', `/forum/topics/${TOPIC_ID}/locale`, {
          auth: true,
          body: { locale: 'en' },
        })
      ).status,
    ).toBe(200);
    expect(prisma.forumTopic.update).toHaveBeenCalledWith({
      where: { id: TOPIC_ID },
      data: { locale: 'en' },
    });

    prisma.forumTopicTranslation.findUnique.mockResolvedValue({ locale: 'kk' });

    expect(
      await call('PUT', `/forum/topics/${TOPIC_ID}/locale`, { auth: true, body: { locale: 'kk' } }),
    ).toMatchObject(invalid);
  });
});

describe('редактор новостей: языки при создании и в правке (ADR-099)', () => {
  const kk = {
    locale: 'kk',
    title: 'KTTF ашылды',
    body: 'Платформа ашық',
    images: [photo(1), photo(2)],
  };
  const en = {
    locale: 'en',
    title: 'KTTF is open',
    body: 'The platform is open',
    images: [photo(3)],
  };
  const news = {
    sectionId: NEWS_SECTION,
    title: 'KTTF открыт',
    body: 'Платформа открыта',
    images: [photo(4), photo(5)],
    locale: 'ru',
  };

  function newsSection(): void {
    prisma.forumSection.findUnique.mockResolvedValue({
      id: NEWS_SECTION,
      slug: 'kttf',
      archivedAt: null,
      manualTopics: false,
    });
  }

  /** Транзакция отдаёт свой клиент: видно, что запись версий — внутри неё. */
  function separateTx() {
    const tx = {
      ...prisma,
      forumTopicTranslation: {
        ...prisma.forumTopicTranslation,
        upsert: vi.fn(),
        deleteMany: vi.fn(),
      },
    };

    prisma.$transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    );

    return tx;
  }

  it('тема создаётся вместе с версиями и их фото — в одной транзакции, по порядку', async () => {
    asAdmin();
    newsSection();
    const tx = separateTx();

    const response = await call('POST', '/forum/topics', {
      auth: true,
      body: { ...news, translations: [kk, en] },
    });

    expect(response.status).toBe(201);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.forumTopicTranslation.upsert).not.toHaveBeenCalled();
    expect(
      tx.forumTopicTranslation.upsert.mock.calls.map((args: unknown[]) => args[0]),
    ).toMatchObject([
      {
        where: { topicId_locale: { topicId: TOPIC_ID, locale: 'kk' } },
        create: {
          topicId: TOPIC_ID,
          locale: 'kk',
          title: 'KTTF ашылды',
          images: [photo(1), photo(2)],
          position: 0,
          updatedById: USER_ID,
        },
      },
      { create: { locale: 'en', images: [photo(3)], position: 1 } },
    ]);
    expect(prisma.forumTopic.create.mock.calls[0]?.[0]).toMatchObject({ data: { locale: 'ru' } });
    expect(prisma.forumPost.create.mock.calls[0]?.[0]).toMatchObject({
      data: { images: [photo(4), photo(5)] },
    });
  });

  it('версия не записалась — ошибка всего запроса, тема не отдаётся', async () => {
    asAdmin();
    newsSection();
    const tx = separateTx();
    tx.forumTopicTranslation.upsert.mockRejectedValue(new Error('db down'));

    const response = await call('POST', '/forum/topics', {
      auth: true,
      body: { ...news, translations: [kk] },
    });

    expect(response.status).toBe(500);
    expect(prisma.forumTopic.findUnique).not.toHaveBeenCalled();
  });

  it('не модератор — 403, тема не заводится', async () => {
    prisma.forumSection.findUnique.mockResolvedValue({
      id: POSTS_SECTION,
      slug: 'tennis',
      archivedAt: null,
      manualTopics: true,
    });

    expect(
      await call('POST', '/forum/topics', {
        auth: true,
        body: { ...news, sectionId: POSTS_SECTION, locale: undefined, translations: [kk] },
      }),
    ).toMatchObject(forbidden);
    expect(prisma.forumTopic.create).not.toHaveBeenCalled();
  });

  it('язык дважды, язык оригинала, язык вне списка, пятое фото, не новость — ошибка', async () => {
    asAdmin();
    newsSection();

    for (const translations of [
      [kk, kk],
      [{ ...en, locale: 'ru' }],
      [{ ...en, locale: 'de' }],
      [{ ...en, images: [1, 2, 3, 4, 5].map(photo) }],
      [{ ...en, title: '' }],
    ]) {
      expect(
        await call('POST', '/forum/topics', { auth: true, body: { ...news, translations } }),
      ).toMatchObject(invalid);
    }

    // Язык оригинала не прислан — русский: русская версия не годится.
    expect(
      await call('POST', '/forum/topics', {
        auth: true,
        body: { ...news, locale: undefined, translations: [{ ...en, locale: 'ru' }] },
      }),
    ).toMatchObject(invalid);

    prisma.forumSection.findUnique.mockResolvedValue({
      id: POSTS_SECTION,
      slug: 'tennis',
      archivedAt: null,
      manualTopics: true,
    });
    expect(
      await call('POST', '/forum/topics', {
        auth: true,
        body: { ...news, sectionId: POSTS_SECTION, locale: undefined, translations: [kk] },
      }),
    ).toMatchObject(invalid);
    expect(prisma.forumTopic.create).not.toHaveBeenCalled();
  });

  it('правка первого сообщения заменяет весь набор версий и язык оригинала', async () => {
    asAdmin();
    const tx = separateTx();

    const response = await call('PATCH', `/forum/posts/${POST_ID}`, {
      auth: true,
      body: { body: 'Мәтін', locale: 'kk', translations: [en, { ...kk, locale: 'ru' }] },
    });

    expect(response.status).toBe(200);
    expect(tx.forumTopicTranslation.deleteMany).toHaveBeenCalledWith({
      where: { topicId: TOPIC_ID, locale: { notIn: ['en', 'ru'] } },
    });
    expect(
      tx.forumTopicTranslation.upsert.mock.calls.map((args: unknown[]) => args[0]),
    ).toMatchObject([
      { create: { locale: 'en', position: 0 }, update: { images: [photo(3)], position: 0 } },
      { create: { locale: 'ru', position: 1 }, update: { title: 'KTTF ашылды', position: 1 } },
    ]);
    expect(prisma.forumTopic.update).toHaveBeenCalledWith({
      where: { id: TOPIC_ID },
      data: { locale: 'kk' },
    });
    expect(prisma.forumPost.update.mock.calls[0]?.[0]).toMatchObject({ data: { body: 'Мәтін' } });
  });

  it('пустой набор убирает все версии; без поля версии не трогаются', async () => {
    asAdmin();

    await call('PATCH', `/forum/posts/${POST_ID}`, {
      auth: true,
      body: { body: 'Текст', translations: [] },
    });

    expect(prisma.forumTopicTranslation.deleteMany).toHaveBeenCalledWith({
      where: { topicId: TOPIC_ID, locale: { notIn: [] } },
    });

    prisma.forumTopicTranslation.deleteMany.mockClear();
    await call('PATCH', `/forum/posts/${POST_ID}`, { auth: true, body: { body: 'Текст' } });

    expect(prisma.forumTopicTranslation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.forumTopicTranslation.upsert).not.toHaveBeenCalled();
  });

  it('в правке: версия на языке оригинала темы, ответ, не новость — ошибка поля', async () => {
    asAdmin();

    // Язык оригинала не прислан — сервер берёт язык темы (ru).
    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', translations: [{ ...en, locale: 'ru' }] },
      }),
    ).toMatchObject(invalid);

    // Новый язык оригинала совпал с существующей версией, набор не прислан.
    prisma.forumTopicTranslation.findUnique.mockResolvedValue({ locale: 'kk' });
    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', locale: 'kk' },
      }),
    ).toMatchObject(invalid);

    prisma.forumPost.findUnique.mockResolvedValue(postRow({ number: 2 }));
    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', translations: [en] },
      }),
    ).toMatchObject(invalid);

    prisma.forumPost.findUnique.mockResolvedValue(
      postRow({
        topic: topicRow({
          locale: null,
          section: { id: POSTS_SECTION, slug: 'tennis', title: 'Теннис' },
        }),
      }),
    );
    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', translations: [en] },
      }),
    ).toMatchObject(invalid);
    expect(prisma.forumTopicTranslation.upsert).not.toHaveBeenCalled();
    expect(prisma.forumPost.update).not.toHaveBeenCalled();
  });

  it('не модератор правит свою новость «от себя», но не её версии', async () => {
    prisma.forumPost.findUnique.mockResolvedValue(postRow({ authoredAs: 'SELF' }));

    expect(
      await call('PATCH', `/forum/posts/${POST_ID}`, {
        auth: true,
        body: { body: 'Текст', translations: [en] },
      }),
    ).toMatchObject(forbidden);
    expect(prisma.forumPost.update).not.toHaveBeenCalled();

    expect(
      (await call('PATCH', `/forum/posts/${POST_ID}`, { auth: true, body: { body: 'Текст' } }))
        .status,
    ).toBe(200);
  });
});
