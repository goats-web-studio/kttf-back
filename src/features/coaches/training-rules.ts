import type { TrainingGroupView, TrainingLink, TrainingVenue } from '@kttf/shared/types';

import { toClubRef, toTrainingView, type TrainingRecord } from './training-view.js';

/** Сохранённая связь строки: с кем (клуб или тренер), статус и когда он менялся. */
export interface StoredLink {
  readonly partner: string | null;
  readonly link: TrainingLink;
  readonly linkAt: Date | null;
}

/**
 * Связь после правки списка. Без второй стороны — связи нет. Та же
 * вторая сторона — связь как была, включая отказ: отправив список заново,
 * автор не переспросит того, кто уже ответил. Другая — снова ждёт ответа.
 */
export function keptLink(
  previous: StoredLink | undefined,
  partner: string | null,
): { link: TrainingLink; linkAt: Date | null } {
  if (partner === null) return { link: 'NONE', linkAt: null };

  if (previous?.partner === partner) return { link: previous.link, linkAt: previous.linkAt };

  return { link: 'PENDING', linkAt: null };
}

/** Зал вне KTTF — один и тот же при разнице в регистре и пробелах по краям. */
export function venueKey(name: string, address: string): string {
  return `${name.trim().toLowerCase()}\n${address.trim().toLowerCase()}`;
}

function byOrder(a: TrainingRecord, b: TrainingRecord): number {
  return a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Блоки раздела «Тренировки» — решение владельца от 20.10.2026: клуб KTTF
 * (свои тренировки клуба и подтверждённые тренерские), зал вне KTTF, затем
 * «выезд и онлайн» одним блоком последним.
 *
 * Клубы — по свежести страницы клуба, затем по названию; залы — по
 * названию. Внутри блока — порядок строк, затем время заведения.
 * Тренировки приходят уже отфильтрованными и публичными.
 */
export function groupTrainings(trainings: readonly TrainingRecord[]): TrainingGroupView[] {
  const clubs = new Map<string, TrainingRecord[]>();
  // Зал — по первому написанию: так его назвал тот, кто завёл раньше.
  const venues = new Map<string, { venue: TrainingVenue; rows: TrainingRecord[] }>();
  const anywhere: TrainingRecord[] = [];

  for (const training of trainings) {
    if (training.clubId !== null) {
      clubs.set(training.clubId, [...(clubs.get(training.clubId) ?? []), training]);
    } else if (training.venueName !== null && training.venueAddress !== null) {
      const key = venueKey(training.venueName, training.venueAddress);
      const group = venues.get(key) ?? {
        venue: { name: training.venueName, address: training.venueAddress },
        rows: [],
      };

      group.rows.push(training);
      venues.set(key, group);
    } else {
      anywhere.push(training);
    }
  }

  const clubGroups = [...clubs.values()]
    .flatMap((rows) => {
      const club = rows[0]?.club;

      return club === null || club === undefined ? [] : [{ club, rows }];
    })
    .sort((a, b) => {
      const aAt = a.club.profileReviewedAt?.getTime() ?? null;
      const bAt = b.club.profileReviewedAt?.getTime() ?? null;

      if (aAt !== bAt) {
        if (aAt === null) return 1;
        if (bAt === null) return -1;

        return bAt - aAt;
      }

      return a.club.name.localeCompare(b.club.name, 'ru');
    })
    .map(({ club, rows }): TrainingGroupView => ({
      kind: 'CLUB',
      club: toClubRef(club),
      venue: null,
      trainings: rows.sort(byOrder).map((training) => toTrainingView(training, false)),
    }));

  const venueGroups = [...venues.values()]
    .sort(
      (a, b) =>
        a.venue.name.localeCompare(b.venue.name, 'ru') ||
        a.venue.address.localeCompare(b.venue.address, 'ru'),
    )
    .map(({ venue, rows }): TrainingGroupView => ({
      kind: 'VENUE',
      club: null,
      venue,
      trainings: rows.sort(byOrder).map((training) => toTrainingView(training, false)),
    }));

  const anywhereGroup: TrainingGroupView[] =
    anywhere.length === 0
      ? []
      : [
          {
            kind: 'ANYWHERE',
            club: null,
            venue: null,
            trainings: anywhere.sort(byOrder).map((training) => toTrainingView(training, false)),
          },
        ];

  return [...clubGroups, ...venueGroups, ...anywhereGroup];
}
