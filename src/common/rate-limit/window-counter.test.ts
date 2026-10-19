import { describe, expect, it } from 'vitest';

import { WindowCounter } from './window-counter.js';

describe('счётчик в окне', () => {
  it('пропускает предел и отказывает следующему, с временем до конца окна', () => {
    const counter = new WindowCounter(2, 60_000);

    expect(counter.hit('a', 0).allowed).toBe(true);
    expect(counter.hit('a', 1000).allowed).toBe(true);
    expect(counter.hit('a', 2000)).toEqual({ allowed: false, retryAfterMs: 58_000 });
  });

  it('новое окно — новый счёт; ключи независимы', () => {
    const counter = new WindowCounter(1, 60_000);

    counter.hit('a', 0);
    expect(counter.hit('b', 0).allowed).toBe(true);
    expect(counter.hit('a', 60_000).allowed).toBe(true);
  });

  it('проверка не считает событие, сброс обнуляет', () => {
    const counter = new WindowCounter(1, 60_000);

    expect(counter.check('a', 0).allowed).toBe(true);
    counter.hit('a', 0);
    expect(counter.check('a', 10)).toEqual({ allowed: false, retryAfterMs: 59_990 });
    counter.reset('a');
    expect(counter.check('a', 20).allowed).toBe(true);
  });

  it('переполненная память сначала теряет истёкшие окна, затем все', () => {
    const counter = new WindowCounter(1, 1000, 2);

    counter.hit('a', 0);
    counter.hit('b', 500);
    // «a» истекло — освобождает место, «b» живо и сохраняет счёт.
    counter.hit('c', 1200);
    expect(counter.check('b', 1300).allowed).toBe(false);

    // Оба живы и места нет — счёт начинается заново.
    counter.hit('d', 1300);
    expect(counter.check('b', 1300).allowed).toBe(true);
  });
});
