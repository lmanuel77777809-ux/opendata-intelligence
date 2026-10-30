import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'connectors/*/test/**/*.test.ts',
            'apps/*/test/**/*.unit.test.ts',
            'integrations/*/test/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['apps/*/test/**/*.db.test.ts'],
          // Comparten una base de datos de pruebas: sin paralelismo entre ficheros.
          fileParallelism: false,
        },
      },
    ],
  },
});
