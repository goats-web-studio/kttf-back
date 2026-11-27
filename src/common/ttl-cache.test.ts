import { describe, expect, it, vi } from 'vitest';

import { TtlCache } from './ttl-cache.js';

/** Короткий кэш одинаковых расчётов — ADR-132. */

describe('короткий кэш', () => {
  it('в пределах срока отдаёт тот же расчёт, после срока считает заново', async () => {
    const cache = new TtlCache<number>(1000);
    const compute = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.get('k', compute, 0)).toBe(1);
    expect(await cache.get('k', compute, 999)).toBe(1);
    expect(await cache.get('k', compute, 1000)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('запросы, пришедшие во время расчёта, ждут его же', async () => {
    const cache = new TtlCache<number>(1000);
    let finish: (value: number) => void = () => undefined;
    const compute = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );

    const first = cache.get('k', compute, 0);
    const second = cache.get('k', compute, 1);
    finish(7);

    expect(await Promise.all([first, second])).toEqual([7, 7]);
    expect(compute).toHaveBeenCalledOnce();
  });

  it('неудача не запоминается: следующий запрос считает заново', async () => {
    const cache = new TtlCache<number>(1000);
    const compute = vi.fn().mockRejectedValueOnce(new Error('база')).mockResolvedValueOnce(3);

    await expect(cache.get('k', compute, 0)).rejects.toThrow('база');
    expect(await cache.get('k', compute, 1)).toBe(3);
  });

  it('clear сбрасывает сразу, ключи считаются отдельно', async () => {
    const cache = new TtlCache<string>(1000);
    const compute = vi.fn((value: string) => Promise.resolve(value));

    await cache.get('a', () => compute('a1'), 0);
    expect(await cache.get('b', () => compute('b1'), 0)).toBe('b1');
    cache.clear();
    expect(await cache.get('a', () => compute('a2'), 1)).toBe('a2');
  });

  it('потолок ключей: сверх него старые выбрасываются, кэш не растёт без меры', async () => {
    const cache = new TtlCache<number>(1000, 2);
    const compute = vi.fn().mockResolvedValue(1);

    await cache.get('a', compute, 0);
    await cache.get('b', compute, 0);
    await cache.get('c', compute, 0);
    await cache.get('a', compute, 0);

    // «c» вытеснил живые «a» и «b»: «a» посчитан заново.
    expect(compute).toHaveBeenCalledTimes(4);
  });
});
