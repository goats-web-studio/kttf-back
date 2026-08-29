/**
 * Обновление @kttf/shared на заданный коммит.
 *
 * Нужны две согласованные правки: сама зависимость и разрешение на сборочные
 * скрипты, ключ которого содержит тот же SHA. Руками их рассинхронизировать
 * слишком легко, а результат — непонятная ошибка установки.
 *
 * Использование: node scripts/bump-shared.mjs <полный SHA>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('Нужен полный SHA (40 символов). Ветка недопустима: приложения обязаны');
  console.error('ссылаться на один и тот же коммит, иначе разъедутся версии движка (ADR-001).');
  process.exit(1);
}

const REPO = 'goats-web-studio/kttf-shared';
const TARBALL = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.dependencies['@kttf/shared'] = `github:${REPO}#${sha}`;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

writeFileSync('pnpm-workspace.yaml', `allowBuilds:\n  "@kttf/shared@${TARBALL}": true\n`);

console.log(`@kttf/shared обновлён на ${sha}`);
console.log('Дальше: pnpm install && node scripts/check-shared.mjs');
console.log('И тот же SHA обязателен в kttf-front.');
