import { createHmac } from 'node:crypto';

/**
 * Окно, в котором повтор того же события с того же адреса не считается.
 *
 * Полчаса: человек, который перечитывает страницу или дважды нажал
 * «Позвонить», — это одно обращение, а не два.
 */
export const REPEAT_WINDOW_MS = 30 * 60 * 1000;

/** Сколько отметок держит память, прежде чем выбросить истёкшие. */
const SEEN_MAX = 50_000;

/**
 * Отсев повторов для счётчиков просмотров — страницы клуба (ADR-055) и
 * товара (ADR-058).
 *
 * Отметки живут в памяти экземпляра по HMAC от адреса — после перезапуска
 * API повтор посчитается ещё раз, и это дешевле, чем хранить отметки. Это
 * число для витрины, а не для расчётов: точность «плюс-минус один просмотр»
 * его устраивает.
 */
export class RepeatFilter {
  private readonly seen = new Map<string, number>();

  constructor(private readonly secret: string) {}

  /** Было ли то же событие с того же адреса за последние полчаса. Если нет — запоминает. */
  isRepeat(ip: string, event: string, now: Date): boolean {
    const key = `${this.hashIp(ip)}:${event}`;
    const last = this.seen.get(key);

    if (last !== undefined && now.getTime() - last < REPEAT_WINDOW_MS) return true;

    this.remember(key, now.getTime());

    return false;
  }

  private remember(key: string, at: number): void {
    if (this.seen.size >= SEEN_MAX) {
      for (const [stale, time] of this.seen) {
        if (at - time >= REPEAT_WINDOW_MS) this.seen.delete(stale);
      }
    }

    // Память забита свежими отметками — значит, по сайту идёт поток, и
    // точность повторов уступает памяти процесса.
    if (this.seen.size >= SEEN_MAX) this.seen.clear();

    this.seen.set(key, at);
  }

  /** HMAC, а не голый адрес: даже в памяти адрес — персональные данные (ADR-047). */
  private hashIp(ip: string): string {
    return createHmac('sha256', this.secret).update(ip).digest('base64url');
  }
}
