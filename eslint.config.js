import preset from '@kttf/shared/config/eslint';
import tseslint from 'typescript-eslint';

export default [
  // Клиент Prisma генерируется постинсталлом. Это чужой код, править его
  // нельзя, а type-aware правила на нём считаются минутами.
  { ignores: ['dist/**', 'coverage/**', 'src/generated/**'] },

  ...preset(import.meta.dirname),

  {
    // Скрипты обновления общего кода — обычный Node без типов, в проект
    // TypeScript они не входят. Правила, которым нужны типы, здесь отключены,
    // остальные работают: неиспользуемая переменная и пустой catch ловятся и
    // без них. Так же поступает сам пресет со своим `eslint.config.js`.
    files: ['scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Глобальные объекты Node перечислены поимённо, чтобы не тянуть пакет
      // `globals` ради двух файлов. Понадобится третий — дописать сюда.
      globals: { console: 'readonly', process: 'readonly' },
      parserOptions: { projectService: false, project: false },
    },
  },

  {
    // Модуль Nest — это пустой класс с декоратором: вся полезная часть лежит
    // в метаданных. Правило справедливо для обычного кода, но здесь запрещает
    // ровно тот способ, которым фреймворк описывает состав приложения.
    files: ['src/**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
];
