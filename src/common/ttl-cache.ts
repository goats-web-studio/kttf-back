/**
 * Короткий кэш одинаковых расчётов — ADR-132.
 *
 * Хранится обещание, а не готовое значение: запросы, пришедшие, пока расчёт
 * идёт, ждут его же, а не запускают свой (на главной в одну секунду их
 * десятки). Неудача не запоминается — следующий запрос посчитает заново,
 * иначе один сбой базы отдавался бы ошибкой весь срок.
 *
 * Живёт в памяти процесса: экземпляр API один (ADR-056). При втором каждый
 * держит свою копию, и расхождение между ними не дольше срока.
 */
export class TtlCache<T> {
  private readonly entries = new Map<
    string,
    { readonly value: Promise<T>; readonly until: number }
  >();

  constructor(
    private readonly ttlMs: number,
    /** Потолок ключей: при переполнении выбрасываются истёкшие, затем все. */
    private readonly maxKeys = 100,
  ) {}

  get(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit !== undefined && hit.until > now) return hit.value;

    const value = compute();

    value.catch(() => {
      // Удаляется только свой расчёт: за время его работы ключ мог получить новый.
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });

    if (!this.entries.has(key) && this.entries.size >= this.maxKeys) this.prune(now);
    this.entries.set(key, { value, until: now + this.ttlMs });

    return value;
  }

  /** Сбросить всё: данные изменились так, что ждать срока нельзя. */
  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.until <= now) this.entries.delete(key);
    }

    if (this.entries.size >= this.maxKeys) this.entries.clear();
  }
}
