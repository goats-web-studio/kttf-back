import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Клиент Prisma генерируется, покрывать его нечем и незачем.
      exclude: ['src/generated/**', 'src/main.ts'],
    },
  },
  // Vitest не выпускает метаданные декораторов, а внедрение зависимостей Nest
  // читает design:paramtypes. Без swc любой тест с Nest DI падает на сборке
  // модуля с невнятным «Nest can't resolve dependencies».
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
