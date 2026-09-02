import { Injectable } from '@nestjs/common';
import { filter, map, Observable, Subject } from 'rxjs';

/**
 * Шина изменений турнира для второго экрана — ADR-025.
 *
 * Живёт **в памяти процесса**, и это сознательное ограничение, а не упущение:
 * при нескольких экземплярах API экран, подключённый к одному, не увидит
 * событий другого. Пока экземпляр один, этого достаточно; при масштабировании
 * сюда придёт публикация через Redis, который в `kttf-infra` уже поднят.
 *
 * Событие несёт только идентификатор турнира. Состояние по нему собирается
 * заново: класть в шину готовый ответ значило бы держать две копии турнира —
 * в базе и в памяти — и следить, чтобы они не разошлись.
 */
@Injectable()
export class ScreenEventsService {
  private readonly changes = new Subject<string>();

  /**
   * Турнир изменился.
   *
   * Вызывается **после** транзакции, а не внутри: экран, разбуженный раньше
   * коммита, перечитает базу и увидит состояние до изменения.
   */
  changed(tournamentId: string): void {
    this.changes.next(tournamentId);
  }

  /** Поток изменений одного турнира. */
  of(tournamentId: string): Observable<void> {
    return this.changes.pipe(
      filter((id) => id === tournamentId),
      map(() => undefined),
    );
  }
}
