/**
 * Обновление @kttf/shared на заданный коммит.
 *
 * Делает всю последовательность целиком, потому что по частям она разъезжается:
 *
 * 1. Правит зависимость в package.json
 * 2. Правит разрешение сборочных скриптов — его ключ содержит тот же SHA
 * 3. Ставит зависимости — первый заход спотыкается о запрет сборки для
 *    предыдущего SHA, это ожидаемо
 * 4. Убирает заглушку, оставленную pnpm, и ставит заново — уже начисто
 * 5. Проверяет, что пакет импортируется и считает верно
 *
 * Использование: node scripts/bump-shared.mjs <полный SHA>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const REPO = 'goats-web-studio/kttf-shared';

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('Нужен полный SHA (40 символов).');
  console.error('Ветка недопустима: бэкенд и фронтенд обязаны ссылаться на один');
  console.error('и тот же коммит, иначе разъедутся версии движка рейтинга (ADR-001).');
  process.exit(1);
}

const ALLOW_FILE = 'pnpm-workspace.yaml';
const SHARED_KEY = /^\s*['"]?@kttf\/shared@/;

/**
 * Разрешение сборки для общего кода переписывается на месте, остальные ключи
 * файла сохраняются. Раньше файл перезаписывался целиком, и обновление SHA
 * молча сносило соседние разрешения — в kttf-back это prisma и esbuild, без
 * которых постинсталл не скачивает движки.
 */
function writeAllowBuilds() {
  const tarball = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;
  const entry = `  "@kttf/shared@${tarball}": true`;
  const source = existsSync(ALLOW_FILE) ? readFileSync(ALLOW_FILE, 'utf8') : 'allowBuilds:';

  // Строк общего кода после установки бывает несколько: pnpm дописывает
  // заглушку для предыдущего SHA. Первая заменяется, остальные выбрасываются.
  let replaced = false;
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    if (!SHARED_KEY.test(line)) {
      lines.push(line);
    } else if (!replaced) {
      lines.push(entry);
      replaced = true;
    }
  }

  if (!replaced) {
    const header = lines.findIndex((line) => line.trim() === 'allowBuilds:');
    if (header === -1) lines.unshift('allowBuilds:', entry);
    else lines.splice(header + 1, 0, entry);
  }

  writeFileSync(ALLOW_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}

function run(command) {
  return spawnSync(command, { stdio: 'inherit', shell: true }).status ?? 1;
}

function runOrExit(command) {
  const status = run(command);
  if (status !== 0) {
    console.error(`\nШаг «${command}» завершился с ошибкой.`);
    process.exit(status);
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.dependencies['@kttf/shared'] = `github:${REPO}#${sha}`;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
writeAllowBuilds();

// Первая установка почти всегда завершается с ERR_PNPM_IGNORED_BUILDS: pnpm
// помнит предыдущий SHA как пакет с запрещённой сборкой, дописывает для него
// строку-заглушку в pnpm-workspace.yaml и выходит с ошибкой. Уборка снимает
// причину, вторая установка обязана пройти чисто — и если первый отказ был не
// в этом, она отвалится тем же образом, только уже громко.
run('pnpm install');
writeAllowBuilds();
runOrExit('pnpm install');
// Вторая установка тоже успевает дописать заглушку, прежде чем забыть о
// предыдущем SHA. Уборка повторяется, иначе мусор уезжает в коммит.
writeAllowBuilds();

runOrExit('node scripts/check-shared.mjs');

console.log(`\n@kttf/shared обновлён на ${sha}`);
console.log('Тот же SHA обязателен в kttf-front — иначе сервер и офлайн-консоль');
console.log('будут считать по разным версиям движка.');
