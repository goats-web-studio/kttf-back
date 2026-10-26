/**
 * Проверка связки с @kttf/shared.
 *
 * Общий код подключается git-зависимостью и собирается на стороне потребителя
 * скриптом prepare. Сломаться это может тихо: неверная карта exports, невыполненная
 * сборка, разрешение сборочных скриптов без нужного SHA. Проверка ловит такое сразу.
 *
 * Вход движка — формула RTTF (ADR-069): снимок игрока с числом турниров и
 * коэффициент турнира вместо уровня.
 */
import { calculateMatch, GAP_ZERO, projectDeltas } from '@kttf/shared/rating';

const rated = { rating: 250, ratedMatches: 50, ratedTournaments: 10 };
const common = { winnerSets: 3, loserSets: 0, tournamentFactor: 1, resultType: 'NORMAL' };

const equal = calculateMatch({ winner: rated, loser: rated, ...common });
const wide = calculateMatch({ winner: { ...rated, rating: 400 }, loser: rated, ...common });

const checks = [
  ['константы читаются', GAP_ZERO === 100],
  ['равные соперники: система замкнута', equal.winnerDelta + equal.loserDelta === 0],
  ['равные соперники: дельта ненулевая', equal.winnerDelta > 0],
  ['разрыв 150: рейтинг не меняется', wide.winnerDelta === 0 && wide.loserDelta === 0],
  ['прогноз дельты читается (ADR-077)', typeof projectDeltas === 'function'],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
