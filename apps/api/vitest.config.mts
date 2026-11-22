import { defineConfig } from 'vitest/config';
import { inlineWorkspace, shared } from './vitest.shared.mjs';

/** Unit tests: no database. Integration tests (*.int.test.ts) live in vitest.int.config.mts. */
export default defineConfig({
  ...shared,
  test: {
    ...inlineWorkspace,
    name: '@eve/api',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    root: import.meta.dirname,
  },
});
