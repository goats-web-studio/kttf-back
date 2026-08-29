/**
 * Обновление @kttf/shared на заданный коммит.
 *
 * Делает всю последовательность целиком, потому что по частям она разъезжается:
 *
 * 1. Правит зависимость в package.json
 * 2. Правит разрешение сборочных скриптов — его ключ содержит тот же SHA
 * 3. Ставит зависимости
 * 4. Переписывает разрешение заново: pnpm при установке дописывает в файл
 *    строку-заглушку для предыдущего SHA, и без уборки они копятся
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

function writeAllowBuilds() {
  const tarball = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;
  writeFileSync('pnpm-workspace.yaml', `allowBuilds:\n  "@kttf/shared@${tarball}": true\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nШаг «${command} ${args.join(' ')}» завершился с ошибкой.`);
    process.exit(result.status ?? 1);
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.dependencies['@kttf/shared'] = `github:${REPO}#${sha}`;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
writeAllowBuilds();

run('pnpm install');

// Уборка после pnpm: заглушка для предыдущего SHA больше не нужна.
writeAllowBuilds();

run('node scripts/check-shared.mjs');

console.log(`\n@kttf/shared обновлён на ${sha}`);
console.log('Тот же SHA обязателен в kttf-front — иначе сервер и офлайн-консоль');
console.log('будут считать по разным версиям движка.');
