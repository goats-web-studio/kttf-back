/**
 * Проверка связки с @kttf/shared.
 *
 * Общий код подключается git-зависимостью и собирается на стороне потребителя
 * скриптом prepare. Сломаться это может тихо: неверная карта exports, невыполненная
 * сборка, разрешение сборочных скриптов без нужного SHA. Проверка ловит такое сразу.
 */
import { calculateMatch, GAP_ZERO, K_BASE } from '@kttf/shared/rating';

const rated = { rating: 250, ratedMatches: 50 };
const common = { winnerSets: 3, loserSets: 0, level: 'REGIONAL', resultType: 'NORMAL' };

const equal = calculateMatch({ winner: rated, loser: rated, ...common });
const wide = calculateMatch({ winner: { rating: 400, ratedMatches: 50 }, loser: rated, ...common });

const checks = [
  ['константы читаются', K_BASE === 20 && GAP_ZERO === 100],
  ['равные соперники: система замкнута', equal.winnerDelta + equal.loserDelta === 0],
  ['равные соперники: дельта ненулевая', equal.winnerDelta > 0],
  ['разрыв 150: рейтинг не меняется', wide.winnerDelta === 0 && wide.loserDelta === 0],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
