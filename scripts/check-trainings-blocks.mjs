/**
 * Равенство страницы блоков «Тренировок» из базы и прежней сборки в памяти.
 *
 * `TrainingsService.list` считает страницу блоков в SQL (`trainings-sql.ts`),
 * повторяя `trainingsWhere` и порядок `groupTrainings`. Прежний способ —
 * все подходящие тренировки разом, `groupTrainings`, срез страницы — здесь
 * как образец. Для набора запросов (без фильтров, каждый фильтр, сочетания,
 * страницы по одному и по два блока) ответы сравниваются целиком.
 *
 * Только чтение. Базы для тестов в репозитории нет, поэтому это скрипт, а не
 * тест: vitest его не запускает.
 *
 * Использование: pnpm build && node --env-file=.env scripts/check-trainings-blocks.mjs [--as-is]
 */
import { existsSync } from 'node:fs';
import { URLSearchParams } from 'node:url';

import { listTrainingsSchema } from '@kttf/shared/types';

// Сервис и клиент — из сборки, как в set-admin: скрипт исполняется голым Node.
const DIST = new URL('../dist/', import.meta.url);

if (!existsSync(new URL('features/coaches/trainings-sql.js', DIST))) {
  console.error('Сначала pnpm build: скрипт сравнивает собранный сервис.');
  process.exit(1);
}

const { PrismaClient } = await import(new URL('generated/prisma/client.js', DIST).href);
const { PrismaPg } = await import('@prisma/adapter-pg');
const { TrainingsService, trainingsWhere } = await import(
  new URL('features/coaches/trainings.service.js', DIST).href
);
const { groupTrainings } = await import(new URL('features/coaches/training-rules.js', DIST).href);
const { trainingFields } = await import(new URL('features/coaches/training-view.js', DIST).href);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const service = new TrainingsService(prisma);

/**
 * Прежний `list`: все подходящие тренировки, блоки в памяти, срез страницы.
 * Без `--as-is` строки приходят по времени заведения: прежняя выборка шла
 * без порядка, и первое написание зала (и порядок равных строк) зависело от
 * того, как строки лежат в таблице. Новый способ закрепил правило
 * «написание — у заведённой раньше»; образец получает тот же порядок.
 * С `--as-is` — прежний код как был, буква в букву.
 */
const AS_IS = process.argv.includes('--as-is');

async function listInMemory(query) {
  const rows = await prisma.training.findMany({
    where: trainingsWhere(query),
    select: trainingFields,
    ...(AS_IS ? {} : { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  });
  const groups = groupTrainings(rows);
  const skip = (query.page - 1) * query.limit;

  return {
    items: groups.slice(skip, skip + query.limit),
    total: groups.length,
    page: query.page,
    limit: query.limit,
  };
}

/** Фильтры по данным самой базы: города, клубы — те, что есть у тренировок. */
async function filterMatrix() {
  const trainings = await prisma.training.findMany({
    select: {
      clubId: true,
      club: { select: { cityId: true } },
      coach: { select: { cityId: true } },
    },
  });
  const cities = [
    ...new Set(trainings.flatMap((t) => [t.club?.cityId, t.coach?.cityId]).filter(Boolean)),
  ];
  const clubs = [...new Set(trainings.map((t) => t.clubId).filter(Boolean))];

  return [
    {},
    { kind: 'GROUP' },
    { kind: 'INDIVIDUAL,KIDS_GROUP,CAMP' },
    { place: 'CLUB' },
    { place: 'VISIT,ONLINE' },
    { audience: 'AMATEURS' },
    { audience: 'KIDS,ATHLETES' },
    { age: '7' },
    { age: '9' },
    { age: '17' },
    { priceTo: '0' },
    { priceTo: '10000' },
    { priceTo: '20000' },
    { language: 'KK' },
    { language: 'RU' },
    { language: 'EN' },
    { day: '1' },
    { day: '2,4,6' },
    { time: 'MORNING' },
    { time: 'DAY,EVENING' },
    { day: '1,3', time: 'EVENING' },
    { day: '6,7', time: 'MORNING,DAY' },
    { open: 'true' },
    { open: 'false' },
    ...cities.map((cityId) => ({ cityId })),
    ...(cities.length > 1 ? [{ cityId: cities.slice(0, 2).join(',') }] : []),
    ...clubs.map((clubId) => ({ clubId })),
    ...clubs.slice(0, 2).map((clubId) => ({ clubId, language: 'RU', open: 'true' })),
    { place: 'CLUB', audience: 'KIDS,TEENS', age: '10', priceTo: '30000' },
    { kind: 'GROUP,KIDS_GROUP', language: 'KK', time: 'EVENING' },
    ...cities.slice(0, 3).map((cityId) => ({ cityId, place: 'CLUB', open: 'true' })),
  ];
}

let checked = 0;
let failed = 0;

async function compare(raw) {
  const query = listTrainingsSchema.parse(raw);
  const [actual, expected] = await Promise.all([service.list(query), listInMemory(query)]);
  const same = JSON.stringify(actual) === JSON.stringify(expected);

  checked += 1;
  if (!same) {
    failed += 1;
    console.log(`DIFF  ${new URLSearchParams(raw).toString()}`);
    console.log(`  база:   total=${actual.total} ${blocksOf(actual)}`);
    console.log(`  память: total=${expected.total} ${blocksOf(expected)}`);
  }

  return expected.total;
}

function blocksOf(page) {
  return page.items
    .map(
      (group) =>
        `${group.kind}:${group.club?.name ?? group.venue?.name ?? '-'}(${group.trainings.length})`,
    )
    .join(' | ');
}

try {
  for (const filters of await filterMatrix()) {
    const before = failed;
    const total = await compare({ ...filters, limit: '50' });

    // По одному блоку на страницу — каждая страница и одна за последней.
    for (let page = 1; page <= total + 1; page += 1) {
      await compare({ ...filters, limit: '1', page: String(page) });
    }

    for (const page of ['1', '2']) await compare({ ...filters, limit: '2', page });

    const mark = failed === before ? 'ok  ' : 'FAIL';

    console.log(
      `${mark}  total=${total}  ${new URLSearchParams(filters).toString() || '(без фильтров)'}`,
    );
  }

  console.log(`\nСравнено ответов: ${checked}, расхождений: ${failed}`);
} finally {
  await prisma.$disconnect();
}

process.exit(failed === 0 ? 0 : 1);
