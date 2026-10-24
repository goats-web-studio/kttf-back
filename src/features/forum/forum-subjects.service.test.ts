import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../infra/prisma/prisma.service.js';
import { ForumSubjectsService, duelSubject } from './forum-subjects.service.js';

/** Предмет темы «дуэль» — ADR-068: обсуждение со страницы дуэли. */

const DUEL_ID = '10000000-0000-4000-8000-000000000001';
const author = { lastName: 'Петров' };
const opponent = { lastName: 'Аманбаев' };

describe('подпись дуэли', () => {
  it('пара — по фамилиям, вид — словом', () => {
    expect(duelSubject({ id: DUEL_ID, kind: 'DUEL', author, opponent })).toEqual({
      type: 'DUEL',
      id: DUEL_ID,
      name: 'Дуэль: Петров — Аманбаев',
      slug: null,
      owner: null,
      news: null,
    });
    expect(duelSubject({ id: DUEL_ID, kind: 'SPARRING', author, opponent }).name).toBe(
      'Спарринг: Петров — Аманбаев',
    );
  });

  it('публикация без соперника', () => {
    expect(duelSubject({ id: DUEL_ID, kind: 'DUEL', author, opponent: null }).name).toBe(
      'Дуэль: Петров ищет соперника',
    );
  });
});

describe('предмет DUEL', () => {
  function makeService(row: unknown) {
    const prisma = {
      duel: {
        findUnique: vi.fn(() => Promise.resolve(row)),
        findMany: vi.fn(() => Promise.resolve(row === null ? [] : [row])),
      },
    };

    return { prisma, service: new ForumSubjectsService(prisma as unknown as PrismaService) };
  }

  it('дуэль есть — предмет есть: её страница открыта всем', async () => {
    const { service } = makeService({ id: DUEL_ID, kind: 'DUEL', author, opponent });

    expect(await service.findPublic('DUEL', DUEL_ID)).toMatchObject({
      name: 'Дуэль: Петров — Аманбаев',
    });
  });

  it('нет дуэли — нет предмета', async () => {
    const { service } = makeService(null);

    expect(await service.findPublic('DUEL', DUEL_ID)).toBeNull();
  });

  it('подписи для списка тем — одним запросом', async () => {
    const { service, prisma } = makeService({ id: DUEL_ID, kind: 'DUEL', author, opponent });

    const subjects = await service.describe([{ subjectType: 'DUEL', subjectId: DUEL_ID }]);

    expect(prisma.duel.findMany).toHaveBeenCalledTimes(1);
    expect([...subjects.values()].map((subject) => subject.name)).toEqual([
      'Дуэль: Петров — Аманбаев',
    ]);
  });
});
