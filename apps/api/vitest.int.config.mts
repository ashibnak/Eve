import { defineConfig } from 'vitest/config';
import { inlineWorkspace, shared } from './vitest.shared.mjs';

/**
 * Integration tests against real PostgreSQL (start it with `pnpm db:dev:up`, or set
 * TEST_DATABASE_ADMIN_URL). One fresh database per run; files run one at a time.
 */
export default defineConfig({
  ...shared,
  test: {
    ...inlineWorkspace,
    name: '@eve/api:int',
    include: ['src/**/*.int.test.ts'],
    // Latency budgets run alone: vitest.perf.config.mts (`pnpm test:perf`).
    exclude: ['src/**/*.perf.int.test.ts'],
    root: import.meta.dirname,
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
