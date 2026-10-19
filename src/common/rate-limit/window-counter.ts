/**
 * Счётчик событий в окне — основа ограничений ТС 8.3 (ADR-056).
 *
 * Фиксированное окно на ключ: первое событие открывает окно, по его
 * истечении счёт начинается заново. Скользящее окно точнее на границе, но
 * для «не больше ста в минуту» разница в пару запросов ничего не меняет.
 *
 * Живёт в памяти экземпляра API: после перезапуска счёт начинается с нуля,
 * при нескольких экземплярах предел умножается на их число. Пока API один,
 * это дешевле клиента Redis; с горизонтальным масштабированием счётчик
 * переедет в Redis, а интерфейс останется.
 */
export interface WindowVerdict {
  readonly allowed: boolean;
  /** Через сколько миллисекунд окно закроется — для «попробуйте через N минут». */
  readonly retryAfterMs: number;
}

interface Window {
  count: number;
  readonly endsAt: number;
}

export class WindowCounter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Потолок ключей в памяти: дальше выбрасываются истёкшие, затем все. */
    private readonly maxKeys = 50_000,
  ) {}

  /** Не превышен ли предел — без учёта нового события. */
  check(key: string, now: number): WindowVerdict {
    const window = this.live(key, now);

    return window === undefined || window.count < this.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: window.endsAt - now };
  }

  /** Учесть событие и сказать, укладывается ли оно в предел. */
  hit(key: string, now: number): WindowVerdict {
    let window = this.live(key, now);

    if (window === undefined) {
      this.makeRoom(now);
      window = { count: 0, endsAt: now + this.windowMs };
      this.windows.set(key, window);
    }

    window.count += 1;

    return window.count <= this.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: window.endsAt - now };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private live(key: string, now: number): Window | undefined {
    const window = this.windows.get(key);

    if (window !== undefined && window.endsAt <= now) {
      this.windows.delete(key);

      return undefined;
    }

    return window;
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;

    for (const [key, window] of this.windows) {
      if (window.endsAt <= now) this.windows.delete(key);
    }

    // Все окна живые — значит, по сайту идёт поток с множества адресов.
    // Память процесса важнее точности: счёт начинается заново.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
