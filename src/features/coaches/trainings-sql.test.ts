import { listTrainingsSchema } from '@kttf/shared/types';
import { describe, expect, it } from 'vitest';

import { trainingBlocksSql, trainingsFilterSql } from './trainings-sql.js';

const CITY = '66666666-6666-4666-8666-666666666666';
const CLUB_ID = '77777777-7777-4777-8777-777777777777';

const parse = (query: Record<string, string>) => listTrainingsSchema.parse(query);
const filter = (query: Record<string, string>) => trainingsFilterSql(parse(query));
/** Текст без лишних пробелов — сравнивать фрагменты, а не переносы строк. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('условие раздела в SQL — как trainingsWhere', () => {
  it('без фильтров — только правило публичности', () => {
    const sql = filter({});

    expect(sql.values).toEqual([]);
    expect(flat(sql.text)).toContain(
      `(t."author" = 'COACH' AND co."id" IS NOT NULL AND co."status" = 'APPROVED' AND co."hiddenAt" IS NULL AND t."clubId" IS NULL)`,
    );
    expect(flat(sql.text)).toContain(
      `t."link" = 'CONFIRMED' AND cl."id" IS NOT NULL AND cl."hiddenAt" IS NULL`,
    );
    expect(flat(sql.text)).toContain(
      `(t."author" = 'CLUB' AND cl."id" IS NOT NULL AND cl."hiddenAt" IS NULL)`,
    );
    expect(sql.text).not.toContain('TrainingSlot');
  });

  it('вид, место, клуб и «цена до» — параметрами', () => {
    const sql = filter({
      kind: 'GROUP,CAMP',
      place: 'CLUB',
      clubId: CLUB_ID,
      priceTo: '15000',
    });

    expect(flat(sql.text)).toContain('t."kind" = ANY($1::text[]::"TrainingKind"[])');
    expect(flat(sql.text)).toContain('t."place" = ANY($2::text[]::"TrainingPlace"[])');
    expect(flat(sql.text)).toContain('t."clubId" = $3');
    // Без цены — «по договорённости»: под «цену до» не подходит.
    expect(flat(sql.text)).toContain('t."priceKzt" IS NOT NULL AND t."priceKzt" <= $4');
    expect(sql.values).toEqual([['GROUP', 'CAMP'], ['CLUB'], CLUB_ID, 15_000]);
    expect(sql.text).not.toContain(CLUB_ID);
  });

  it('аудитория и возраст — оба условия, через AND', () => {
    const sql = filter({ audience: 'AMATEURS', age: '9' });

    expect(flat(sql.text)).toContain('t."audiences" && $1::text[]::"TrainingAudience"[]');
    expect(flat(sql.text)).toContain(
      't."audiences" && $2::text[]::"TrainingAudience"[] AND (t."kidsFromAge" IS NULL OR t."kidsFromAge" <= $3)',
    );
    expect(sql.values).toEqual([['AMATEURS'], ['KIDS', 'TEENS'], 9]);
  });

  it('город — клуба у клубных, страницы тренера у остальных', () => {
    const sql = filter({ cityId: CITY });

    expect(flat(sql.text)).toContain(
      '(t."clubId" IS NOT NULL AND cl."id" IS NOT NULL AND cl."cityId" = ANY($1::text[]))',
    );
    expect(flat(sql.text)).toContain(
      '(t."clubId" IS NULL AND co."id" IS NOT NULL AND co."cityId" = ANY($2::text[]))',
    );
    expect(sql.values).toEqual([[CITY], [CITY]]);
  });

  it('день и время — у одного и того же занятия, одним EXISTS', () => {
    const sql = filter({ day: '1,3', time: 'MORNING,EVENING' });

    expect(sql.text.match(/EXISTS/g)).toHaveLength(1);
    expect(flat(sql.text)).toContain(
      's."trainingId" = t."id" AND s."weekday" = ANY($1::int[]) AND ((s."startMin" >= $2 AND s."startMin" < $3) OR (s."startMin" >= $4 AND s."startMin" < $5))',
    );
    expect(sql.values).toEqual([[1, 3], 0, 720, 1020, 1440]);
  });

  it('только время — занятие в границах любого из значений', () => {
    const sql = filter({ time: 'DAY' });

    expect(flat(sql.text)).toContain(
      's."trainingId" = t."id" AND ((s."startMin" >= $1 AND s."startMin" < $2))',
    );
    expect(sql.values).toEqual([720, 1020]);
  });

  it('пустой список значений — ложь, как пустой OR у Prisma', () => {
    const sql = trainingsFilterSql({ ...parse({}), time: [] });

    expect(flat(sql.text)).toContain('s."trainingId" = t."id" AND FALSE');
  });

  it('идёт набор — есть места или мало мест; open=false — без условия', () => {
    expect(filter({ open: 'true' }).text).toContain(`t."enrollment" IN ('OPEN', 'FEW')`);
    expect(filter({ open: 'false' }).text).not.toContain('enrollment');
  });

  it('язык — тренера; у клубной — только подтверждённого и опубликованного', () => {
    const sql = filter({ language: 'KK' });

    expect(flat(sql.text)).toContain(
      `(t."author" = 'COACH' AND co."id" IS NOT NULL AND $1::"CoachLanguage" = ANY(co."languages"))`,
    );
    expect(flat(sql.text)).toContain(
      `(t."author" = 'CLUB' AND t."link" = 'CONFIRMED' AND co."id" IS NOT NULL AND co."status" = 'APPROVED' AND co."hiddenAt" IS NULL AND $2::"CoachLanguage" = ANY(co."languages"))`,
    );
    expect(sql.values).toEqual(['KK', 'KK']);
  });
});

describe('страница блоков в SQL', () => {
  it('блок — клуб, зал по ключу venueKey или «выезд и онлайн»', () => {
    const text = flat(trainingBlocksSql(parse({})).text);

    expect(text).toContain('WHEN t."clubId" IS NOT NULL THEN t."clubId"');
    expect(text).toContain(
      'lower(btrim(t."venueName", $1) COLLATE "und-x-icu") || chr(10) || lower(btrim(t."venueAddress", $2) COLLATE "und-x-icu")',
    );
    expect(text).toContain('GROUP BY m."rank", m."key"');
    // Первое написание зала — у самой ранней тренировки.
    expect(text).toContain('(array_agg(m."venueName" ORDER BY m."createdAt", m."id"))[1]');
  });

  it('ключ зала срезает те же пробельные символы, что String.prototype.trim', () => {
    const [whitespace = ''] = trainingBlocksSql(parse({})).values as string[];
    // Все символы, которые срезает trim, — по всей базовой плоскости Unicode.
    const trimmed = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter(
      (char) => char.trim() === '',
    );

    expect(whitespace.trim()).toBe('');
    expect(whitespace).toHaveLength(trimmed.length);
    for (const char of trimmed) expect(whitespace).toContain(char);
  });

  it('порядок: клубы по свежести и названию, залы по названию и адресу, ключ последним', () => {
    const text = flat(trainingBlocksSql(parse({})).text);

    expect(text).toContain(
      'b."rank", cl."profileReviewedAt" DESC NULLS LAST, coalesce(cl."name", b."venueName") COLLATE "ru-x-icu", b."venueAddress" COLLATE "ru-x-icu", b."key"',
    );
  });

  it('смещение и предел — параметрами; число блоков приходит и на пустой странице', () => {
    const sql = trainingBlocksSql(parse({ page: '3', limit: '20', clubId: CLUB_ID }));

    expect(sql.values.slice(-3)).toEqual([CLUB_ID, 40, 60]);
    expect(flat(sql.text)).toContain(
      'FROM (SELECT count(*)::int AS "total" FROM blocks) c LEFT JOIN ordered o ON o."position" > $4 AND o."position" <= $5',
    );
  });
});
