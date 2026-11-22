import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tools',
    include: ['**/*.test.ts'],
    exclude: ['**/__fixtures__/**', '**/node_modules/**'],
  },
});
