import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '../../generated/prisma/client.js';
import { switchCoach } from './coach-tenure.js';

const NOW = new Date('2026-10-21T10:00:00.000Z');

function makeTx() {
  return { coachTenure: { create: vi.fn(), updateMany: vi.fn() } };
}

let tx: ReturnType<typeof makeTx>;

beforeEach(() => {
  tx = makeTx();
});

const run = (previous: string | null, next: string | null) =>
  switchCoach(tx as unknown as Prisma.TransactionClient, 'player-1', previous, next, NOW);

describe('история тренера (ADR-059, T2)', () => {
  it('смена тренера закрывает прежний период и открывает новый', async () => {
    await run('coach-a', 'coach-b');

    expect(tx.coachTenure.updateMany).toHaveBeenCalledWith({
      where: { playerId: 'player-1', coachPlayerId: 'coach-a', to: null },
      data: { to: NOW },
    });
    expect(tx.coachTenure.create).toHaveBeenCalledWith({
      data: { playerId: 'player-1', coachPlayerId: 'coach-b', from: NOW },
    });
  });

  it('первый тренер — только открывается; тренер убран — только закрывается', async () => {
    await run(null, 'coach-a');

    expect(tx.coachTenure.updateMany).not.toHaveBeenCalled();
    expect(tx.coachTenure.create).toHaveBeenCalledOnce();

    tx = makeTx();
    await run('coach-a', null);

    expect(tx.coachTenure.updateMany).toHaveBeenCalledOnce();
    expect(tx.coachTenure.create).not.toHaveBeenCalled();
  });

  it('тот же тренер — период не рвётся', async () => {
    await run('coach-a', 'coach-a');
    await run(null, null);

    expect(tx.coachTenure.updateMany).not.toHaveBeenCalled();
    expect(tx.coachTenure.create).not.toHaveBeenCalled();
  });
});

describe('миграция переноса 20261023100000_coach_staff_students', () => {
  const sql = readFileSync(
    new URL(
      '../../../prisma/migrations/20261023100000_coach_staff_students/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it('текущий тренер из анкеты — открытым периодом с даты заведения профиля', () => {
    expect(sql).toMatch(
      /INSERT INTO "CoachTenure" \("playerId", "coachPlayerId", "from", "to"\)\s+SELECT "id", "coachPlayerId", "createdAt", NULL\s+FROM "Player"\s+WHERE "coachPlayerId" IS NOT NULL;/,
    );
  });

  it('пара клуб — тренер с подтверждённой тренировкой — в штабе ACTIVE, одной строкой', () => {
    expect(sql).toMatch(/INSERT INTO "ClubCoach"[\s\S]+'ACTIVE'[\s\S]+FROM "Training"/);
    expect(sql).toMatch(
      /WHERE "link" = 'CONFIRMED' AND "clubId" IS NOT NULL AND "coachId" IS NOT NULL/,
    );
    expect(sql).toMatch(/GROUP BY "clubId", "coachId";/);
  });

  it('перенос — после заведения таблиц', () => {
    expect(sql.indexOf('CREATE TABLE "CoachTenure"')).toBeLessThan(
      sql.indexOf('INSERT INTO "CoachTenure"'),
    );
    expect(sql.indexOf('CREATE TABLE "ClubCoach"')).toBeLessThan(
      sql.indexOf('INSERT INTO "ClubCoach"'),
    );
  });
});
