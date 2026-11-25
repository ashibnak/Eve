import { defineConfig } from 'vitest/config';
import { inlineWorkspace, shared } from './vitest.shared.mjs';

/**
 * Latency budgets (*.perf.int.test.ts), e.g. S5's "reads < 300 ms on 6,000 positions". They run
 * alone (`pnpm test:perf`), never next to other tests: a timing taken under load means nothing.
 */
export default defineConfig({
  ...shared,
  test: {
    ...inlineWorkspace,
    name: '@eve/api:perf',
    include: ['src/**/*.perf.int.test.ts'],
    root: import.meta.dirname,
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
