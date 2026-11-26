import { defineConfig } from 'vitest/config';
import { inlineWorkspace, shared } from './vitest.shared.mjs';

/**
 * R1 acceptance (S10): the spec §11 checklist and the roadmap's R1 criteria, run end to end on
 * pilot-shaped companies (`pnpm acceptance`; ACCEPTANCE_DIR for the real anonymized files). Alone,
 * like the perf suite. Writes docs/acceptance/R1-acceptance-report.md.
 */
export default defineConfig({
  ...shared,
  test: {
    ...inlineWorkspace,
    name: '@eve/api:acceptance',
    include: ['acceptance/**/*.acceptance.test.ts'],
    root: import.meta.dirname,
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 1_800_000,
    hookTimeout: 600_000,
  },
});
