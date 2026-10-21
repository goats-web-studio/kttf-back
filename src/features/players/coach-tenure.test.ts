import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '../../generated/prisma/client.js';
import { followProfileCoach, switchCoach } from './coach-tenure.js';

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

describe('тренер в записях на турниры идёт за анкетой (ADR-059, T3)', () => {
  it('только до старта и только не поправленный руками', async () => {
    const registration = { updateMany: vi.fn() };

    await followProfileCoach({ registration } as unknown as Prisma.TransactionClient, 'player-1', {
      coachPlayerId: 'coach-b',
      coachName: null,
    });

    expect(registration.updateMany).toHaveBeenCalledWith({
      where: {
        playerId: 'player-1',
        coachManual: false,
        tournament: { status: { in: ['DRAFT', 'PUBLISHED', 'REG_OPEN', 'REG_CLOSED'] } },
      },
      data: { coachPlayerId: 'coach-b', coachName: null },
    });
  });
});

describe('миграция 20261026100000_registration_coach', () => {
  const sql = readFileSync(
    new URL(
      '../../../prisma/migrations/20261026100000_registration_coach/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const [started = '', unstarted = ''] = sql.split('UPDATE "Registration"').slice(1);

  it('ссылка на тренера стирается вместе с игроком, записи не удаляются', () => {
    expect(sql).toMatch(/"Registration_coachPlayerId_fkey"[\s\S]+ON DELETE SET NULL/);
    expect(sql).toMatch(/"coachManual" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('начатые турниры — тренер из истории на дату старта, поздний период первым', () => {
    expect(started).toMatch(/'RUNNING', 'FINISHED', 'RATED'/);
    expect(started).toMatch(/ct\."from" <= COALESCE\(t\."startedAt", t\."startsAt"\)/);
    expect(started).toMatch(/ct\."to" IS NULL OR ct\."to" > COALESCE/);
    expect(started).toMatch(/ORDER BY ct\."from" DESC\s+LIMIT 1/);
  });

  it('не начатые — тренер из анкеты как есть; отменённые не трогаются', () => {
    expect(unstarted).toMatch(/"coachName" = p\."coachName"/);
    expect(unstarted).toMatch(/'DRAFT', 'PUBLISHED', 'REG_OPEN', 'REG_CLOSED'/);
    expect(sql).not.toMatch(/'CANCELLED'/);
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
