# Образ API KTTF.
#
# Три цели вместо одной:
#   build     — установка и компиляция, наружу не выкатывается
#   migrator  — CLI Prisma, применяет миграции разовым запуском
#   runtime   — то, что работает в проде: dist и прод-зависимости
#
# Миграции отделены от приложения намеренно (ADR-030): при двух копиях API
# схему обязана накатывать ровно одна, и отказ миграции должен быть виден
# отдельно от отказа приложения.

FROM node:24-alpine AS base
# pnpm берётся из поля packageManager, версия не дублируется здесь
RUN corepack enable
WORKDIR /app

# ---- Зависимости ----
#
# Сначала установка, потом схема (DEV-131). Слой node_modules зависит только
# от package.json, lock-файла и pnpm-workspace.yaml. Раньше схема копировалась
# до установки, и каждая новая миграция пересобирала весь слой зависимостей:
# сервер заново качал образ миграций минутами, а сама миграция шла секунды.
#
# Собственный postinstall проекта — `prisma generate` — на время установки
# снимается: ему нужна схема. Он запускается отдельным слоем ниже. Скрипты
# зависимостей при этом отрабатывают: общий код собирает `dist` (ADR-010),
# и с `--ignore-scripts` пакет приехал бы пустым.

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm pkg delete scripts.postinstall \
  && pnpm install --frozen-lockfile
# tsconfig нужен именно здесь: генератор Prisma смотрит в него, выбирая
# расширение в импортах клиента. Без него получается `./enums.ts`, и Node
# такой импорт не разрешает.
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
# Заглушка строки подключения: `prisma generate` читает её из конфигурации,
# хотя к базе не обращается. Именно ARG, а не ENV — в образе она не остаётся,
# и настоящая строка приходит из окружения, а не из слоя.
ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN pnpm exec prisma generate

# ---- Сборка ----

FROM deps AS build
COPY src ./src
RUN pnpm build

# ---- Миграции ----
#
# Запускается разово и завершается. Нужен полный набор зависимостей: CLI
# Prisma лежит в devDependencies, в рантайм-образ он не попадает.

FROM deps AS migrator
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---- Прод-зависимости ----
#
# Установка с нуля, а не `pnpm prune` поверх собранной: prune убирает пакеты
# только из верхнего уровня, а виртуальное хранилище `.pnpm` оставляет как
# было — TypeScript, Vitest и студия Prisma уезжали в образ целиком.
#
# Скрипты зависимостей при этом обязаны отработать: общий код собирает `dist`
# при установке (ADR-010), и с `--ignore-scripts` пакет приехал бы пустым.
# Отключается ровно один скрипт — собственный postinstall проекта: он
# генерирует клиент Prisma, а тот уже скомпилирован в `dist`, и CLI для него
# в прод-зависимостях нет.

FROM base AS prodeps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm pkg delete scripts.postinstall \
  && pnpm install --prod --frozen-lockfile

# ---- Рантайм ----

FROM base AS runtime

# NODE_ENV здесь не задаётся: его выбирает окружение, а не образ. При
# `production` приложение откажется стартовать без провайдера SMS — так
# и задумано, ADR-013.

COPY --from=prodeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Приложение не пишет на диск и не нуждается в root: образ базовый node
# заводит пользователя `node` заранее.
USER node

EXPOSE 3000
CMD ["node", "dist/main.js"]
