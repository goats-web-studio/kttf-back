import { describe, expect, it, vi } from 'vitest';

import type { HomeStatsService } from './home-stats.service.js';
import { StatsController } from './stats.controller.js';

/** Живые блоки главной под коротким кэшем — ADR-132. */

describe('живые блоки главной', () => {
  it('в пределах минуты считаются один раз, период — отдельный ключ', async () => {
    const home = {
      podiums: vi.fn().mockResolvedValue({ items: [] }),
      leaders: vi.fn().mockResolvedValue({ period: 'MONTH', tournaments: [], wins: [] }),
      upsets: vi.fn().mockResolvedValue({ period: 'MONTH', items: [] }),
    };
    const controller = new StatsController(home as unknown as HomeStatsService);

    await controller.podiums();
    await controller.podiums();
    await controller.leaders({ period: 'MONTH' });
    await controller.leaders({ period: 'MONTH' });
    await controller.leaders({ period: 'YEAR' });
    await controller.upsets({ period: 'WEEK' });
    await controller.upsets({ period: 'WEEK' });

    expect(home.podiums).toHaveBeenCalledOnce();
    expect(home.leaders).toHaveBeenCalledTimes(2);
    expect(home.leaders).toHaveBeenCalledWith('YEAR');
    expect(home.upsets).toHaveBeenCalledOnce();
  });
});
