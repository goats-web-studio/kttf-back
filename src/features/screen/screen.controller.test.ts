import type { ScreenView } from '@kttf/shared/types';
import type { MessageEvent } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenController } from './screen.controller.js';
import { ScreenEventsService } from './screen-events.service.js';
import type { ScreenService } from './screen.service.js';

/**
 * Поток второго экрана — ADR-025.
 *
 * Проверяется поведение канала, а не состав состояния: он покрыт в
 * `screen.service.test.ts`. Здесь важно другое — что стена показывает что-то
 * сразу и обновляется от изменений турнира, а не от таймера.
 */

const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000000';
const TOKEN = 'FDgV6mQ1xKq8yZ2pW7nR4tL0sB3cH5jE';

function viewAt(updatedAt: string): ScreenView {
  return { updatedAt } as unknown as ScreenView;
}

let events: ScreenEventsService;
let screen: { byToken: ReturnType<typeof vi.fn>; tournamentIdOf: ReturnType<typeof vi.fn> };
let controller: ScreenController;

beforeEach(() => {
  events = new ScreenEventsService();
  screen = {
    tournamentIdOf: vi.fn().mockResolvedValue(TOURNAMENT_ID),
    byToken: vi
      .fn()
      .mockResolvedValueOnce(viewAt('2026-09-02T10:00:00.000Z'))
      .mockResolvedValueOnce(viewAt('2026-09-02T10:20:00.000Z')),
  };
  controller = new ScreenController(screen as unknown as ScreenService, events);
});

/** Собирает события потока, пока он открыт. */
function listen(): { received: MessageEvent[]; stop: () => void } {
  const received: MessageEvent[] = [];
  const subscription = controller.stream(TOKEN).subscribe((event) => received.push(event));

  return {
    received,
    stop: () => {
      subscription.unsubscribe();
    },
  };
}

/** Микрозадачи промиса, на которых поток собирает первое состояние. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('поток состояния', () => {
  it('первое состояние уходит сразу при подключении', async () => {
    // Иначе экран остался бы пустым до ближайшего результата, а между
    // встречами в зале проходят минуты.
    const stream = listen();
    await settle();

    expect(stream.received).toHaveLength(1);
    expect(stream.received[0]?.type).toBe('state');
    expect((stream.received[0]?.data as ScreenView).updatedAt).toBe('2026-09-02T10:00:00.000Z');

    stream.stop();
  });

  it('изменение турнира даёт новое состояние', async () => {
    const stream = listen();
    await settle();

    events.changed(TOURNAMENT_ID);
    await settle();

    expect(stream.received).toHaveLength(2);
    expect((stream.received[1]?.data as ScreenView).updatedAt).toBe('2026-09-02T10:20:00.000Z');

    stream.stop();
  });

  it('чужой турнир поток не будит', async () => {
    const stream = listen();
    await settle();

    events.changed('другой турнир');
    await settle();

    expect(stream.received).toHaveLength(1);

    stream.stop();
  });

  it('отписка закрывает подписку на шину', async () => {
    const stream = listen();
    await settle();
    stream.stop();

    events.changed(TOURNAMENT_ID);
    await settle();

    // Экран в зале выключают, а турнир идёт дальше: незакрытая подписка
    // держала бы обращения к базе до конца жизни процесса.
    expect(screen.byToken).toHaveBeenCalledTimes(1);
  });
});
