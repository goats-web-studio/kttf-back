import type { TournamentStandingsView } from '@kttf/shared/types';

import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../infra/prisma/prisma.service.js';

import { withdrawnPlayers } from './finish.js';
import { buildStandings } from './standings.js';
import {
  registrationFields,
  stageFields,
  type RegistrationRecord,
  type StageRecord,
  type TournamentRecord,
} from './tournaments.select.js';

/**
 * Состояние турнира одним чтением — то, из чего собираются экран зала (ТС 7.7)
 * и снимок консоли (ТС 6.1).
 *
 * Вынесено, потому что обе проекции читают одно и то же: турнир, этапы,
 * участников и посчитанные движком таблицы. Третья копия этого запроса
 * означала бы, что снимок и стена расходятся при первом же новом поле.
 */
export interface TournamentState {
  readonly tournament: TournamentRecord;
  readonly stages: readonly StageRecord[];
  readonly registrations: readonly RegistrationRecord[];
  readonly standings: TournamentStandingsView;
}

export async function loadTournamentState(
  prisma: PrismaService,
  tournament: TournamentRecord,
): Promise<TournamentState> {
  const [stages, registrations] = await Promise.all([
    prisma.stage.findMany({
      where: { tournamentId: tournament.id },
      select: stageFields,
      orderBy: { order: 'asc' },
    }),
    prisma.registration.findMany({
      where: { tournamentId: tournament.id },
      select: registrationFields,
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return {
    tournament,
    stages,
    registrations,
    standings: buildStandings({
      tournamentId: tournament.id,
      stages,
      withdrawn: [...withdrawnPlayers(registrations)],
    }),
  };
}

/**
 * Версия турнира — ТС 6.3.
 *
 * Растёт на каждое изменение, которое видит консоль: жеребьёвка, старт, счёт,
 * назначение стола, отмена, решение по равенству, снятие участника,
 * завершение. Вызывается **внутри** той же транзакции, что и само изменение:
 * версия, выросшая отдельно, означала бы момент, когда снимок уже изменился,
 * а номер ещё нет.
 */
export async function bumpVersion(
  tx: Prisma.TransactionClient,
  tournamentId: string,
): Promise<void> {
  await tx.tournament.update({
    where: { id: tournamentId },
    data: { version: { increment: 1 } },
  });
}
